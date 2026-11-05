import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverTransitions } from '../../app/src/discovery/index.mjs';

const from = '2026-11-01T00:00:00Z';
const to = '2026-11-08T00:00:00Z';
const row = (id, owner, stage, date) => ({ ID: String(id), OWNER_ID: String(owner), STAGE_ID: stage, CREATED_TIME: date });
const first = row(1, 42, 'C23:LOSE', '2026-11-02T10:00:00+07:00');
const second = row(2, 42, 'C23:NEW', '2026-11-03T03:00:00Z');
const third = row(3, 42, 'C23:LOSE', '2026-11-04T03:00:00Z');
const fourth = row(4, 43, 'C23:LOSE', '2026-11-08T00:00:00Z');
const missing = events => events.map(event => ({ event_key: event.event_key, status: 'not_found', complete: true }));

function clientOf(pages) {
  const calls = [];
  return {
    calls,
    async request(method, body) {
      calls.push({ method, body });
      if (!Object.hasOwn(pages, body.start)) throw new Error('Неожиданная страница');
      return pages[body.start];
    },
  };
}

test('пагинация и повторный отказ создают разные устойчивые event_key', async () => {
  const client = clientOf({
    0: { result: { items: [first, second] }, next: 2, total: 4 },
    2: { result: { items: [third, fourth] }, total: 4 },
  });
  const waits = [];
  const result = await discoverTransitions({ client, compareOutcomes: missing, from, to, wait: async ms => waits.push(ms) });
  assert.equal(result.scan_complete, true);
  assert.equal(result.coverage_guaranteed, false);
  assert.equal(result.pages_read, 2);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(result.events.map(event => event.event_key), [
    'bitrix24:deal-stage-history:1', 'bitrix24:deal-stage-history:3',
  ]);
  assert.ok(result.events.every(event => event.disposition === 'unprocessed'));
  assert.equal(result.events[0].occurred_at, '2026-11-02T03:00:00.000Z');
  assert.equal(client.calls[0].method, 'crm.stagehistory.list');
  assert.deepEqual(client.calls[0].body.order, { ID: 'ASC' });
  assert.deepEqual(client.calls[0].body.filter, {});
});

test('продолжение содержит границу ID и привязано к исходному окну', async () => {
  const client = clientOf({
    0: { result: { items: [first, second] }, next: 2, total: 4 },
    2: { result: { items: [third, fourth] }, total: 4 },
  });
  const chunk = await discoverTransitions({ client, compareOutcomes: missing, from, to, maxPages: 1, wait: async () => {} });
  assert.equal(chunk.scan_complete, false);
  assert.equal(chunk.next_cursor.start, 2);
  assert.equal(chunk.next_cursor.last_id, '2');
  const rest = await discoverTransitions({ client, compareOutcomes: missing, from, to, cursor: chunk.next_cursor, maxPages: 1, wait: async () => {} });
  assert.equal(rest.scan_complete, true);
  assert.equal(rest.events[0].history_id, '3');
  await assert.rejects(discoverTransitions({ client, compareOutcomes: missing, from, to: '2026-11-09T00:00:00Z', cursor: chunk.next_cursor, wait: async () => {} }), /другому окну/);
});

test('исходы учитываются только с доказательством нужного перехода', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => row(index + 1, index + 40, 'C23:LOSE', '2026-11-03T00:00:00Z'));
  const client = clientOf({ 0: { result: { items: rows }, total: 6 } });
  const result = await discoverTransitions({ client, from, to, wait: async () => {}, compareOutcomes: async events => [
    { event_key: events[0].event_key, status: 'processed', evidence: { event_key: events[0].event_key } },
    { event_key: events[1].event_key, status: 'skipped_by_reason', evidence: { deal_id: events[1].deal_id, lose_date: '2026-11-03T07:00:00+07:00' } },
    { event_key: events[2].event_key, status: 'waiting_audio', evidence: { event_key: events[2].event_key } },
    { event_key: events[3].event_key, status: 'pipeline_error', evidence: { event_key: events[3].event_key } },
    { event_key: events[4].event_key, status: 'processed', evidence: { deal_id: events[4].deal_id, lose_date: '2026-11-02T00:00:00Z' } },
    { event_key: events[5].event_key, status: 'not_found' },
  ] });
  assert.deepEqual(result.events.map(event => event.disposition), [
    'already_handled', 'already_handled', 'already_waiting', 'retry_needed', 'unverified', 'unverified',
  ]);
});

test('неполная или ошибочная сверка никогда не объявляет сделки пропущенными', async () => {
  const client = clientOf({ 0: { result: { items: [first] }, total: 1 } });
  for (const compareOutcomes of [async () => [], async () => [{ event_key: 'чужой', status: 'not_found', complete: true }], async () => { throw new Error('https://private.invalid/?secret=x'); }]) {
    await assert.rejects(discoverTransitions({ client, compareOutcomes, from, to, wait: async () => {} }), error => {
      assert.equal(error.message.includes('private.invalid'), false);
      return true;
    });
  }
});

test('повторяемый сбой получает паузы 2 и 4 секунды, постоянный не повторяется', async () => {
  let calls = 0;
  const client = { async request() {
    calls++;
    if (calls < 3) throw Object.assign(new Error('secret'), { retryable: true });
    return { result: { items: [] }, total: 0 };
  } };
  const waits = [];
  const result = await discoverTransitions({ client, compareOutcomes: missing, from, to, wait: async ms => waits.push(ms) });
  assert.equal(result.scan_complete, true);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 4000]);
  calls = 0;
  await assert.rejects(discoverTransitions({ client: { async request() { calls++; throw new Error('https://private.invalid/secret'); } }, compareOutcomes: missing, from, to, wait: async () => {} }), error => {
    assert.equal(error.message.includes('private.invalid'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('ошибки формата и пагинации прерывают обход целиком', async () => {
  const one = { result: { items: [first] } };
  const badPages = [
    {}, { result: {} }, { result: { items: [first] }, next: 0 },
    { result: { items: [] }, total: '' }, { result: { items: [first] }, next: true },
    { result: { items: [first] }, next: 10 }, { result: { items: [] }, next: 50 },
    { ...one, total: 2 }, { ...one, total: 0 },
    { result: { items: [third, first] } },
    { result: { items: [first, { ...second, ID: '1' }] } },
    { result: { items: [{ ...first, OWNER_ID: undefined }] } },
    { result: { items: [{ ...first, CREATED_TIME: '2026-11-02' }] } },
    { result: { items: Array.from({ length: 50 }, (_, i) => row(i + 1, 42, 'C23:NEW', '2026-11-02T00:00:00Z')) } },
  ];
  for (const page of badPages) {
    const client = clientOf({ 0: page });
    await assert.rejects(discoverTransitions({ client, compareOutcomes: missing, from, to, wait: async () => {} }));
  }
});

test('ответ в форме массива из архивного адаптера допускается, пустой массив не сверяется', async () => {
  const client = clientOf({ 0: { result: [], total: 0 } });
  const result = await discoverTransitions({ client, from, to, wait: async () => {}, compareOutcomes: async () => { throw new Error('Не должен вызываться'); } });
  assert.deepEqual(result.events, []);
  assert.equal(result.scan_complete, true);
});
