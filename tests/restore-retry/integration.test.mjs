import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJobQueue } from '../../app/src/queue/index.mjs';
import { runNightlyCycle } from '../../app/src/retry/coordinator.mjs';
import { runJob } from '../../app/src/worker/run-job.mjs';

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
test('ночной план читает зависшие сделки и повторно не ставит их в очередь', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8'));
    await db.exec(readFileSync('supabase/migrations/20261105052525_lost_processing_jobs.sql', 'utf8'));
    await db.exec(`CREATE TABLE test_attention (active boolean NOT NULL);
      INSERT INTO test_attention VALUES (true);
      CREATE VIEW public.lost_pipeline_attention AS
      SELECT 42::integer AS deal_id, null::timestamptz AS lose_date, true AS retry_eligible, '2026-11-04'::timestamptz AS last_attempt_at
      FROM test_attention WHERE active`);
    const pool = { query: (q, values) => db.query(q, values), transaction: fn => db.transaction(fn) };
    const queue = createJobQueue(pool);
    let apiCalls = 0;
    const bitrix = { async request(method) {
      apiCalls++;
      return method === 'crm.deal.get' ? { result: { STAGE_ID: 'C23:LOSE' } }
        : { result: { items: [{ STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] } };
    } };
    const nowMs = Date.parse('2026-11-04T21:01:00Z');
    assert.equal((await runNightlyCycle({ pool, queue, bitrix, nowMs })).current.status, 'enqueued');
    assert.equal((await runNightlyCycle({ pool, queue, bitrix, nowMs })).current.status, 'enqueued');
    assert.equal(apiCalls, 2);
    const jobs = (await db.query('SELECT request_key,silent FROM public.lost_processing_jobs')).rows;
    assert.deepEqual(jobs, [{ request_key: 'nightly:2026-11-05:42', silent: true }]);
    // Другая задача уже устранила сбой, пока ночное задание ожидало в очереди.
    await db.query('UPDATE test_attention SET active=false');
    const job = await queue.claim();
    const result = await runJob({ job, queue, loadAudioWait: async () => assert.fail('повтор больше не нужен'),
      store: { async loadResumableResult() { return null; }, async persistResult() { assert.fail('запись не нужна'); } },
      process: async () => assert.fail('сделка уже исправлена') });
    assert.equal(result.status, 'obsolete');
    assert.equal((await db.query('SELECT status FROM public.lost_processing_jobs')).rows[0].status, 'done');
  } finally { await db.close(); }
});
