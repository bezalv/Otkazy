import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createJobQueue } from '../../app/src/queue/index.mjs';

// Тест специально допускает только отдельный кластер в /tmp. Он создаёт в
// нём схему и роли, поэтому никогда не принимает URL или хост рабочей базы.
const root = process.env.OTKAZY_ISOLATED_PG_ROOT;
const database = process.env.OTKAZY_ISOLATED_PG_DB || 'otkazy_concurrency_test';
const enabled = typeof root === 'string' && /^\/tmp\/otkazy-isolated-[a-zA-Z0-9]{8}$/.test(root)
  && /^otkazy_concurrency_test(?:_[0-9]{1,8})?$/.test(database);

test('настоящий PostgreSQL: два независимых клиента согласуют live и backfill', { skip: !enabled }, async () => {
  const { default: pg } = await import('../../app/node_modules/pg/lib/index.js');
  const pool = new pg.Pool({ host: `${root}/sock`, port: 55527, user: 'postgres', database, max: 3 });
  try {
    const identity = await pool.query("SELECT current_database() AS db, current_setting('data_directory') AS dir, inet_server_addr() AS addr");
    assert.equal(identity.rows[0].db, database);
    assert.equal(identity.rows[0].dir, `${root}/pgdata`);
    assert.equal(identity.rows[0].addr, null);
    await pool.query(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE lost_deal_analyses (id bigint primary key)`);
    await pool.query(await readFile('db/proposals/worker-migration-fixtures/20261105052525_lost_processing_jobs.sql', 'utf8'));
    await pool.query(await readFile('db/proposals/worker-migration-fixtures/20261105065540_lost_bitrix_events.sql', 'utf8'));
    const precision = await pool.connect();
    try {
      await precision.query('BEGIN');
      await precision.query("INSERT INTO lost_live_config (id, enabled_at) VALUES (true, '2026-11-01T00:00:00.000500Z')");
      await assert.rejects(createJobQueue(precision).enqueue({ requestKey: 'bitrix24:deal-stage-history:700', dealId: 70,
        loseDate: '2026-11-01T00:00:00.000Z', triggerType: 'backfill' }), /до включения/);
      await precision.query('ROLLBACK');
    } finally { precision.release(); }
    await pool.query("INSERT INTO lost_live_config (id, enabled_at) VALUES (true, '2026-11-01T00:00:00Z')");
    await pool.query(`INSERT INTO lost_processing_jobs (id,request_key,deal_id,lose_date,trigger_type,silent,screenshots)
      VALUES ('00000000-0000-4000-8000-000000000700','bitrix24:deal-stage-history:701',71,
        '2026-10-31T23:59:59.000500Z','live',false,true)`);
    await assert.rejects(createJobQueue(pool).enqueue({ requestKey: 'bitrix24:deal-stage-history:701', dealId: 71,
      loseDate: '2026-10-31T23:59:59.000Z', triggerType: 'backfill' }), /другими параметрами/);

    for (const [index, firstType, shouldCommit] of [[1, 'backfill', true], [2, 'live', true], [3, 'backfill', false]]) {
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await first.query('BEGIN');
        await second.query('BEGIN');
        const base = { requestKey: `bitrix24:deal-stage-history:${300 + index}`, dealId: 42 + index,
          loseDate: '2026-10-31T23:59:59.000Z' };
        const backfill = { ...base, triggerType: 'backfill', silent: true, screenshots: false };
        const live = { ...base, triggerType: 'live', silent: false, screenshots: true };
        const one = await createJobQueue(first).enqueue(firstType === 'backfill' ? backfill : live);
        const pending = createJobQueue(second).enqueue(firstType === 'backfill' ? live : backfill);
        pending.catch(() => {});
        const deadline = Date.now() + 5000;
        let waiting = false;
        while (Date.now() < deadline) {
          const state = await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [second.processID]);
          if (state.rows[0]?.wait_event_type === 'Lock') { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(waiting, true, 'второй клиент должен ждать блокировку уникального ключа');
        await first.query(shouldCommit ? 'COMMIT' : 'ROLLBACK');
        const two = await pending;
        await second.query('COMMIT');
        assert.equal(one.created, true);
        assert.equal(two.created, !shouldCommit);
        if (shouldCommit) {
          assert.equal(two.job.id, one.job.id);
          assert.equal(two.job.trigger_type, firstType);
          assert.equal(two.job.silent, firstType === 'backfill');
        } else assert.equal(two.job.trigger_type, 'live');
        const rows = await pool.query('SELECT id,trigger_type,silent,screenshots FROM lost_processing_jobs WHERE request_key=$1', [base.requestKey]);
        assert.equal(rows.rows.length, 1);
        assert.equal(rows.rows[0].id, two.job.id);
      } finally {
        await first.query('ROLLBACK').catch(() => {});
        await second.query('ROLLBACK').catch(() => {});
        first.release();
        second.release();
      }
    }
  } finally { await pool.end(); }
});
