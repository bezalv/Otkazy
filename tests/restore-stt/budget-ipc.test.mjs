import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSttEnv, startSttService } from '../../app/src/stt/child.mjs';
import { resolveBinary } from '../../app/src/stt/binaries.mjs';

const exec = promisify(execFile);

test('ручной бюджетный IPC не передаёт ключ провайдера и задаёт одну задачу', () => {
  const env = buildSttEnv({ env: { MAX_TASKS: '9', STT_BUDGET_IPC: '0', POLZA_API_KEY: 'secret' },
    port: 1234, key: 'fixture-key', polzaKey: 'secret', budgetIpc: true });
  assert.equal(env.POLZA_API_KEY, undefined);
  assert.equal(env.STT_BUDGET_IPC, '1');
  assert.equal(env.MAX_TASKS, '1');
  const normal = buildSttEnv({ env: { STT_BUDGET_IPC: '1' }, port: 1234, key: 'fixture-key', polzaKey: 'secret' });
  assert.equal(normal.STT_BUDGET_IPC, undefined);
  assert.equal(normal.POLZA_API_KEY, 'secret');
});

async function fixture(channels = 1, seconds = 1.2) {
  const dir = await mkdtemp(join(tmpdir(), 'otkazy-stt-ipc-test-'));
  const file = join(dir, 'sample.wav');
  try {
    await exec(resolveBinary('ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      `sine=frequency=440:sample_rate=16000:duration=${seconds}`, '-ac', String(channels), file], { timeout: 30000, windowsHide: true });
    return { dir, bytes: await readFile(file) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

test('настоящий ffmpeg передаёт фрагмент только ручному транспорту', async () => {
  const sample = await fixture(), controller = new AbortController();
  let calls = 0, received = 0;
  const service = await startSttService({ polzaKey: 'not-sent-to-child', signal: controller.signal,
    env: { ...process.env, LOG_FILE: join(sample.dir, 'stt.log') },
    budgetTransport: async ({ audio, model, signal }) => {
      signal.throwIfAborted(); calls++; received += audio.length;
      assert.equal(model, 'ai-sage/gigaam-v3'); assert.ok(Buffer.isBuffer(audio));
      return { text: 'моковая реплика', usage: { cost_rub: 0 } };
    } });
  try {
    const health = await (await fetch(`${service.address}/health`)).json();
    assert.equal(health.max_tasks, 1);
    const response = await fetch(`${service.address}/v1/transcribe?channels=mono`, {
      method: 'POST', headers: { 'X-STT-Key': service.key }, body: sample.bytes,
    });
    const result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.retries, 0);
    assert.equal(calls, 1); assert.ok(received > 0);
    assert.equal(result.segments[0].text, 'моковая реплика');
  } finally { await service.close(); sample.bytes.fill(0); await rm(sample.dir, { recursive: true, force: true }); }
});

test('ошибка бюджетного транспорта останавливает оба канала без повтора', async () => {
  const sample = await fixture(2), controller = new AbortController(); let calls = 0;
  const service = await startSttService({ polzaKey: 'not-sent-to-child', signal: controller.signal,
    env: { ...process.env, LOG_FILE: join(sample.dir, 'stt.log') },
    budgetTransport: async () => { calls++; throw new Error('неподтверждённый исход'); } });
  try {
    const response = await fetch(`${service.address}/v1/transcribe?channels=stereo`, {
      method: 'POST', headers: { 'X-STT-Key': service.key }, body: sample.bytes,
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.retryable, false);
    assert.equal(calls, 1);
  } finally { await service.close(); sample.bytes.fill(0); await rm(sample.dir, { recursive: true, force: true }); }
});

test('отмена прерывает ожидающий бюджетный вызов и закрывает STT', async () => {
  const sample = await fixture(), controller = new AbortController();
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const service = await startSttService({ polzaKey: 'not-sent-to-child', signal: controller.signal,
    env: { ...process.env, LOG_FILE: join(sample.dir, 'stt.log') },
    budgetTransport: async ({ signal }) => new Promise((resolve, reject) => {
      entered(); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }) });
  try {
    const work = fetch(`${service.address}/v1/transcribe?channels=mono`, {
      method: 'POST', headers: { 'X-STT-Key': service.key }, body: sample.bytes,
    }).catch(() => null);
    await started; controller.abort();
    await service.close(); await work;
    assert.equal(await service.healthy(), false);
  } finally { await service.close(); sample.bytes.fill(0); await rm(sample.dir, { recursive: true, force: true }); }
});

test('обрыв клиента после приёма тела отменяет бюджетный вызов и остальные каналы', async () => {
  const sample = await fixture(2), controller = new AbortController(), client = new AbortController();
  let entered, cancelled, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const transportCancelled = new Promise(resolve => { cancelled = resolve; });
  const service = await startSttService({ polzaKey: 'not-sent-to-child', signal: controller.signal,
    env: { ...process.env, LOG_FILE: join(sample.dir, 'stt.log') },
    budgetTransport: async ({ signal }) => new Promise((resolve, reject) => {
      calls++; entered(); signal.addEventListener('abort', () => { cancelled(); reject(new Error('cancelled')); }, { once: true });
    }) });
  try {
    const work = fetch(`${service.address}/v1/transcribe?channels=stereo`, {
      method: 'POST', headers: { 'X-STT-Key': service.key }, body: sample.bytes, signal: client.signal,
    }).catch(() => null);
    await started; client.abort();
    await Promise.race([transportCancelled, new Promise((_, reject) => setTimeout(() => reject(new Error('отмена транспорта не пришла')), 3000))]);
    await work;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(calls, 1);
    assert.equal(controller.signal.aborted, false);
    assert.equal(await service.healthy(), true);
  } finally { await service.close(); sample.bytes.fill(0); await rm(sample.dir, { recursive: true, force: true }); }
});

test('обрыв клиента во время нарезки завершает ffmpeg и не отправляет текущий фрагмент', { timeout: 30000 }, async () => {
  const sample = await fixture(1, 600), controller = new AbortController(), client = new AbortController();
  let calls = 0;
  const service = await startSttService({ polzaKey: 'not-sent-to-child', signal: controller.signal,
    env: { ...process.env, LOG_FILE: join(sample.dir, 'stt.log') },
    budgetTransport: async () => { calls++; return { text: 'моковая реплика' }; } });
  let closure;
  try {
    const work = fetch(`${service.address}/v1/transcribe?channels=mono`, {
      method: 'POST', headers: { 'X-STT-Key': service.key }, body: sample.bytes, signal: client.signal,
    }).catch(() => null);
    const until = Date.now() + 15000;
    let found = false;
    while (Date.now() < until) {
      const response = await fetch(`${service.address}/health`);
      const health = await response.json();
      if (health.ffmpeg_chunk_running > 0) { found = true; break; }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(found, true, 'не удалось обнаружить работающую нарезку');
    const beforeCancel = calls;
    client.abort();
    await work;
    const toolDeadline = Date.now() + 3000;
    let toolStopped = false;
    while (Date.now() < toolDeadline) {
      const health = await (await fetch(`${service.address}/health`)).json();
      if (health.tool_running === 0) { toolStopped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(toolStopped, true, 'ffmpeg не завершился после отмены');
    assert.equal(controller.signal.aborted, false);
    closure = await service.close().then(() => 'confirmed', error => {
      assert.match(error.message, /Не подтверждена остановка процессов аудио/); return 'unconfirmed';
    });
    assert.equal(calls, beforeCancel);
    assert.equal(closure, process.platform === 'linux' ? 'confirmed' : 'unconfirmed');
  } finally {
    if (!closure) await service.close().catch(() => {});
    // На Windows намеренно не заявляем cleanup доказанным, если при остановке
    // был запущен инструмент. Удаляем только пустые каталоги теста и marker.
    if (closure === 'unconfirmed') {
      const run = join(service.tempRoot, '..');
      await rmdir(service.tempRoot);
      await rmdir(join(run, 'service'));
      await unlink(join(run, '.owner.json'));
      await rmdir(run);
    }
    sample.bytes.fill(0); await rm(sample.dir, { recursive: true, force: true });
  }
});
