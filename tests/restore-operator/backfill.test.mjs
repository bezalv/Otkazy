import test from 'node:test';
import assert from 'node:assert/strict';
import { listUnprocessedHistoryIds, reviewSelectedBackfill } from '../../app/src/operator/backfill.mjs';

const event = (historyId, dealId, disposition = 'unprocessed') => ({ history_id: String(historyId),
  event_key: `bitrix24:deal-stage-history:${historyId}`, deal_id: dealId, stage_id: 'C23:LOSE',
  occurred_at: '2026-11-01T02:00:00.000Z', disposition });
const report = (events, complete = true) => ({ pages_read: 1, scan_complete: complete, coverage_guaranteed: false, events });
const unchanged = async events => events.map(e => ({ event_key: e.event_key, status: 'not_found', complete: true }));
function fakeClient(rows) {
  const calls = [];
  return { calls, async request(method, args) {
    calls.push(method);
    if (method === 'crm.deal.get') return { result: { STAGE_ID: rows[args.id]?.stage ?? 'C23:LOSE' } };
    if (method === 'crm.stagehistory.list') {
      const row = rows[args.filter.OWNER_ID];
      if (row?.failure) throw new Error('SECRET_SHOULD_NOT_LEAK');
      return { result: row?.items ?? [{ ID: row?.id, STAGE_ID: 'C23:LOSE', CREATED_TIME: row?.date ?? '2026-11-01T02:00:00.000Z' }] };
    }
    throw new Error('Неожиданный запрос');
  } };
}

test('явный выбор и повторная сверка возвращают только технический ID и предупреждение', async () => {
  const input = report([event(11, 100), event(12, 200, 'unverified')], false);
  assert.deepEqual(listUnprocessedHistoryIds(input), ['11']);
  const client = fakeClient({ 100: { id: '11' } });
  const reviewed = await reviewSelectedBackfill({ report: input, selectedHistoryIds: ['11'], client, compareOutcomes: unchanged });
  assert.deepEqual(reviewed.events, [{ history_id: '11', status: 'first_history_row_matches' }]);
  assert.equal(reviewed.scan_complete, false);
  assert.equal(reviewed.coverage_guaranteed, false);
  assert.equal(reviewed.portal_binding_verified, false);
  assert.equal(reviewed.can_enqueue, false);
  assert.ok(reviewed.blocked_by.includes('history_timestamp_ties_not_resolved'));
  assert.deepEqual(client.calls, ['crm.deal.get', 'crm.stagehistory.list']);
  assert.doesNotMatch(JSON.stringify(reviewed), /deal_id|100|2026-11-01/);
});

test('отказ, изменённая история и ошибка API останавливают только соответствующие элементы', async () => {
  const input = report([event(11, 100), event(12, 200), event(13, 300), event(14, 400)]);
  const client = fakeClient({ 100: { id: '11', stage: 'WON' }, 200: { id: '777' }, 300: { failure: true }, 400: { id: '14', date: '2026-11-02T02:00:00Z' } });
  const reviewed = await reviewSelectedBackfill({ report: input, selectedHistoryIds: ['11', '12', '13', '14'], client, compareOutcomes: unchanged });
  assert.deepEqual(reviewed.events.map(e => e.status), ['current_transition_changed', 'current_transition_changed', 'current_transition_unknown', 'current_transition_changed']);
  assert.doesNotMatch(JSON.stringify(reviewed), /SECRET/);
  assert.equal(reviewed.can_enqueue, false);
});

test('сохранённые данные или неизвестный результат повторной сверки не считаются пропуском', async () => {
  const input = report([event(11, 100), event(12, 200), event(13, 300)]);
  const client = fakeClient({});
  const compareOutcomes = async events => [
    { event_key: events[0].event_key, status: 'unknown' },
    { event_key: events[1].event_key, status: 'not_found', complete: false },
    { event_key: events[2].event_key, status: 'processed' },
  ];
  const reviewed = await reviewSelectedBackfill({ report: input, selectedHistoryIds: ['11', '12', '13'], client, compareOutcomes });
  assert.deepEqual(reviewed.events.map(e => e.status), ['outcome_requires_review', 'outcome_requires_review', 'outcome_requires_review']);
  assert.deepEqual(client.calls, []);
});

test('без явного допустимого выбора API и БД не вызываются', async () => {
  const input = report([event(11, 100), event(12, 100), event(13, 300, 'unverified')]);
  const client = fakeClient({});
  let comparisons = 0;
  const compareOutcomes = async events => { comparisons++; return unchanged(events); };
  for (const ids of [[], ['11', '11'], ['11', '12'], ['13'], ['999'], ['011'], Array(51).fill('11')]) {
    await assert.rejects(reviewSelectedBackfill({ report: input, selectedHistoryIds: ids, client, compareOutcomes }));
  }
  assert.equal(comparisons, 0);
  assert.deepEqual(client.calls, []);
});

test('подмена или противоречие в отчёте и сверке не превращаются в готовый запуск', async () => {
  const good = event(11, 100);
  const client = fakeClient({ 100: { id: '11' } });
  for (const bad of [{ ...good, event_key: 'bitrix24:deal-stage-history:12' }, { ...good, stage_id: 'WON' }, { ...good, deal_id: 2147483648 }]) {
    await assert.rejects(reviewSelectedBackfill({ report: report([bad]), selectedHistoryIds: ['11'], client, compareOutcomes: unchanged }));
  }
  await assert.rejects(reviewSelectedBackfill({ report: { ...report([good]), coverage_guaranteed: true }, selectedHistoryIds: ['11'], client, compareOutcomes: unchanged }));
  for (const result of [[], [{ event_key: good.event_key, status: 'not_found', complete: true }, { event_key: good.event_key, status: 'not_found', complete: true }], [{ event_key: 'unknown', status: 'not_found', complete: true }]]) {
    await assert.rejects(reviewSelectedBackfill({ report: report([good]), selectedHistoryIds: ['11'], client, compareOutcomes: async () => result }));
  }
  await assert.rejects(reviewSelectedBackfill({ report: report([good]), selectedHistoryIds: ['11'], client,
    compareOutcomes: async () => { throw new Error('SECRET'); } }), /^Error: Не удалось повторно сверить исходы$/);
  assert.deepEqual(client.calls, []);
});
