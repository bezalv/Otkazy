import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJobQueue } from '../../app/src/queue/index.mjs';
import { runNightlyCycle } from '../../app/src/retry/coordinator.mjs';

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const day = value => Date.parse(`${value}T21:05:00Z`); // 04:05 следующего дня в Новосибирске

test('отложенная двадцатка не блокирует другие сделки; лимит и снимок сохраняются', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8'));
    await db.exec(readFileSync('supabase/migrations/20261105052525_lost_processing_jobs.sql', 'utf8'));
    await db.exec(`CREATE TABLE test_attention (deal_id integer, lose_date timestamptz, retry_eligible boolean, last_attempt_at timestamptz);
      INSERT INTO test_attention SELECT n, '2026-11-01'::timestamptz, true, '2026-11-01'::timestamptz + n * interval '1 second' FROM generate_series(1, 21) n;
      CREATE VIEW public.lost_pipeline_attention AS SELECT * FROM test_attention;`);
    const pool = { query: (query, values) => db.query(query, values), transaction: fn => db.transaction(fn) };
    const queue = createJobQueue(pool);
    const seen = [];
    const bitrix = { async request(method, body) {
      if (method === 'crm.deal.get') {
        seen.push(body.id);
        return { result: { STAGE_ID: body.id === 21 ? 'C23:LOSE' : 'C23:NEW' } };
      }
      return { result: { items: [{ STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] } };
    } };
    const first = await runNightlyCycle({ pool, queue, bitrix, nowMs: day('2026-11-04') });
    assert.equal(first.current.actions.length, 0);
    assert.equal(first.current.deferred.length, 20);
    assert.deepEqual(seen, Array.from({ length: 20 }, (_, index) => index + 1));

    // Повтор в тот же день не перечитывает Битрикс и не расширяет snapshot.
    await runNightlyCycle({ pool, queue, bitrix, nowMs: day('2026-11-04') });
    assert.equal(seen.length, 20);

    const second = await runNightlyCycle({ pool, queue, bitrix, nowMs: day('2026-11-05') });
    assert.equal(seen[20], 21);
    assert.equal(seen.length, 40); // максимум 20 проверенных сделок в каждую ночь
    assert.deepEqual(second.current.actions.map(action => action.dealId), [21]);
    assert.equal(second.current.deferred.length, 19);
    const jobs = (await db.query('SELECT deal_id FROM public.lost_processing_jobs')).rows;
    assert.deepEqual(jobs, [{ deal_id: 21 }]);
  } finally { await db.close(); }
});

test('уже ожидающая задача не создаёт второй ночной прогон той же сделки', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8'));
    await db.exec(readFileSync('supabase/migrations/20261105052525_lost_processing_jobs.sql', 'utf8'));
    await db.exec(`CREATE VIEW public.lost_pipeline_attention AS
      SELECT 42::integer AS deal_id, '2026-11-04'::timestamptz AS lose_date, true AS retry_eligible, '2026-11-04'::timestamptz AS last_attempt_at`);
    const pool = { query: (query, values) => db.query(query, values), transaction: fn => db.transaction(fn) };
    const queue = createJobQueue(pool);
    await queue.enqueue({ requestKey: 'manual:test:42', dealId: 42, loseDate: '2026-11-04T00:00:00Z', triggerType: 'manual' });
    const result = await runNightlyCycle({ pool, queue, bitrix: { request() { assert.fail('уже ожидающая сделка не проверяется'); } }, nowMs: day('2026-11-04') });
    assert.deepEqual(result.current.actions, []);
    assert.deepEqual(result.current.deferred, []);
    assert.equal((await db.query('SELECT id FROM public.lost_processing_jobs')).rows.length, 1);
  } finally { await db.close(); }
});
test('невыполненный пункт старого снимка не блокирует уже поставленную сделку', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8'));
    await db.exec(readFileSync('supabase/migrations/20261105052525_lost_processing_jobs.sql', 'utf8'));
    await db.exec(`CREATE VIEW public.lost_pipeline_attention AS
      SELECT n::integer AS deal_id, '2026-11-04'::timestamptz AS lose_date, true AS retry_eligible,
        '2026-11-04'::timestamptz AS last_attempt_at FROM generate_series(42,43) n`);
    const pool = { query: (query, values) => db.query(query, values), transaction: fn => db.transaction(fn) };
    const queue = createJobQueue(pool);
    const oldAction = id => ({ requestKey: `nightly:2026-11-04:${id}`, dealId: id,
      loseDate: '2026-11-04T00:00:00Z', triggerType: 'nightly', silent: true, screenshots: true });
    await db.query(`INSERT INTO public.lost_nightly_retry_runs (run_date,actions,deferred)
      VALUES ('2026-11-04',$1::jsonb,'[]')`, [JSON.stringify([oldAction(42), oldAction(43)])]);
    await queue.enqueueNightlyBudgeted(oldAction(42));
    await db.query("UPDATE public.lost_processing_jobs SET status='done' WHERE deal_id=42");
    const { prepareRetryPlan } = await import('../../app/src/retry/schedule.mjs');
    const seen = [];
    const bitrix = { async request(method, body) {
      if (method === 'crm.deal.get') {
        seen.push(body.id);
        return { result: { STAGE_ID: 'C23:LOSE' } };
      }
      return { result: { items: [{ STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] } };
    } };
    const plan = await prepareRetryPlan({ pool, bitrix, mode: 'nightly', runKey: '2026-11-05', nowMs: day('2026-11-04') });
    assert.deepEqual(seen, [42]);
    assert.deepEqual(plan.actions.map(action => action.dealId), [42]);
  } finally { await db.close(); }
});
