import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createJobQueue } from '../../app/src/queue/index.mjs';

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const backfill = { requestKey: 'bitrix24:deal-stage-history:100', dealId: 42,
  loseDate: '2026-10-31T23:59:59.999Z', triggerType: 'backfill', silent: true, screenshots: false };

test('общий ключ перехода сохраняет первое задание, cutoff и ручные повторы', { skip: !existsSync(pglitePath) }, async t => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE TABLE lost_deal_analyses (id bigint primary key)');
  await db.exec(readFileSync('supabase/migrations/20261105052525_lost_processing_jobs.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20261105065540_lost_bitrix_events.sql', 'utf8'));
  const queue = createJobQueue(db);
  await assert.rejects(queue.enqueue(backfill), /до включения/);
  await db.query('INSERT INTO lost_live_config (id, enabled_at) VALUES (true, $1)', ['2026-11-01T00:00:00Z']);
  for (const when of ['2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.001Z']) {
    await assert.rejects(queue.enqueue({ ...backfill, loseDate: when }), /до включения/);
  }
  await assert.rejects(queue.enqueue({ ...backfill, requestKey: 'manual:100' }), /ключ перехода/i);
  await assert.rejects(queue.enqueue({ ...backfill, triggerType: 'live', requestKey: 'manual:100' }), /ключ перехода/i);
  await assert.rejects(queue.enqueue({ ...backfill, triggerType: 'manual' }), /ключ перехода/i);
  await assert.rejects(queue.enqueue({ ...backfill, triggerType: 'batch', requestKey: 'bitrix24:deal-stage-history:bad' }), /ключ перехода/i);
  await assert.rejects(queue.enqueue({ ...backfill, loseDate: '2026-10-31T23:59:59.999500Z' }), /точность/i);
  const first = await queue.enqueue(backfill);
  assert.equal(first.created, true);
  const duplicate = await queue.enqueue({ ...backfill, triggerType: 'live', silent: false, screenshots: true });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.id, first.job.id);
  assert.equal(duplicate.job.trigger_type, 'backfill');
  assert.equal(duplicate.job.silent, true);
  assert.equal(duplicate.job.screenshots, false);
  await assert.rejects(queue.enqueue({ ...backfill, silent: false }), /другими параметрами/);
  await assert.rejects(queue.enqueue({ ...backfill, triggerType: 'live', dealId: 43 }), /другими параметрами/);
  await assert.rejects(queue.enqueue({ ...backfill, triggerType: 'live', loseDate: '2026-10-31T23:59:58Z' }), /другими параметрами/);
  await assert.rejects(queue.enqueue({ ...backfill, triggerType: 'manual' }), /ключ перехода/i);

  const live = { ...backfill, requestKey: 'bitrix24:deal-stage-history:101', triggerType: 'live', silent: false, screenshots: true };
  const liveFirst = await queue.enqueue(live);
  await assert.rejects(queue.enqueue({ ...live, triggerType: 'manual' }), /ключ перехода/i);
  const historicalDuplicate = await queue.enqueue({ ...backfill, requestKey: live.requestKey });
  assert.equal(historicalDuplicate.created, false);
  assert.equal(historicalDuplicate.job.id, liveFirst.job.id);
  assert.equal(historicalDuplicate.job.silent, false);
  assert.equal(historicalDuplicate.job.screenshots, true);
  const manual = await queue.enqueue({ ...live, requestKey: 'manual:repeat:100', triggerType: 'manual', silent: true });
  assert.equal(manual.created, true);
  assert.notEqual(manual.job.id, liveFirst.job.id);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_processing_jobs')).rows[0].n, 3);
});

test('микросекунды в cutoff или сохранённой дате не проходят проверку PostgreSQL', { skip: !existsSync(pglitePath) }, async t => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE TABLE lost_deal_analyses (id bigint primary key)');
  await db.exec(readFileSync('supabase/migrations/20261105052525_lost_processing_jobs.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20261105065540_lost_bitrix_events.sql', 'utf8'));
  await db.query("INSERT INTO lost_live_config (id,enabled_at) VALUES (true,'2026-11-01T00:00:00.000500Z')");
  const queue = createJobQueue(db);
  await assert.rejects(queue.enqueue({ ...backfill, loseDate: '2026-11-01T00:00:00.000Z' }), /до включения/);
  await db.query(`INSERT INTO lost_processing_jobs (id,request_key,deal_id,lose_date,trigger_type,silent,screenshots)
    VALUES ('00000000-0000-4000-8000-000000000222',$1,42,'2026-11-01T00:00:00.000500Z','live',false,true)`, [backfill.requestKey]);
  await assert.rejects(queue.enqueue({ ...backfill, triggerType: 'live', silent: false, screenshots: true,
    loseDate: '2026-11-01T00:00:00.000Z' }), /другими параметрами/);
});

test('конкурентное обнаружение одного перехода возвращает единственное задание', { skip: !existsSync(pglitePath) }, async t => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE TABLE lost_deal_analyses (id bigint primary key)');
  await db.exec(readFileSync('supabase/migrations/20261105052525_lost_processing_jobs.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20261105065540_lost_bitrix_events.sql', 'utf8'));
  await db.query("INSERT INTO lost_live_config (id, enabled_at) VALUES (true, '2026-11-01T00:00:00Z')");
  const queue = createJobQueue(db);
  const results = await Promise.all([
    queue.enqueue(backfill),
    queue.enqueue({ ...backfill, triggerType: 'live', silent: false, screenshots: true }),
  ]);
  assert.equal(results.filter(item => item.created).length, 1);
  assert.equal(results[0].job.id, results[1].job.id);
  const rows = (await db.query('SELECT id,trigger_type,silent,screenshots FROM lost_processing_jobs')).rows;
  assert.equal(rows.length, 1);
  const winner = results.find(item => item.created).job;
  assert.equal(rows[0].id, winner.id);
  assert.equal(rows[0].trigger_type, winner.trigger_type);
  assert.equal(rows[0].silent, winner.silent);
  assert.equal(rows[0].screenshots, winner.screenshots);
});
