import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJobQueue } from '../../app/src/queue/index.mjs';
import { runNightlyCycle } from '../../app/src/retry/coordinator.mjs';

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const item = (day, id) => ({ requestKey: `nightly:${day}:${id}`, dealId: id,
  loseDate: '2026-11-04T00:00:00.000Z', triggerType: 'nightly', silent: true, screenshots: true });

async function database() {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  await db.exec(readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8'));
  await db.exec(readFileSync('db/proposals/worker-migration-fixtures/20261105052525_lost_processing_jobs.sql', 'utf8'));
  let clock = '2026-11-04T21:01:00Z';
  const pool = {
    query: (sql, values) => db.query(sql, values),
    transaction: fn => db.transaction(tx => fn({ query(sql, values) {
      if (sql.includes('SELECT clock_timestamp() AS instant')) {
        return tx.query(sql.replace('clock_timestamp()', '$1::timestamptz'), [clock]);
      }
      return tx.query(sql, values);
    } })),
  };
  return { db, pool, setClock: value => { clock = value; } };
}

const bitrix = { async request(method) {
  return method === 'crm.deal.get' ? { result: { STAGE_ID: 'C23:LOSE' } }
    : { result: { items: [{ STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] } };
} };

test('вчерашний и сегодняшний снимки расходуют общий бюджет с границей 04:00', { skip: !existsSync(pglitePath) }, async () => {
  const { db, pool, setClock } = await database();
  try {
    await db.exec(`CREATE VIEW public.lost_pipeline_attention AS
      SELECT n::integer AS deal_id, '2026-11-04'::timestamptz AS lose_date, true AS retry_eligible,
        '2026-11-04'::timestamptz AS last_attempt_at FROM generate_series(101,120) n`);
    const old = Array.from({ length: 20 }, (_, i) => item('2026-11-04', i + 1));
    await db.query(`INSERT INTO public.lost_nightly_retry_runs (run_date,actions,deferred)
      VALUES ('2026-11-04',$1::jsonb,'[]')`, [JSON.stringify(old)]);
    const queue = createJobQueue(pool);
    let nowMs = Date.parse('2026-11-04T21:01:00Z');
    const first = await runNightlyCycle({ pool, queue, bitrix, nowMs });
    assert.equal(first.resumed[0].status, 'enqueued');
    assert.equal(first.current.status, 'planned');
    assert.equal(first.current.budgetExhausted, true);
    assert.equal(first.current.actions.length, 20);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_processing_jobs')).rows[0].n, 20);
    const snapshot = JSON.stringify(first.current.actions);
    const repeat = await runNightlyCycle({ pool, queue, bitrix, nowMs });
    assert.equal(JSON.stringify(repeat.current.actions), snapshot);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_processing_jobs')).rows[0].n, 20);
    // 03:59:59 НСК — ещё предыдущее окно, даже после календарной полуночи.
    setClock('2026-11-05T20:59:59Z'); nowMs = Date.parse('2026-11-05T20:59:59Z');
    await runNightlyCycle({ pool, queue, bitrix, nowMs });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_processing_jobs')).rows[0].n, 20);
    setClock('2026-11-05T21:00:00Z'); nowMs = Date.parse('2026-11-05T21:00:00Z');
    const next = await runNightlyCycle({ pool, queue, bitrix, nowMs });
    assert.equal(next.resumed[0].status, 'enqueued');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_processing_jobs')).rows[0].n, 40);
    assert.equal((await db.query("SELECT status FROM public.lost_nightly_retry_runs WHERE run_date='2026-11-05'")).rows[0].status, 'enqueued');
  } finally { await db.close(); }
});

test('параллельные очереди разделяют 20 мест, повтор и manual не расходуют лимит', { skip: !existsSync(pglitePath) }, async () => {
  const { db, pool } = await database();
  try {
    const one = createJobQueue(pool), two = createJobQueue(pool);
    const outcomes = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      (i % 2 ? one : two).enqueueNightlyBudgeted(item('2026-11-05', i + 1))));
    assert.equal(outcomes.filter(result => result.created).length, 20);
    assert.equal(outcomes.filter(result => result.budgetExhausted).length, 20);
    const existing = outcomes.find(result => result.created).job;
    const id = Number(existing.deal_id);
    assert.equal((await one.enqueueNightlyBudgeted(item('2026-11-05', id))).created, false);
    assert.equal((await one.enqueue({ ...item('2026-11-05', 999), requestKey: 'manual:999', triggerType: 'manual' })).created, true);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM public.lost_processing_jobs WHERE trigger_type='nightly'")).rows[0].n, 20);
  } finally { await db.close(); }
});
