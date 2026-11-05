import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJobQueue } from '../../app/src/queue/index.mjs';

const uuid = '123e4567-e89b-42d3-a456-426614174000';
const request = { requestKey: 'deal:42:transition:1', dealId: 42, loseDate: '2026-11-01T00:00:00Z', triggerType: 'live' };

test('постановка использует параметры и сохраняет безопасные настройки', async () => {
  let query;
  const queue = createJobQueue({ async query(sql, params) { query = { sql, params }; return { rows: [{ id: uuid }] }; } }, { uuid: () => uuid });
  const result = await queue.enqueue(request);
  assert.equal(result.created, true);
  assert.deepEqual(query.params, [uuid, request.requestKey, 42, '2026-11-01T00:00:00.000Z', 'live', false, true]);
  assert.match(query.sql, /on conflict \(request_key\) do nothing/i);
});

test('дубликат с теми же параметрами не создаёт новое задание', async () => {
  let calls = 0;
  const queue = createJobQueue({ async query() {
    calls++;
    return { rows: calls === 1 ? [] : [{ id: uuid, deal_id: 42, lose_date: request.loseDate, trigger_type: 'live', silent: false, screenshots: true }] };
  } }, { uuid: () => uuid });
  assert.equal((await queue.enqueue(request)).created, false);
  assert.equal(calls, 2);
});

test('совпавший ключ с другими параметрами отклоняется', async () => {
  let calls = 0;
  const queue = createJobQueue({ async query() {
    calls++;
    return { rows: calls === 1 ? [] : [{ deal_id: 999, lose_date: request.loseDate, trigger_type: 'live', silent: false, screenshots: true }] };
  } }, { uuid: () => uuid });
  await assert.rejects(queue.enqueue(request), /другими параметрами/);
});

test('захват использует SKIP LOCKED и UUID аренды', async () => {
  let query;
  const queue = createJobQueue({ async query(sql, params) { query = { sql, params }; return { rows: [{ id: uuid, lease_token: uuid }] }; } }, { uuid: () => uuid });
  const job = await queue.claim();
  assert.equal(job.lease_token, uuid);
  assert.match(query.sql, /for update skip locked/i);
  assert.deepEqual(query.params, [uuid, 4200]);
});

test('параллельный захват одной сделки возвращает пустой результат', async () => {
  const queue = createJobQueue({ async query() { throw Object.assign(new Error('conflict'), { code: '23505', constraint: 'lost_jobs_one_processing_per_deal' }); } }, { uuid: () => uuid });
  assert.equal(await queue.claim(), null);
});

test('продление не восстанавливает истёкшую или чужую аренду', async () => {
  let query;
  const queue = createJobQueue({ async query(sql, params) { query = { sql, params }; return { rows: [] }; } });
  assert.equal(await queue.renew(uuid, uuid), false);
  assert.match(query.sql, /lease_token = \$2/);
  assert.match(query.sql, /lease_until > now\(\)/);
});
