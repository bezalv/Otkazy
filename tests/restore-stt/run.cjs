'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

const servicePath = path.resolve(__dirname, '../../app/src/stt/server.cjs');
const testKey = 'test-key-for-local-stt-only';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('локальный сервис сохраняет договор и использует отдельный порт', async t => {
  const port = await freePort();
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'otkazy-stt-test-'));
  const service = spawn(process.execPath, [servicePath], {
    env: {
      ...process.env,
      STT_KEY: testKey,
      STT_BIND: '127.0.0.1',
      STT_PORT: String(port),
      PORT: '1',
      WORK_DIR: work,
      LOG_FILE: path.join(work, 'service.log'),
      RESERVE_MODEL: 'gigaam'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let errors = '';
  service.stderr.on('data', chunk => { errors += chunk.toString(); });
  t.after(async () => {
    if (service.exitCode === null) {
      const exited = new Promise(resolve => service.once('exit', resolve));
      service.kill();
      await exited;
    }
    await fs.rm(work, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (service.exitCode !== null) assert.fail(`STT завершился при запуске: ${errors}`);
    try {
      health = await fetch(`${base}/health`);
      break;
    } catch {
      await delay(50);
    }
  }
  assert.ok(health, `STT не запустился: ${errors}`);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.model, 'ai-sage/gigaam-v3');
  assert.equal(healthBody.max_tasks, 3);

  const unauthorized = await fetch(`${base}/v1/transcribe?test=1`, { method: 'POST' });
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, 'unauthorized');

  for (const [mode, expectedChannels] of [['stereo', 2], ['mono', 1]]) {
    const response = await fetch(`${base}/v1/transcribe?test=1&channels=${mode}`, {
      method: 'POST',
      headers: { 'X-STT-Key': testKey }
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.test, true);
    assert.equal(result.channels, expectedChannels);
    assert.equal(result.model, 'ai-sage/gigaam-v3');
    assert.equal(result.segments.length, 6);
    assert.ok(result.segments.every(segment => segment.channel < expectedChannels));
  }

  const invalid = await fetch(`${base}/v1/transcribe?test=1&channels=invalid`, {
    method: 'POST',
    headers: { 'X-STT-Key': testKey }
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'bad_request');

  const empty = await fetch(`${base}/v1/transcribe`, {
    method: 'POST',
    headers: { 'X-STT-Key': testKey }
  });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, 'bad_request');
});

async function launchMock(t, scenario, model = 'gigaam') {
  const port = await freePort();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'otkazy-stt-mock-'));
  const work = path.join(temp, 'audio');
  const preload = path.join(__dirname, 'mock-dependencies.cjs');
  const service = spawn(process.execPath, ['--require', preload, servicePath], {
    env: {
      ...process.env,
      STT_KEY: testKey,
      STT_BIND: '127.0.0.1',
      STT_PORT: String(port),
      STT_FFMPEG_PATH: 'ffmpeg',
      STT_FFPROBE_PATH: 'ffprobe',
      STT_TEST_SCENARIO: scenario,
      POLZA_API_KEY: 'mock-only',
      WORK_DIR: work,
      LOG_FILE: path.join(temp, 'service.log'),
      RESERVE_MODEL: model,
      REQUEST_TIMEOUT_SEC: '2'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let errors = '';
  service.stderr.on('data', chunk => { errors += chunk.toString(); });
  t.after(async () => {
    if (service.exitCode === null) {
      const exited = new Promise(resolve => service.once('exit', resolve));
      service.kill();
      await exited;
    }
    await fs.rm(temp, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (service.exitCode !== null) assert.fail(`STT завершился при запуске: ${errors}`);
    try {
      started = (await fetch(`${base}/health`)).ok;
      if (started) break;
    } catch { /* процесс ещё запускается */ }
    await delay(50);
  }
  assert.ok(started, `STT не запустился: ${errors}`);
  return { base, work, service };
}

async function mockTranscribe(base) {
  const response = await fetch(`${base}/v1/transcribe`, {
    method: 'POST',
    headers: { 'X-STT-Key': testKey },
    body: 'test audio'
  });
  return { status: response.status, body: await response.json() };
}

for (const scenario of ['invalid_json', 'missing_text']) {
  test(`gigaam: ${scenario} остаётся техническим сбоем`, async t => {
    const { base } = await launchMock(t, scenario);
    const result = await mockTranscribe(base);
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, 'provider_error');
    assert.equal(result.body.error.retryable, true);
  });
}

for (const scenario of ['silence', 'empty_text']) {
  test(`gigaam: ${scenario} допустима как пустая речь`, async t => {
    const { base } = await launchMock(t, scenario);
    const result = await mockTranscribe(base);
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.deepEqual(result.body.segments, []);
  });
}

for (const scenario of ['aiesa_missing_segments', 'aiesa_bad_segments', 'invalid_json', 'aiesa_poll_invalid']) {
  test(`aiesa: ${scenario} остаётся техническим сбоем`, async t => {
    const { base } = await launchMock(t, scenario, 'aiesa');
    const result = await mockTranscribe(base);
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, 'provider_error');
    assert.equal(result.body.error.retryable, true);
  });
}

test('aiesa: пустой массив сегментов допустим', async t => {
  const { base } = await launchMock(t, 'aiesa_empty', 'aiesa');
  const result = await mockTranscribe(base);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.segments, []);
});

for (const scenario of ['mkdir_failure', 'write_failure']) {
  test(`ошибка ${scenario} не завершает процесс`, async t => {
    const { base, service } = await launchMock(t, scenario);
    const result = await mockTranscribe(base);
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'storage_error');
    assert.equal(result.body.error.retryable, true);
    assert.equal(service.exitCode, null);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).in_flight, 0);
  });
}

test('ошибка подготовки второго канала удаляет обе дорожки', async t => {
  const { base, work } = await launchMock(t, 'second_track_failure');
  const result = await mockTranscribe(base);
  assert.equal(result.status, 500);
  assert.deepEqual(await fs.readdir(work), []);
});

test('сервис дожидается второго ffmpeg перед удалением файлов', async t => {
  const { base, work } = await launchMock(t, 'slow_peer');
  const result = await mockTranscribe(base);
  assert.equal(result.status, 502);
  assert.equal(await fs.readFile(path.join(work, 'peer-complete.flag'), 'utf8'), 'done');
  assert.deepEqual(await fs.readdir(work), ['peer-complete.flag']);
});
