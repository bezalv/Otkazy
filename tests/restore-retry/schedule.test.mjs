import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentLossDate, prepareRetryPlan, scheduleRetries } from '../../app/src/retry/schedule.mjs';

test('актуальная дата читается из истории отказа', async () => {
  const client = { async request(method, body) {
    if (method === 'crm.deal.get') return { result: { STAGE_ID: 'C23:LOSE' } };
    return { result: { items: [{ STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] } };
  } };
  assert.equal(await currentLossDate(client, 42), '2026-11-04T00:00:00Z');
});

test('устаревшая история не подставляет предыдущую дату отказа', async () => {
  const client = { async request(method) { return method === 'crm.deal.get'
    ? { result: { STAGE_ID: 'C23:LOSE' } }
    : { result: { items: [{ STAGE_ID: 'C23:NEW' }, { STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-10-01T00:00:00Z' }] } }; } };
  await assert.rejects(currentLossDate(client, 42), /ещё не подтверждает/);
});

test('ночная выборка и постановка сохраняют тихий режим при отсутствующей дате', async () => {
  const submitted = [];
  let sql = '';
  const pool = { async query(statement) { sql = statement; return { rows: [{ deal_id: 42, lose_date: null, retry_eligible: true }] }; } };
  const queue = { async enqueue(action) { submitted.push(action); return { created: true }; } };
  const bitrix = { async request(method) { return method === 'crm.deal.get'
    ? { result: { STAGE_ID: 'C23:LOSE' } }
    : { result: { items: [{ STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] } }; } };
  const plan = await prepareRetryPlan({ pool, bitrix, mode: 'nightly', runKey: '2026-11-05', nowMs: Date.parse('2026-11-05T00:00:00Z') });
  assert.match(sql, /retry_eligible=true/);
  assert.match(sql, /LIMIT 20/);
  assert.equal(plan.actions[0].silent, true);
  assert.equal(submitted.length, 0);
  await assert.rejects(scheduleRetries({ pool, queue, bitrix, mode: 'nightly', runKey: 'day' }), /сохранённый план/);
});

test('ошибка постановки одной сделки не скрывает остальные', async () => {
  const pool = { async query() { return { rows: [1, 2].map(deal_id => ({ deal_id, lose_date: '2026-11-04T00:00:00Z', retry_eligible: true })) }; } };
  const queue = { async enqueue(item) { if (item.dealId === 1) throw new Error('secret'); return { created: true }; } };
  const bitrix = { async request(method) { return method === 'crm.deal.get'
    ? { result: { STAGE_ID: 'C23:LOSE' } }
    : { result: { items: [{ STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] } }; } };
  const result = await scheduleRetries({ pool, queue, bitrix, mode: 'manual', runKey: 'day', nowMs: Date.parse('2026-11-05T00:00:00Z') });
  assert.equal(result.enqueued.length, 1);
  assert.deepEqual(result.failed, [{ dealId: 1, reason: 'enqueue_failed' }]);
});

test('некорректная дата ночного отбора не передаётся в SQL', async () => {
  const pool = { async query() { assert.fail('ошибка должна обнаружиться до SQL'); } };
  await assert.rejects(prepareRetryPlan({ pool, bitrix: { request() {} }, mode: 'nightly', runKey: '2026-02-30' }), /дата/i);
});
