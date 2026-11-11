import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createLiveInbox, processLiveEvent } from '../../app/src/live/index.mjs';

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const config = { applicationToken: 'test-token', domain: 'portal.example', memberId: 'm1', liveEnabledAt: '2026-11-01T00:00:00Z' };
const form = new URLSearchParams({ event: 'ONCRMDEALUPDATE', 'data[FIELDS][ID]': '42',
  'auth[domain]': config.domain, 'auth[member_id]': config.memberId, 'auth[application_token]': config.applicationToken }).toString();
const stage = { async request(method) {
  return method === 'crm.deal.get' ? { result: { STAGE_ID: 'C23:LOSE' } }
    : { result: { items: [{ ID: '200', STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] } };
} };

test('входящая очередь и job в изолированном PostgreSQL', { skip: !existsSync(pglitePath) }, async t => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE TABLE lost_deal_analyses (id bigint primary key)');
  await db.exec(readFileSync('db/proposals/worker-migration-fixtures/20261105052525_lost_processing_jobs.sql', 'utf8'));
  await db.exec(readFileSync('db/proposals/worker-migration-fixtures/20261105065540_lost_bitrix_events.sql', 'utf8'));
  const query = (q, params) => typeof q === 'string' ? db.query(q, params) : db.query(q.text, q.values);
  const pool = { query, async connect() { return { query, release() {} }; } };
  const inbox = createLiveInbox(pool, config);

  await t.test('без сохранённого cutoff и при несовпадении приём и обработка блокируются', async () => {
    await assert.rejects(inbox.assertConfig(), /конфигурация/i);
    await assert.rejects(inbox.acceptForm(form), /конфигурация/i);
    await assert.rejects(inbox.claim(), /конфигурация/i);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM lost_bitrix_events')).rows[0].count, 0);
    await db.query('INSERT INTO lost_live_config (id,enabled_at) VALUES (true,$1)', [config.liveEnabledAt]);
    await inbox.assertConfig();
    const changed = createLiveInbox(pool, { ...config, liveEnabledAt: '2026-11-02T00:00:00Z' });
    for (const action of [() => changed.assertConfig(), () => changed.acceptForm(form), () => changed.claim(), () => changed.recoverExpired()]) {
      await assert.rejects(action(), error => /конфигурация/i.test(error.message) && !error.message.includes(config.applicationToken));
    }
    await assert.rejects(db.query("UPDATE lost_live_config SET enabled_at='2026-11-02T00:00:00Z'"), /immutable/);
    await assert.rejects(db.query('DELETE FROM lost_live_config'), /immutable/);
    await assert.rejects(db.query('TRUNCATE lost_live_config'), /immutable/);
  });

  await t.test('повторные события одной сделки сохраняются, но создают один job перехода', async () => {
    await inbox.acceptForm(form); await inbox.acceptForm(form);
    for (let i = 0; i < 2; i++) {
      const event = await inbox.claim();
      assert.deepEqual(await processLiveEvent({ inbox, event, bitrix: stage }), { status: 'queued' });
    }
    const events = (await db.query('SELECT status,outcome FROM lost_bitrix_events ORDER BY created_at')).rows;
    assert.deepEqual(events, [{ status: 'done', outcome: 'queued' }, { status: 'done', outcome: 'queued' }]);
    const jobs = (await db.query('SELECT request_key,deal_id,trigger_type,silent FROM lost_processing_jobs')).rows;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].request_key, 'bitrix24:deal-stage-history:200');
    assert.equal(Number(jobs[0].deal_id), 42);
    assert.equal(jobs[0].trigger_type, 'live');
    assert.equal(jobs[0].silent, false);
  });
  await t.test('живой дубликат ранее сохранённого backfill не меняет тихий режим и не создаёт второй job', async () => {
    // Имитируем запись, попавшую в БД в обход новой проверки cutoff. В
    // штатном API очередь запрещает backfill для дат после включения live.
    await db.query(`INSERT INTO lost_processing_jobs
      (id,request_key,deal_id,lose_date,trigger_type,silent,screenshots)
      VALUES ('00000000-0000-4000-8000-000000000101', $1, 42, $2, 'backfill', true, false)`,
    ['bitrix24:deal-stage-history:401', '2026-11-04T00:00:00Z']);
    await inbox.acceptForm(form);
    const event = await inbox.claim();
    const bitrix = { async request(method) { return method === 'crm.deal.get' ? { result: { STAGE_ID: 'C23:LOSE' } }
      : { result: { items: [{ ID: '401', STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] } }; } };
    assert.deepEqual(await processLiveEvent({ inbox, event, bitrix }), { status: 'queued' });
    const jobs = (await db.query('SELECT id,trigger_type,silent,screenshots FROM lost_processing_jobs WHERE request_key=$1',
      ['bitrix24:deal-stage-history:401'])).rows;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].trigger_type, 'backfill');
    assert.equal(jobs[0].silent, true);
    assert.equal(jobs[0].screenshots, false);
    assert.equal((await db.query('SELECT status FROM lost_bitrix_events WHERE id=$1', [event.id])).rows[0].status, 'done');
  });
  await t.test('сделка вне отказа завершает событие без job', async () => {
    const before = (await db.query('SELECT count(*)::int AS count FROM lost_processing_jobs')).rows[0].count;
    await inbox.acceptForm(form);
    const event = await inbox.claim();
    assert.deepEqual(await processLiveEvent({ inbox, event, bitrix: { async request() { return { result: { STAGE_ID: 'C23:NEW' } }; } } }), { status: 'ignored' });
    assert.equal((await db.query('SELECT outcome FROM lost_bitrix_events WHERE id=$1', [event.id])).rows[0].outcome, 'ignored');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM lost_processing_jobs')).rows[0].count, before);
  });
  await t.test('переход до включения пропускается, равный cutoff и задержанный после него принимаются', async () => {
    for (const [historyId, when, wanted] of [
      ['301', '2026-10-31T23:59:59.999Z', 'ignored'],
      ['302', '2026-11-01T00:00:00Z', 'queued'],
      ['303', '2026-11-02T00:00:00Z', 'queued'],
    ]) {
      await inbox.acceptForm(form);
      const event = await inbox.claim();
      const bitrix = { async request(method) { return method === 'crm.deal.get' ? { result: { STAGE_ID: 'C23:LOSE' } }
        : { result: { items: [{ ID: historyId, STAGE_ID: 'C23:LOSE', CREATED_TIME: when }] } }; } };
      assert.equal((await processLiveEvent({ inbox, event, bitrix })).status, wanted);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM lost_processing_jobs WHERE request_key=$1',
        [`bitrix24:deal-stage-history:${historyId}`])).rows[0].count, wanted === 'queued' ? 1 : 0);
    }
  });
  await t.test('ошибка Bitrix откладывает, а истёкшая аренда не создаёт job', async () => {
    await inbox.acceptForm(form);
    const event = await inbox.claim();
    assert.deepEqual(await processLiveEvent({ inbox, event, bitrix: { async request() { throw new Error('timeout'); } } }), { status: 'retry' });
    const row = (await db.query('SELECT status,available_at FROM lost_bitrix_events WHERE id=$1', [event.id])).rows[0];
    assert.equal(row.status, 'pending');
    assert.ok(new Date(row.available_at).getTime() > Date.now());
    await db.query("UPDATE lost_bitrix_events SET available_at=now() WHERE id=$1", [event.id]);
    const reclaimed = await inbox.claim();
    await db.query("UPDATE lost_bitrix_events SET lease_until=now()-interval '1 second' WHERE id=$1", [reclaimed.id]);
    await assert.rejects(inbox.finish(reclaimed.id, reclaimed.lease_token, { historyId: '201', loseDate: '2026-11-04T00:00:00Z' }), /аренда/i);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM lost_processing_jobs WHERE request_key LIKE '%201'")).rows[0].count, 0);
    assert.equal(await inbox.recoverExpired(), 1);
    assert.notEqual((await inbox.claim()).lease_token, reclaimed.lease_token);
  });
  await t.test('потерянный ответ COMMIT не порождает вторую задачу', async () => {
    await inbox.acceptForm(form);
    const event = await inbox.claim();
    let poison;
    const flaky = {
      query,
      async connect() {
        return { async query(q, params) { const result = await query(q, params); if (q === 'COMMIT') throw new Error('lost response'); return result; },
          release(error) { poison = error; } };
      },
    };
    const retryInbox = createLiveInbox(flaky, config);
    await assert.rejects(retryInbox.finish(event.id, event.lease_token, { historyId: '202', loseDate: '2026-11-04T00:00:00Z' }), /EVENT_COMMIT_OUTCOME_UNKNOWN/);
    assert.ok(poison);
    assert.equal((await db.query('SELECT status FROM lost_bitrix_events WHERE id=$1', [event.id])).rows[0].status, 'done');
    assert.equal((await db.query("SELECT count(*)::int AS count FROM lost_processing_jobs WHERE request_key LIKE '%202'")).rows[0].count, 1);
  });
});
