import assert from 'node:assert/strict';
import { createBitrixClient } from '../../app/src/bitrix-client.mjs';

const baseUrl = 'https://bitrix.example/rest/65/secret-token/';
assert.throws(() => createBitrixClient({ baseUrl: 'secret-token-invalid-url' }),
  (error) => !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes('secret-token'));
const ok = (value) => ({ ok: true, status: 200, json: async () => value });
let request;
const client = createBitrixClient({
  baseUrl,
  fetchImpl: async (url, options) => {
    request = { url, options };
    return ok({ result: [{ ID: 1 }], next: 50 });
  },
});

assert.deepEqual(await client.request('crm.deal.list', { start: 0 }), {
  result: [{ ID: 1 }],
  next: 50,
});
assert.equal(request.url, `${baseUrl}crm.deal.list.json`);
assert.equal(request.options.method, 'POST');
assert.deepEqual(JSON.parse(request.options.body), { start: 0 });

const failed = (response) => createBitrixClient({ baseUrl, fetchImpl: async () => response });
await assert.rejects(failed({ ok: false, status: 429 }).request('crm.deal.list'), {
  name: 'BitrixError', status: 429, retryable: true,
});
await assert.rejects(failed(ok({ error: 'QUERY_LIMIT_EXCEEDED' })).request('crm.deal.list'), {
  name: 'BitrixError', code: 'QUERY_LIMIT_EXCEEDED', retryable: true,
});
await assert.rejects(failed(ok({ error: 'secret-token /rest/65/secret-token' })).request('crm.deal.list'),
  (error) => !error.message.includes('secret-token') && !error.message.includes('/rest/'));
await assert.rejects(client.request('../bad'), /Недопустимое имя/);
const offline = createBitrixClient({ baseUrl, fetchImpl: async () => { throw new Error(baseUrl); } });
await assert.rejects(offline.request('crm.deal.list'),
  (error) => error.retryable && !error.message.includes('secret-token'));
console.log('Клиент Битрикса: проверки пройдены');
