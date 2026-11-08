import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolzaClient, createPolzaRoleInferenceClient } from '../../app/src/polza-client.mjs';

const role = { role: 'chat-role-inference' };
const good = () => ({ ok: true, async json() { return { choices: [{ finish_reason: 'stop', message: { content: '{"roles":[]}' } }] }; } });
const payload = { model: 'openai/gpt-6-sol', max_tokens: 5000,
  provider: { order: ['openai/flex', 'openai'], allow_fallbacks: true }, messages: [{ content: 'текст не для журнала' }] };

test('на одну задачу допускаются не более трёх последовательных физических POST', async () => {
  const calls = [];
  const client = createPolzaRoleInferenceClient({ apiKey: 'secret-test', fetchImpl: async (url, request) => {
    calls.push({ url, method: request.method }); return good();
  } });
  for (let i = 0; i < 3; i++) await client.complete(payload, role);
  await assert.rejects(client.complete(payload, role), /предел/);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.method === 'POST' && call.url.endsWith('/chat/completions')));
  assert.deepEqual(client.snapshot(), { physical_requests_started: 3, responses_received: 3,
    in_flight: false, uncertain_outcome: false, cost: 'unknown' });
  assert.doesNotMatch(JSON.stringify(client.snapshot()), /secret|текст/);
});

test('сбой, таймаут, HTTP-ошибка и некорректный JSON не повторяются и блокируют дальнейшие вызовы', async () => {
  for (const impl of [
    async () => { throw new Error('secret network message'); },
    async (_url, request) => { await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true })); throw new Error('timeout'); },
    async () => ({ ok: false, status: 500 }),
    async () => ({ ok: true, async json() { throw new Error('secret JSON body'); } }),
    async () => ({ ok: true, async json() { return { choices: [{ finish_reason: 'stop', message: { content: '{' } }] }; } }),
    async () => ({ ok: true, async json() { return { choices: [{ finish_reason: 'length', message: { content: '{"roles":[]}' } }] }; } }),
  ]) {
    let calls = 0;
    const client = createPolzaRoleInferenceClient({ apiKey: 'secret-test', timeoutMs: 5, fetchImpl: async (...args) => { calls++; return impl(...args); } });
    await assert.rejects(client.complete(payload, role), error => !/secret|текст/.test(error.message));
    await assert.rejects(client.complete(payload, role), /не подтверждён/);
    assert.equal(calls, 1);
    assert.deepEqual(client.snapshot(), { physical_requests_started: 1, responses_received: 0,
      in_flight: false, uncertain_outcome: true, cost: 'unknown' });
  }
});

test('переадресация запроса запрещена и отказ редиректа закрывает клиент', async () => {
  let calls = 0;
  const client = createPolzaRoleInferenceClient({ apiKey: 'secret-test', fetchImpl: async (_url, request) => {
    calls++;
    assert.equal(request.redirect, 'error');
    throw new TypeError('redirect');
  } });
  await assert.rejects(client.complete(payload, role), /не подтверждён/);
  await assert.rejects(client.complete(payload, role), /не подтверждён/);
  assert.equal(calls, 1);
  assert.equal(client.snapshot().uncertain_outcome, true);
});

test('одновременный вызов не отправляется, после завершения можно продолжать последовательно', async () => {
  let release; let calls = 0;
  const client = createPolzaRoleInferenceClient({ apiKey: 'secret-test', fetchImpl: async () => {
    calls++; if (calls === 1) await new Promise(resolve => { release = resolve; }); return good();
  } });
  const first = client.complete(payload, role);
  assert.equal(client.snapshot().in_flight, true);
  await assert.rejects(client.complete(payload, role), /Параллельные/);
  assert.equal(calls, 1);
  release(); await first;
  await client.complete(payload, role);
  assert.equal(calls, 2);
});

test('две задачи имеют независимые счётчики; запрещённая роль и несерилизуемый запрос не делают POST', async () => {
  let calls = 0;
  const make = () => createPolzaRoleInferenceClient({ apiKey: 'secret-test', maxRequests: 1, fetchImpl: async () => { calls++; return good(); } });
  const first = make(), second = make();
  const circular = { ...payload }; circular.self = circular;
  await assert.rejects(first.complete(payload, { role: 'judge' }), /только определение/);
  await assert.rejects(first.complete(circular, role), /Некорректный запрос/);
  assert.equal(calls, 0);
  await first.complete(payload, role);
  await second.complete(payload, role);
  assert.equal(calls, 2);
  await assert.rejects(first.complete(payload, role), /предел/);
  assert.equal(second.snapshot().physical_requests_started, 1);
});

test('модель, потолок токенов, настройки провайдера и размер проверяются до POST', async () => {
  let calls = 0;
  const client = createPolzaRoleInferenceClient({ apiKey: 'secret-test', fetchImpl: async () => { calls++; return good(); } });
  for (const body of [
    { ...payload, model: 'other-model' }, { ...payload, max_tokens: 5001 }, { ...payload, max_tokens: 0 },
    { ...payload, provider: { ...payload.provider, extra: true } },
    { ...payload, provider: { order: ['openai'], allow_fallbacks: true } },
    { ...payload, messages: [{ content: 'ы'.repeat(50_000) }] },
  ]) await assert.rejects(client.complete(body, role), /запрещены|Некорректный запрос/);
  assert.equal(calls, 0);
  assert.equal(client.snapshot().physical_requests_started, 0);
});

test('failClosed идемпотентно запрещает запросы и не снимается завершением активного fetch', async () => {
  let release; let calls = 0;
  const client = createPolzaRoleInferenceClient({ apiKey: 'secret-test', fetchImpl: async () => {
    calls++; await new Promise(resolve => { release = resolve; }); return good();
  } });
  const first = client.complete(payload, role);
  client.failClosed(); client.failClosed();
  await assert.rejects(client.complete(payload, role), /не подтверждён/);
  release();
  await assert.rejects(first, /не подтверждён/);
  await assert.rejects(client.complete(payload, role), /не подтверждён/);
  assert.equal(calls, 1);
  assert.equal(client.snapshot().uncertain_outcome, true);
  assert.equal(client.snapshot().in_flight, false);
});

test('старый клиент сохраняет прежний повтор после 500, новый не создаёт запрос при инициализации', async () => {
  let calls = 0, waits = 0;
  const fetchImpl = async () => { calls++; return calls === 1 ? { ok: false, status: 500 } : good(); };
  createPolzaRoleInferenceClient({ apiKey: 'secret-test', fetchImpl });
  assert.equal(calls, 0);
  const old = createPolzaClient({ apiKey: 'secret-test', fetchImpl, wait: async () => { waits++; } });
  await old.complete(payload, { role: 'judge' });
  assert.equal(calls, 2); assert.equal(waits, 1);
});
