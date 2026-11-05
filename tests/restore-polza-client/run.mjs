import assert from 'node:assert/strict';
import { createPolzaClient } from '../../app/src/polza-client.mjs';

let attempts = 0;
const waits = [];
const client = createPolzaClient({
  apiKey: 'private-test-key',
  wait: async ms => waits.push(ms),
  fetchImpl: async (url, options) => {
    attempts++;
    assert.equal(url, 'https://api.polza.ai/api/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer private-test-key');
    if (attempts === 1) return { ok: false, status: 429 };
    return { ok: true, json: async () => ({ choices: [] }) };
  },
});
assert.deepEqual(await client.complete({ model: 'test' }), { choices: [] });
assert.equal(attempts, 2);
assert.deepEqual(waits, [10_000]);

let failedAttempts = 0;
const failed = createPolzaClient({
  apiKey: 'private-test-key',
  wait: async () => {},
  fetchImpl: async () => { failedAttempts++; throw new Error('private-test-key'); },
});
await assert.rejects(failed.complete({}), error =>
  error.retryable && !error.message.includes('private-test-key'));
assert.equal(failedAttempts, 2);
assert.throws(() => createPolzaClient({ apiKey: 'key', baseUrl: 'http://example.com' }), /HTTPS/);
console.log('Клиент Polza: проверки пройдены');
