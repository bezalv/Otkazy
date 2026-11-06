import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPilotDependencies } from '../../app/src/pilot/dependencies.mjs';

const base = { bitrixBaseUrl: 'https://example.invalid/rest/1/test', polzaKey: 'test-only',
  sttUrl: 'http://127.0.0.1:45678', sttKey: 'test-only', tempRoot: process.cwd() };

function hangingFetch(seen) {
  return (_url, options) => new Promise((_, reject) => {
    seen.push(options.signal);
    if (options.signal.aborted) return reject(new Error('aborted'));
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

test('отмена прерывает начатый read-only запрос Битрикса', async () => {
  const controller = new AbortController(), seen = [];
  const deps = createPilotDependencies({ ...base, signal: controller.signal, fetchImpl: hangingFetch(seen) });
  try {
    const pending = deps.bitrix.request('crm.deal.get', { id: 42 });
    while (!seen.length) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending);
    assert.equal(seen[0].aborted, true);
    assert.throws(() => deps.bitrix.request('crm.deal.update', {}), /запрещён/);
  } finally { deps.close(); }
});

test('отмена Polza не запускает повтор после остановки', async () => {
  const controller = new AbortController(), seen = [];
  const deps = createPilotDependencies({ ...base, signal: controller.signal, fetchImpl: hangingFetch(seen) });
  try {
    const pending = deps.llm.complete({ model: 'mock', messages: [] });
    while (!seen.length) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].aborted, true);
  } finally { deps.close(); }
});

test('отмена закрывает незавершённый локальный HTTP-запрос STT', async () => {
  const controller = new AbortController();
  let onRequest;
  const requested = new Promise(resolve => { onRequest = resolve; });
  const server = createServer((req, res) => { req.resume(); onRequest(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'otkazy-pilot-abort-'));
  const deps = createPilotDependencies({ ...base, signal: controller.signal, tempRoot: directory,
    sttUrl: `http://127.0.0.1:${server.address().port}`,
    async fetchImpl(_url, options) {
      assert.equal(options.signal.aborted, false);
      return new Response(Buffer.alloc(2048), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  try {
    const pending = deps.transcribe({ channel_count: 2, activity_id: 42, download_url: 'https://example.invalid/audio.mp3' });
    await requested;
    controller.abort();
    await assert.rejects(pending);
  } finally {
    deps.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rmdir(directory);
  }
});
