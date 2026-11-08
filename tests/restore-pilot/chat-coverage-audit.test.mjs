import test from 'node:test';
import assert from 'node:assert/strict';
import { auditChatCoverage } from '../../app/src/pilot/chat-coverage-audit.mjs';

const from = '2026-01-01T00:00:00.000Z', cutoff = '2026-10-28T05:35:03.000Z';
const row = (n, more = {}) => ({ id: 1000 + n, configId: 71, chatId: 999,
  crmEntityType: 'CONTACT', crmEntityId: 999, dateCreate: new Date(Date.parse('2026-10-20T00:00:00Z') - n * 1000).toISOString(),
  dateClose: null, privateField: 'PRIVATE', ...more });
const target = (n, more = {}) => row(n, { chatId: 100, crmEntityType: 'DEAL', crmEntityId: 127114, ...more });
const args = { dealId: 127114, chats: [{ chatId: 100, lineId: 71 }], activitySessionIds: [1001, 1006], from, cutoff };
function fixture(pages, secondPages = pages) {
  let calls = 0;
  return { get calls() { return calls; }, client: { async request(method, body) {
    assert.equal(method, 'imopenlines.v2.Session.list');
    assert.deepEqual(Object.keys(body).sort(), ['configId', 'dateCreateFrom', 'dateCreateTo', 'limit', 'offset', 'order', 'orderDirection']);
    assert.equal(body.configId, 71); assert.equal(body.limit, 200); assert.equal(body.order, 'dateCreate');
    assert.equal(body.orderDirection, 'desc'); assert.equal(body.dateCreateFrom, from); assert.equal(body.dateCreateTo, cutoff);
    const pass = calls++ < pages.length ? pages : secondPages;
    const page = pass[body.offset / 200];
    if (page instanceof Error || !page) throw new Error('PRIVATE');
    return { result: structuredClone(page) };
  } } };
}
const page = sessions => ({ sessions, hasNextPage: false });

test('сопоставляет сессии по чату, CRM и activity, оставляет глобальную полноту неизвестной', async () => {
  const rows = [target(0), target(1), target(2, { crmEntityType: null, crmEntityId: null }),
    target(3, { crmEntityType: 'DEAL', crmEntityId: 127115 }),
    target(4, { crmEntityType: 'CONTACT', crmEntityId: 127114 }),
    row(5, { chatId: null, crmEntityType: null, crmEntityId: null }), row(6),
    target(7, { crmEntityType: 'mystery', crmEntityId: 127114 })];
  const f = fixture([page(rows)]);
  const result = await auditChatCoverage({ ...args, client: f.client });
  assert.equal(f.calls, 2); assert.equal(result.status, 'audited'); assert.equal(result.history_coverage, 'unverified');
  assert.deepEqual(result.chats, [{ chat_id: '100', line_id: '71', visible_sessions: 6,
    crm_match: 2, crm_other: 2, crm_unknown: 2, with_activity: 1, without_activity: 5,
    crm_match_without_activity: 1, crm_other_without_activity: 2, crm_unknown_without_activity: 2 }]);
  assert.deepEqual(result.lines, [{ line_id: '71', pages_per_scan: 1, sessions_with_unknown_chat: 1 }]);
  assert.equal(result.activities_not_seen_in_known_chats, 1);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.ok(!JSON.stringify(result).includes('1006'));
  assert.ok(result.limitations.includes('current_binding_not_historical_proof'));
});

test('сканирует все страницы дважды и отвергает дубли или смещение между чтениями', async () => {
  const p1 = { sessions: Array.from({ length: 200 }, (_, i) => row(i)), hasNextPage: true };
  const p2 = page([target(200)]);
  let f = fixture([p1, p2]);
  let result = await auditChatCoverage({ ...args, client: f.client });
  assert.equal(result.status, 'audited'); assert.equal(f.calls, 4);
  assert.equal(result.chats[0].visible_sessions, 1); assert.equal(result.lines[0].pages_per_scan, 2);
  f = fixture([p1, page([row(10, { dateCreate: row(200).dateCreate })])]);
  result = await auditChatCoverage({ ...args, client: f.client });
  assert.equal(result.reason, 'duplicate_session');
  f = fixture([p1, p2], [p1, page([target(201)])]);
  result = await auditChatCoverage({ ...args, client: f.client });
  assert.equal(result.reason, 'unstable_snapshot');
  f = fixture([p1, p2], [p1, page([target(200, { crmEntityId: 7 })])]);
  result = await auditChatCoverage({ ...args, client: f.client });
  assert.equal(result.reason, 'unstable_snapshot');
});

test('не выдаёт результаты при неполной или некорректной пагинации и границе с равным временем', async () => {
  const full = Array.from({ length: 200 }, (_, i) => row(i));
  for (const [pages, maxPages, reason] of [
    [[{ sessions: [target(1)], hasNextPage: true }], 20, 'invalid_page'],
    [[{ sessions: full, hasNextPage: true }], 1, 'pagination_incomplete'],
    [[{ sessions: full, hasNextPage: true }, page([])], 20, 'invalid_page'],
    [[{ sessions: full, hasNextPage: true }, page([row(200, { dateCreate: full[199].dateCreate })])], 20, 'unstable_page_boundary'],
    [[page([row(2), row(1)])], 20, 'invalid_row'],
    [[page([row(1, { configId: 72 })])], 20, 'invalid_row'],
    [[page([row(1, { dateCreate: '2026-10-28T05:35:03.0001Z' })])], 20, 'invalid_row'],
  ]) {
    const f = fixture(pages);
    const result = await auditChatCoverage({ ...args, client: f.client, maxPages });
    assert.equal(result.status, 'unverified'); assert.equal(result.reason, reason);
    assert.equal(Object.hasOwn(result, 'chats'), false);
  }
});

test('не запускает запросы с неверными границами, дублирующимися чатами и session ID', async () => {
  const f = fixture([page([])]);
  for (const invalid of [
    { from: '2024-01-01T00:00:00Z' }, { from: '2026-11-01T00:00:00Z' }, { cutoff: '2026-02-30T00:00:00Z' },
    { maxPages: 21 }, { maxPages: 0 }, { dealId: 0 }, { chats: [{ chatId: 100, lineId: 71 }, { chatId: 100, lineId: 72 }] },
    { activitySessionIds: [1, '1'] }, { activitySessionIds: [0] },
  ]) {
    const result = await auditChatCoverage({ ...args, ...invalid, client: f.client });
    assert.deepEqual(result, { status: 'unverified', history_coverage: 'unverified', reason: 'invalid_input' });
  }
  assert.equal(f.calls, 0);
  const cancelled = await auditChatCoverage({ ...args, client: f.client, signal: AbortSignal.abort() });
  assert.equal(cancelled.reason, 'cancelled'); assert.equal(f.calls, 0);
});

test('не раскрывает ошибки источника и не выдаёт частичный результат', async () => {
  const f = fixture([new Error('PRIVATE')]);
  const result = await auditChatCoverage({ ...args, client: f.client });
  assert.deepEqual(result, { status: 'unverified', history_coverage: 'unverified', reason: 'request_unavailable' });
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('две цели одной линии читают её один раз на проход, другая линия проверяется отдельно', async () => {
  const calls = [], client = { async request(method, body) {
    calls.push(body.configId);
    return { result: body.configId === 71
      ? page([target(0), target(1, { chatId: 101 })])
      : page([target(2, { configId: 72, chatId: 102 })]) };
  } };
  const result = await auditChatCoverage({ ...args, client,
    chats: [{ chatId: 100, lineId: 71 }, { chatId: 101, lineId: 71 }, { chatId: 102, lineId: 72 }] });
  assert.equal(result.status, 'audited'); assert.deepEqual(calls, [71, 71, 72, 72]);
  assert.deepEqual(result.chats.map(x => x.visible_sessions), [1, 1, 1]);
  const duplicate = { async request(method, body) { return { result: page([target(0,
    { configId: body.configId, chatId: body.configId === 71 ? 100 : 102 })]) }; } };
  const error = await auditChatCoverage({ ...args, client: duplicate,
    chats: [{ chatId: 100, lineId: 71 }, { chatId: 102, lineId: 72 }] });
  assert.equal(error.reason, 'duplicate_session');
});
