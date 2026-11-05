import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createDelivery } from '../../app/src/delivery/index.mjs';
import { createJobQueue } from '../../app/src/queue/index.mjs';

const pglite = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const migration = readFileSync('supabase/migrations/20261105052525_lost_processing_jobs.sql', 'utf8');
const lease = '00000000-0000-4000-8000-000000000099';
const jobId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('состояния доставки после транзакции результата', { skip: !existsSync(pglite) }, async t => {
  const { PGlite } = await import(pathToFileURL(pglite).href);
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE lost_deals (deal_id bigint primary key, title text);
    CREATE TABLE lost_deal_analyses (id bigint primary key, deal_id bigint, ai_verdict text,
      ai_judge_json jsonb, pipeline_error text, prompt_version text);`);
  await db.exec(migration);
  const pool = { async connect() { return { query: (sql, args) => db.query(sql, args), release() {} }; } };
  async function add(n, { deal = n, verdict = 'неправомерен', closure = 'other', silent = false, state = 'pending' } = {}) {
    await db.query('INSERT INTO lost_deals VALUES ($1,$2) ON CONFLICT DO NOTHING', [deal, 'Тест']);
    await db.query(`INSERT INTO lost_processing_jobs
      (id,request_key,deal_id,lose_date,trigger_type,status,lease_token,lease_until,silent,comment_state)
      VALUES ($1,$2,$3,now(),'live','processing',$4,now()+interval '1 hour',$5,$6)`, [jobId(n), `job-${n}`, deal, lease, silent, state]);
    await db.query('INSERT INTO lost_deal_analyses (id,deal_id,ai_verdict,ai_judge_json,pipeline_operation_id) VALUES ($1,$2,$3,$4,$5)',
      [n, deal, verdict, JSON.stringify({ verdict, closure_reason_class: closure, verdict_reason_short: 'Причина', final_comment: 'Текст' }), jobId(n)]);
  }
  const row = async n => (await db.query(`SELECT status, comment_state, comment_id, notify_state FROM lost_processing_jobs WHERE id=$1`, [jobId(n)])).rows[0];
  const events = [];
  const client = { async request(method, body) { events.push({ method, body }); return { result: method === 'crm.timeline.comment.add' ? 77 : 98 }; } };
  const delivery = createDelivery(pool, client, { now: () => Date.parse('2026-11-05T00:00:00Z') });

  await t.test('комментарий и уведомления отправлены один раз', async () => {
    await add(1);
    assert.deepEqual(await delivery.deliver(jobId(1), lease), { state: 'done' });
    assert.deepEqual(await row(1), { status: 'done', comment_state: 'ok', comment_id: '77', notify_state: 'ok' });
    assert.deepEqual(events.map(e => e.method), ['crm.timeline.comment.add', 'im.notify.system.add', 'im.notify.system.add', 'im.notify.system.add']);
    const n = (await db.query('SELECT ai_judge_json->\'notification\' AS n FROM lost_deal_analyses WHERE id=1')).rows[0].n;
    assert.equal(n.status, 'ok'); assert.deepEqual(n.delivered, [65, 26175, 19601]);
    await assert.rejects(delivery.deliver(jobId(1), lease));
  });
  await t.test('тихий запуск ничего не отправляет', async () => {
    await add(2, { silent: true }); const before = events.length;
    assert.equal((await delivery.deliver(jobId(2), lease)).state, 'done');
    assert.equal(events.length, before); assert.equal((await row(2)).notify_state, 'skipped');
  });
  await t.test('после неоднозначного ответа комментарий не повторяется', async () => {
    await add(3); let attempts = 0;
    const d = createDelivery(pool, { async request() { attempts++; throw new Error('timeout'); } });
    assert.deepEqual(await d.deliver(jobId(3), lease), { state: 'unknown', action: 'comment' });
    await assert.rejects(d.deliver(jobId(3), lease), /аренда/);
    assert.equal(attempts, 1); assert.equal((await row(3)).comment_state, 'unknown');
    assert.equal((await row(3)).status, 'needs_review');
  });
  await t.test('потеря процесса после sending требует сверки', async () => {
    await add(4, { state: 'sending' }); const before = events.length;
    assert.equal((await delivery.deliver(jobId(4), lease)).state, 'unknown');
    assert.equal(events.length, before); assert.equal((await row(4)).comment_state, 'unknown');
  });
  await t.test('совпадающий прежний вердикт suppress повторных уведомлений', async () => {
    await add(5, { deal: 1 }); const before = events.length;
    assert.equal((await delivery.deliver(jobId(5), lease)).state, 'done');
    assert.deepEqual(events.slice(before).map(e => e.method), ['crm.timeline.comment.add']);
    assert.equal((await row(5)).notify_state, 'skipped');
  });
  await t.test('одна подтверждённая доставка достаточна, остальные не повторяются', async () => {
    await add(6); let sends = 0;
    const d = createDelivery(pool, { async request(method) { if (method === 'crm.timeline.comment.add') return { result: 10 }; sends++; if (sends > 1) throw new Error('timeout'); return { result: 10 }; } });
    assert.equal((await d.deliver(jobId(6), lease)).state, 'done');
    assert.equal(sends, 3); assert.equal((await row(6)).notify_state, 'ok');
  });
  await t.test('все неоднозначные уведомления не повторяются', async () => {
    await add(7); let sends = 0;
    const d = createDelivery(pool, { async request(method) { if (method === 'crm.timeline.comment.add') return { result: 10 }; sends++; throw new Error('timeout'); } });
    assert.equal((await d.deliver(jobId(7), lease)).state, 'unknown');
    await assert.rejects(d.deliver(jobId(7), lease), /аренда/);
    assert.equal(sends, 3);
    assert.equal((await row(7)).status, 'needs_review');
  });
  await t.test('утеряв аренду, обработчик не отправляет следующим получателям', async () => {
    await add(8); let sends = 0;
    const d = createDelivery(pool, { async request(method) {
      if (method === 'crm.timeline.comment.add') return { result: 10 };
      sends++;
      await db.query("UPDATE lost_processing_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [jobId(8)]);
      return { result: 10 };
    } });
    await assert.rejects(d.deliver(jobId(8), lease), /аренда/);
    assert.equal(sends, 1);
    assert.equal((await row(8)).notify_state, 'sending');
  });
  await t.test('потеря ответа COMMIT не запускает сетевой вызов', async () => {
    await add(9); let failCommit = true, sends = 0;
    let releasedWithError = false;
    const flaky = { async connect() { return { async query(sql, args) {
      const result = await db.query(sql, args);
      if (sql === 'COMMIT' && failCommit) { failCommit = false; throw new Error('потерян ответ'); }
      return result;
    }, release(error) { if (error) releasedWithError = true; } }; } };
    const d = createDelivery(flaky, { async request() { sends++; return { result: 10 }; } });
    await assert.rejects(d.deliver(jobId(9), lease), /DELIVERY_COMMIT_OUTCOME_UNKNOWN/);
    assert.equal(releasedWithError, true);
    assert.equal(sends, 0);
    assert.equal((await d.deliver(jobId(9), lease)).state, 'unknown');
    assert.equal(sends, 0);
  });
  await t.test('после первого подтверждения продолжает отправку тем, кому ещё не начинал', async () => {
    await add(10); let sends = 0, checks = 0;
    const flaky = { async connect() { return { async query(sql, args) {
      if (String(sql).includes("notify_state='sending'") && String(sql).includes('SELECT id FROM') && ++checks === 2) throw new Error('процесс остановился');
      return db.query(sql, args);
    }, release() {} }; } };
    const d = createDelivery(flaky, { async request(method) {
      if (method === 'crm.timeline.comment.add') return { result: 10 };
      sends++; return { result: 10 };
    } });
    await assert.rejects(d.deliver(jobId(10), lease), /остановился/);
    assert.equal(sends, 1);
    const saved = (await db.query("SELECT ai_judge_json->'notification' AS n FROM lost_deal_analyses WHERE id=10")).rows[0].n;
    assert.deepEqual(saved.delivered, [65]);
    assert.equal(saved.status, 'sending');
    assert.deepEqual(saved.recipient_states, { 65: 'ok', 26175: 'pending', 19601: 'pending' });
    assert.equal((await d.deliver(jobId(10), lease)).state, 'done');
    assert.equal(sends, 3);
    const after = (await db.query("SELECT ai_judge_json->'notification' AS n FROM lost_deal_analyses WHERE id=10")).rows[0].n;
    assert.equal(after.status, 'ok'); assert.deepEqual(after.delivered, [65, 26175, 19601]);
  });
  await t.test('ошибка отката исключает соединение из пула', async () => {
    let released;
    const flaky = { async connect() { return { async query(sql, args) {
      if (sql === 'ROLLBACK') { await db.query(sql, args); throw new Error('откат без подтверждения'); }
      return db.query(sql, args);
    }, release(error) { released = error; } }; } };
    const d = createDelivery(flaky, client);
    await assert.rejects(d.deliver(jobId(99), lease), /аренда/);
    assert.ok(released instanceof Error);
  });
  await t.test('неподтверждённый вызов не повторяется, прочие получатели обрабатываются', async () => {
    await add(11); let fail = false, sends = 0;
    const flaky = { async connect() { return { async query(sql, args) {
      if (fail && String(sql).includes('SELECT j.*')) { fail = false; throw new Error('БД недоступна'); }
      return db.query(sql, args);
    }, release() {} }; } };
    const d = createDelivery(flaky, { async request(method) {
      if (method === 'crm.timeline.comment.add') return { result: 10 };
      sends++; fail = true; return { result: 10 };
    } });
    await assert.rejects(d.deliver(jobId(11), lease), /БД недоступна/);
    assert.equal(sends, 1);
    const continued = createDelivery(pool, { async request(method) { assert.equal(method, 'im.notify.system.add'); sends++; return { result: 10 }; } });
    assert.equal((await continued.deliver(jobId(11), lease)).state, 'done');
    assert.equal((await row(11)).status, 'done');
    assert.equal(sends, 3);
    const notification = (await db.query("SELECT ai_judge_json->'notification' AS n FROM lost_deal_analyses WHERE id=11")).rows[0].n;
    assert.deepEqual(notification.delivered, [26175, 19601]);
    assert.equal(notification.recipient_states['65'], 'unknown');
    const queue = createJobQueue(db);
    await queue.recoverExpired();
    assert.equal((await row(7)).status, 'needs_review');
  });
});
