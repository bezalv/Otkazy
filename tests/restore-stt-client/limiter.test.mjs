import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSttClient } from '../../app/src/stt-client.mjs';
import { createBitrixClient } from '../../app/src/bitrix-client.mjs';
import { createBitrixLimiter } from '../../app/src/bitrix-limiter.mjs';

test('таймаут получения аудио удаляет ожидающий вызов Битрикса из очереди', async () => {
  const limiter = createBitrixLimiter({ intervalMs: 1, maxWaitMs: 3000 });
  let release, ready, calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { ready = resolve; });
  const blocker = limiter.schedule('blocker', async () => { ready(); await held; });
  await started;
  const bitrix = createBitrixClient({ baseUrl: 'https://example.invalid/rest/1/token/', limiter,
    fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ result: {} }) }; } });
  const transcribe = createSttClient({ bitrix, sttUrl: 'http://127.0.0.1:8790', sttKey: 'fixture', downloadTimeoutMs: 30 });
  const result = await transcribe({ file_id: 42, channel_count: 2 });
  assert.equal(result.download_failed, true);
  release();
  await blocker;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls, 0);
  limiter.close();
});
