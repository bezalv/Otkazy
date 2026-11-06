import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveInbox, processLiveEvent, readCurrentTransition } from '../../app/src/live/index.mjs';

const token = 'test-only-application-token';
const expected = { applicationToken: token, domain: 'portal.example', memberId: 'member-1', liveEnabledAt: '2026-11-01T00:00:00Z' };
const form = (changes = {}) => {
  const values = { event: 'ONCRMDEALUPDATE', 'data[FIELDS][ID]': '42', 'auth[domain]': 'portal.example',
    'auth[member_id]': 'member-1', 'auth[application_token]': token, ...changes };
  return new URLSearchParams(values).toString();
};

test('проверка формы и секретов предшествует любому SQL', async () => {
  let count = 0;
  const inbox = createLiveInbox({ async query(sql) { count++; return { rows: sql.startsWith('SELECT enabled_at') ? [{ matches: true }] : [] }; }, connect() {} }, expected);
  for (const body of [form({ 'auth[application_token]': 'wrong' }), form({ 'auth[domain]': 'evil.example' }),
    form({ 'auth[member_id]': 'wrong' }), form() + '&auth%5Bapplication_token%5D=x', form({ 'data[FIELDS][ID]': '-1' }),
    form() + '%ZZ', Buffer.from([0xff]), 'x'.repeat(65537)]) {
    await assert.rejects(inbox.acceptForm(body));
  }
  assert.equal(count, 0);
  assert.deepEqual(await inbox.acceptForm(form({ event: 'OTHER_EVENT' })), { status: 'ignored' });
  assert.equal(count, 0);
  const accepted = await inbox.acceptForm(form());
  assert.equal(accepted.status, 'accepted');
  assert.equal(count, 2);
});

test('сбой INSERT не превращается в подтверждённое событие', async () => {
  const inbox = createLiveInbox({ async query(sql) { if (sql.startsWith('SELECT enabled_at')) return { rows: [{ matches: true }] }; throw new Error('COMMIT неизвестен'); }, connect() {} }, expected);
  await assert.rejects(inbox.acceptForm(form()));
});

test('отсутствие сохранённого cutoff блокирует обращение к Bitrix при обработке', async () => {
  const inbox = createLiveInbox({ async query() { return { rows: [] }; }, connect() {} }, expected);
  let apiCalls = 0;
  await assert.rejects(processLiveEvent({ inbox, event: { id: 'e', lease_token: 'l', deal_id: 42 },
    bitrix: { async request() { apiCalls++; } } }), /конфигурация/i);
  assert.equal(apiCalls, 0);
});

test('история возвращает ID конкретного последнего отказа', async () => {
  const client = { async request(method) {
    if (method === 'crm.deal.get') return { result: { STAGE_ID: 'C23:LOSE' } };
    return { result: { items: [{ ID: '123', STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T07:00:00+07:00' }] } };
  } };
  assert.deepEqual(await readCurrentTransition(client, 42), { historyId: '123', loseDate: '2026-11-04T00:00:00.000Z' });
  await assert.rejects(readCurrentTransition({ async request(method) {
    return method === 'crm.deal.get' ? { result: { STAGE_ID: 'C23:LOSE' } } : { result: { items: [] } };
  } }, 42), /история/i);
});

test('одинаковые даты, сбитый порядок и неполная история не назначают ID текущему отказу', async () => {
  const first = { ID: '123', STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T07:00:00+07:00' };
  const previous = { ID: '122', STAGE_ID: 'C23:NEW', CREATED_TIME: '2026-11-03T23:59:59Z' };
  const api = page => ({ async request(method) { return method === 'crm.deal.get'
    ? { result: { STAGE_ID: 'C23:LOSE' } } : page; } });
  assert.deepEqual(await readCurrentTransition(api({ result: { items: [first, previous] } }), 42),
    { historyId: '123', loseDate: '2026-11-04T00:00:00.000Z' });
  for (const page of [
    { result: { items: [{ ...first, CREATED_TIME: '2026-11-04T00:00:00.000700Z' }] } },
    { result: { items: [first, { ...previous, CREATED_TIME: '2026-11-03T23:59:59.999500Z' }] } },
    { result: { items: [first, { ...previous, CREATED_TIME: '2026-11-04T00:00:00Z' }] } },
    { result: { items: [first, { ...previous, CREATED_TIME: '2026-11-04T00:00:01Z' }] } },
    { result: { items: [first, { ...previous, CREATED_TIME: 'не дата' }] } },
    { result: { items: [first, { ...previous, ID: 'bad' }] } },
    { result: { items: [first] }, next: 1 },
    { result: { items: [first] }, total: 2 },
    { result: { items: [first, previous] }, total: 1 },
    { result: { items: [first, previous] }, next: 'incorrect' },
    { result: { items: [] } },
  ]) await assert.rejects(readCurrentTransition(api(page), 42));
  let retries = 0;
  const inbox = { async assertConfig() {}, async retry() { retries++; return true; }, async finish() { assert.fail('нельзя сохранять неоднозначный ID'); } };
  const bitrix = api({ result: { items: [first, { ...previous, CREATED_TIME: '2026-11-04T00:00:00Z' }] } });
  assert.deepEqual(await processLiveEvent({ inbox, bitrix, event: { id: 'e', lease_token: 'l', deal_id: 42 } }), { status: 'retry' });
  assert.equal(retries, 1);
});

test('карточка уже LOSE, но первая запись истории ещё NEW: событие остаётся на повтор', async () => {
  let retries = 0;
  const inbox = { async assertConfig() {}, async retry() { retries++; return true; }, async finish() { assert.fail('нельзя фиксировать старый LOSE'); } };
  const bitrix = { async request(method) {
    return method === 'crm.deal.get' ? { result: { STAGE_ID: 'C23:LOSE' } }
      : { result: { items: [{ ID: 12, STAGE_ID: 'C23:NEW' },
        { ID: 11, STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] } };
  } };
  assert.deepEqual(await processLiveEvent({ inbox, bitrix, event: { id: 'e', lease_token: 'l', deal_id: 42 } }), { status: 'retry' });
  assert.equal(retries, 1);
});

test('отсутствующая или неоднозначная дата включения блокирует настройку', () => {
  const pool = { async query() {}, connect() {} };
  for (const value of [undefined, '', '2026-11-01', '2026-11-01T00:00:00', '2026-11-01T00:00:00.000500Z', 'wrong']) {
    assert.throws(() => createLiveInbox(pool, { ...expected, liveEnabledAt: value }), /включения/);
  }
});

test('сбой источника планирует повтор, не записывая успешный результат', async () => {
  let finished = 0, retries = 0;
  const inbox = { async assertConfig() {}, async retry() { retries++; return true; }, async finish() { finished++; } };
  const bitrix = { async request() { throw new Error('секрет в ошибке'); } };
  const result = await processLiveEvent({ inbox, bitrix, event: { id: 'event', lease_token: 'lease', deal_id: 42 } });
  assert.deepEqual(result, { status: 'retry' });
  assert.equal(retries, 1);
  assert.equal(finished, 0);
});
