import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRetries } from '../../app/src/retry/plan.mjs';

const nowMs = Date.parse('2026-11-05T00:00:00Z');
const resolveCurrentLoss = async id => ({ 1: '2026-11-04T00:00:00Z', 2: '2026-10-01T00:00:00Z', 3: '2026-11-04T00:00:00Z', 5: '2026-11-04T00:00:00Z' })[id] || null;
const rows = [
  { deal_id: 1, lose_date: '2026-11-04T00:00:00Z', retry_eligible: true },
  { deal_id: 2, lose_date: '2026-10-01T00:00:00Z', retry_eligible: true },
  { deal_id: 3, lose_date: null, retry_eligible: true },
  { deal_id: 4, lose_date: null, retry_eligible: true },
  { deal_id: 5, lose_date: '2026-11-04T00:00:00Z', retry_eligible: false },
];

test('ночной повтор сохраняет свежесть, лимит и тихий режим при неизвестной дате', async () => {
  const result = await planRetries({ rows, mode: 'nightly', runKey: '2026-11-05', nowMs, resolveCurrentLoss });
  assert.deepEqual(result.actions.map(item => [item.dealId, item.silent]), [[1, false], [2, true], [3, true]]);
  assert.deepEqual(result.deferred, [{ dealId: 4, reason: 'lose_date_unavailable' }]);
  assert.equal(result.actions[2].loseDate, '2026-11-04T00:00:00.000Z');
});

test('ручной повтор не ограничивает возраст и ночные попытки', async () => {
  const result = await planRetries({ rows, mode: 'manual', runKey: 'manual-1', nowMs, resolveCurrentLoss });
  assert.deepEqual(result.actions.map(item => [item.dealId, item.silent]), [[1, false], [2, false], [3, false], [5, false]]);
});

test('ночной прогон ограничен 20 допустимыми сделками', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ deal_id: i + 1, lose_date: '2026-11-04T00:00:00Z', retry_eligible: true }));
  const result = await planRetries({ rows: many, mode: 'nightly', runKey: '2026-11-05', nowMs, resolveCurrentLoss: async () => '2026-11-04T00:00:00Z' });
  assert.equal(result.actions.length, 20);
});

test('повторный отказ использует дату нового перехода и его свежесть', async () => {
  const rows = [{ deal_id: 42, lose_date: '2026-10-01T00:00:00Z', retry_eligible: true }];
  const result = await planRetries({ rows, mode: 'nightly', runKey: '2026-11-05', nowMs, resolveCurrentLoss: async () => '2026-11-04T00:00:00Z' });
  assert.equal(result.actions[0].loseDate, '2026-11-04T00:00:00.000Z');
  assert.equal(result.actions[0].silent, false);
});
