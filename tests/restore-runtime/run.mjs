import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer, checkRuntime } from '../../app/src/server.mjs';

test('setup отвечает на health, но не объявляет себя готовым', async t => {
  const server = createAppServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await health.json(), { ok: true, mode: 'setup', ready: false });
  const ready = await fetch(`${base}/ready`);
  assert.equal(ready.status, 503);
  assert.equal((await ready.json()).ready, false);
  assert.equal((await fetch(`${base}/v1/transcribe`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/unknown`)).status, 404);
});

test('проверка бинарников различает отсутствие, подмену и рабочий ffmpeg', async () => {
  const execute = async (path, args) => {
    assert.deepEqual(args, ['-version']);
    if (path === 'missing') throw new Error('sensitive path');
    return { stdout: `${path} version 1` };
  };
  assert.deepEqual(await checkRuntime({ execute, env: {}, nodeVersion: '24.14.0' }),
    { ok: true, node: true, ffmpeg: true, ffprobe: true, ready: false });
  const bad = await checkRuntime({ execute, env: { STT_FFMPEG_PATH: 'missing', STT_FFPROBE_PATH: 'other' }, nodeVersion: '23.9.0' });
  assert.deepEqual(bad, { ok: false, node: false, ffmpeg: false, ffprobe: false, ready: false });
  assert.doesNotMatch(JSON.stringify(bad), /sensitive|missing/);
});
