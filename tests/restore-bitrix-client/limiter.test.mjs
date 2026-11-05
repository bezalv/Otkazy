import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createBitrixClient } from '../../app/src/bitrix-client.mjs';
import { createBitrixLimiter } from '../../app/src/bitrix-limiter.mjs';

const baseUrl = 'https://example.invalid/rest/1/secret-token';
const ok = value => ({ ok: true, status: 200, json: async () => value });

test('быстрые запросы не создают стартовый всплеск', async () => {
  const limiter = createBitrixLimiter({ intervalMs: 35 });
  const starts = [];
  const client = createBitrixClient({ baseUrl, limiter, fetchImpl: async () => {
    starts.push(Date.now()); return ok({ result: true });
  } });
  await Promise.all([client.request('user.current'), client.request('user.current'), client.request('user.current')]);
  assert.ok(starts[1] - starts[0] >= 35 && starts[2] - starts[1] >= 35);
  limiter.close();
});

test('интервал отсчитывается от реального запроса после долгой проверки', async () => {
  const limiter = createBitrixLimiter({ intervalMs: 35 });
  const starts = [];
  const client = createBitrixClient({ baseUrl, limiter, fetchImpl: async () => {
    starts.push(Date.now()); return ok({ result: true });
  } });
  await Promise.all([
    client.request('user.current', {}, { beforeSend: async () => { await delay(60); return true; } }),
    client.request('user.current'),
  ]);
  assert.ok(starts[1] - starts[0] >= 35);
  limiter.close();
});

test('оба клиента разделяют частоту и одновременно выполняют только один запрос', async () => {
  const limiter = createBitrixLimiter({ intervalMs: 30 });
  let active = 0, maxActive = 0;
  const starts = [];
  const fetchImpl = async () => {
    starts.push(Date.now());
    maxActive = Math.max(maxActive, ++active);
    await delay(45);
    active--;
    return ok({ result: true });
  };
  const first = createBitrixClient({ baseUrl, limiter, fetchImpl });
  const second = createBitrixClient({ baseUrl, limiter, fetchImpl });
  await Promise.all([first.request('crm.deal.get'), second.request('crm.deal.list'), first.request('crm.deal.get')]);
  assert.equal(maxActive, 1);
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 30 && starts[2] - starts[1] >= 30);
  limiter.close();
});

test('503 и 429 читают безопасный код, а cooldown одного метода не задерживает другой', async () => {
  const limiter = createBitrixLimiter({ intervalMs: 10, maxWaitMs: 100 });
  const calls = [];
  const fetchImpl = async url => {
    const method = url.split('/').at(-1);
    calls.push(method);
    if (method === 'crm.deal.get.json' && calls.filter(x => x === method).length === 1) {
      return ok({ result: {}, time: { operating_reset_at: Math.floor(Date.now() / 1000) + 60 } });
    }
    if (method === 'crm.deal.get.json') return { ok: false, status: 429, json: async () => ({ error: 'OPERATION_TIME_LIMIT', error_description: baseUrl }) };
    if (method === 'crm.deal.list.json') return { ok: false, status: 503, json: async () => ({ error: 'QUERY_LIMIT_EXCEEDED', error_description: baseUrl }) };
    return ok({ result: true });
  };
  const client = createBitrixClient({ baseUrl, limiter, fetchImpl });
  await client.request('crm.deal.get');
  await assert.rejects(client.request('crm.deal.get'), error => error.status === 429 && error.code === 'OPERATION_TIME_LIMIT' && error.retryable && !String(error).includes('secret-token'));
  const blocked = client.request('crm.deal.get');
  const blockedCheck = assert.rejects(blocked, error => error.code === 'BITRIX_LIMITER_QUEUE_TIMEOUT' && error.retryable && error.retryAfterMs > 0);
  await assert.rejects(client.request('crm.deal.list'), error => error.status === 503 && error.code === 'QUERY_LIMIT_EXCEEDED' && error.retryable && !String(error).includes('secret-token'));
  assert.equal((await client.request('user.current')).result, true);
  await blockedCheck;
  assert.equal(calls.filter(x => x === 'crm.deal.get.json').length, 2);
  limiter.close();
});

test('неизвестный ответ не раскрывает токен даже похожий на код ошибки', async () => {
  const client = createBitrixClient({ baseUrl, fetchImpl: async () => ({
    ok: false, status: 503, json: async () => ({ error: 'SECRET_TOKEN' }),
  }) });
  await assert.rejects(client.request('user.current'), error => error.retryable && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes('SECRET_TOKEN'));
  const client200 = createBitrixClient({ baseUrl, fetchImpl: async () => ok({ error: 'SECRET_TOKEN' }) });
  await assert.rejects(client200.request('user.current'), error => error.code === 'API' && !String(error).includes('SECRET_TOKEN'));
});

test('зависший запрос не создаёт параллельный запрос, ожидание очереди ограничено', async () => {
  const limiter = createBitrixLimiter({ intervalMs: 10, maxWaitMs: 40 });
  let finish, calls = 0;
  const held = new Promise(resolve => { finish = resolve; });
  const client = createBitrixClient({ baseUrl, limiter, fetchImpl: async () => { calls++; await held; return ok({ result: true }); } });
  const first = client.request('user.current');
  await assert.rejects(client.request('crm.deal.list'), { code: 'BITRIX_LIMITER_QUEUE_TIMEOUT', retryable: true });
  assert.equal(calls, 1);
  finish();
  await first;
  limiter.close();
});

test('отмена сети освобождает очередь, а остановка отклоняет ожидающие запросы', async () => {
  const limiter = createBitrixLimiter({ intervalMs: 10 });
  let calls = 0;
  const client = createBitrixClient({ baseUrl, limiter, timeoutMs: 20, fetchImpl: async (_url, options) => {
    calls++;
    if (calls > 1) return ok({ result: true });
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error(baseUrl)), { once: true }));
  } });
  const first = assert.rejects(client.request('user.current'), error => error.retryable && !String(error).includes('secret-token'));
  const second = client.request('crm.deal.list');
  await first;
  assert.equal((await second).result, true);
  const pending = client.request('crm.deal.get');
  limiter.close();
  await assert.rejects(pending, { code: 'BITRIX_LIMITER_CLOSED', retryable: true });
});

test('отмена во время предварительной проверки не запускает запрос после неё', async () => {
  const limiter = createBitrixLimiter({ intervalMs: 1 });
  const controller = new AbortController();
  let release, ready, calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { ready = resolve; });
  const client = createBitrixClient({ baseUrl, limiter, fetchImpl: async () => { calls++; return ok({ result: true }); } });
  const work = client.request('user.current', {}, { signal: controller.signal,
    beforeSend: async () => { ready(); await held; return true; } });
  await started;
  controller.abort();
  release();
  await assert.rejects(work, { code: 'BITRIX_REQUEST_NOT_STARTED', requestStarted: false });
  assert.equal(calls, 0);
  limiter.close();
});
