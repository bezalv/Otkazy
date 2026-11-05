import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { prepareRuntime } from '../../app/src/runtime.mjs';
import { createWorkerDependencies } from '../../app/src/worker/dependencies.mjs';

test('клиент worker действительно отправляет запрос через переданный ограничитель', async () => {
  const scheduled = [];
  const limiter = { schedule(method, task) { scheduled.push(method); return task(); }, observeSuccess() {} };
  const dependencies = createWorkerDependencies({ pool: { query() {}, connect() {} },
    bitrixBaseUrl: 'https://example.invalid/rest/1/test/', polzaKey: 'fixture',
    sttUrl: 'http://127.0.0.1:8790', sttKey: 'fixture', tempRoot: tmpdir(),
    judgePrompt: 'промпт', writerPrompt: 'промпт', bitrixLimiter: limiter,
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: true }) }),
  });
  assert.equal((await dependencies.bitrix.request('user.current')).result, true);
  assert.deepEqual(scheduled, ['user.current']);
});

test('runtime передаёт общий ограничитель в зависимости обработчика', async () => {
  const limiter = {};
  let received;
  const runtime = await prepareRuntime({ pool: {}, polzaKey: 'fixture', bitrixLimiter: limiter,
    loadText: async () => 'промпт', checkTools: async () => ({ ok: true }),
    startStt: async () => ({ healthy: async () => true, close: async () => {} }),
    makeDependencies: options => { received = options.bitrixLimiter; return { pump: {} }; },
  });
  assert.equal(received, limiter);
  await runtime.close();
});

test('подготовка runtime не запускает задания и корректно останавливает STT', async () => {
  let closed = false;
  const forbidden = () => assert.fail('не должно быть сетевых или SQL-запросов');
  const runtime = await prepareRuntime({ pool: { query: forbidden, connect: forbidden },
    bitrixBaseUrl: 'https://example.invalid/rest/1/test/', polzaKey: 'fixture', fetchImpl: forbidden,
    loadText: async () => 'тестовый промпт', checkTools: async () => ({ ok: true }),
    startStt: async () => ({ address: 'http://127.0.0.1:8790', key: 'test-only', tempRoot: tmpdir(), healthy: async () => true, close: async () => { closed = true; } }),
  });
  assert.equal(typeof runtime.tick, 'function');
  assert.equal(typeof runtime.nightly, 'function');
  await runtime.close();
  assert.equal(closed, true);
});

test('ошибка конфигурации после старта останавливает дочерний сервис', async () => {
  let closed = false;
  await assert.rejects(prepareRuntime({ pool: {}, polzaKey: 'fixture', loadText: async () => 'промпт', checkTools: async () => ({ ok: true }),
    startStt: async () => ({ address: 'http://127.0.0.1:8790', key: 'x', healthy: async () => true, close: async () => { closed = true; } }),
  }), /пул/i);
  assert.equal(closed, true);
});

test('неработающий STT не позволяет захватывать задания', async () => {
  let touched = false;
  const runtime = await prepareRuntime({ pool: {}, bitrixBaseUrl: 'fixture', polzaKey: 'fixture',
    loadText: async () => 'промпт', checkTools: async () => ({ ok: true }),
    startStt: async () => ({ healthy: async () => false, close: async () => {} }),
    makeDependencies: () => ({ pump: { async tick() { touched = true; } } }),
  });
  assert.deepEqual(await runtime.tick(), { status: 'stt_unavailable' });
  assert.equal(touched, false);
  await runtime.close();
});

test('завершение дожидается активного задания до остановки STT', async () => {
  let release, began, closed = false;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  const runtime = await prepareRuntime({ pool: {}, bitrixBaseUrl: 'fixture', polzaKey: 'fixture',
    loadText: async () => 'промпт', checkTools: async () => ({ ok: true }),
    startStt: async () => ({ healthy: async () => true, close: async () => { closed = true; } }),
    makeDependencies: () => ({ pump: { async tick() { began(); await gate; return { status: 'done' }; } } }),
  });
  const work = runtime.tick();
  await started;
  const stopping = runtime.close();
  assert.equal(closed, false);
  await assert.rejects(runtime.tick(), /завершает/);
  release();
  await work;
  assert.deepEqual(await stopping, { status: 'drained' });
  assert.equal(closed, true);
});

test('истечение grace period не убивает активное задание и сервис закрывается после его завершения', async () => {
  let release, began, closes = 0, ticks = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  const runtime = await prepareRuntime({ pool: {}, bitrixBaseUrl: 'fixture', polzaKey: 'fixture',
    loadText: async () => 'промпт', checkTools: async () => ({ ok: true }),
    startStt: async () => ({ healthy: async () => true, close: async () => { closes++; } }),
    makeDependencies: () => ({ pump: { async tick() { ticks++; began(); await gate; return { status: 'done' }; } } }),
  });
  const work = runtime.tick();
  await started;
  assert.deepEqual(await runtime.close({ graceMs: 20 }), { status: 'timeout' });
  assert.equal(closes, 0);
  await assert.rejects(runtime.tick(), /завершает/);
  assert.equal(ticks, 1);
  release();
  await work;
  assert.deepEqual(await runtime.close({ graceMs: 1000 }), { status: 'drained' });
  assert.equal(closes, 1);
});
