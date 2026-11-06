import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { buildSttEnv, cleanupStaleAudio, startSttService } from '../../app/src/stt/child.mjs';

test('дочерний сервис не получает секреты Битрикса и базы', () => {
  const env = buildSttEnv({ env: { PATH: 'fixture-path', DATABASE_URL: 'secret', BITRIX_REST_BASE: 'secret', NODE_OPTIONS: 'untrusted' },
    port: 1234, key: 'fixture-key', polzaKey: 'fixture-polza' });
  assert.equal(env.PATH, 'fixture-path');
  assert.equal(env.STT_KEY, 'fixture-key');
  assert.equal(env.POLZA_API_KEY, 'fixture-polza');
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.BITRIX_REST_BASE, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test('локальный резервный сервис стартует с отдельным ключом и выключается', async () => {
  const service = await startSttService({ polzaKey: 'test-only' });
  try {
    assert.match(service.address, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(service.key.length >= 24);
    const response = await fetch(`${service.address}/v1/transcribe?test=1&channels=mono`, {
      method: 'POST', headers: { 'X-STT-Key': service.key },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.model, 'ai-sage/gigaam-v3');
    assert.equal(body.channels, 1);
  } finally { await service.close(); }
  assert.equal(await service.healthy(), false);
  await assert.rejects(fetch(`${service.address}/health`));
  await assert.rejects(readFile(join(service.tempRoot, 'recording')), { code: 'ENOENT' });
});

test('уже отменённый сигнал не запускает STT', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(startSttService({ polzaKey: 'test-only', signal: controller.signal }), { name: 'AbortError' });
});

test('отмена во время старта останавливает процесс до возврата ошибки', async () => {
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  let onRequest;
  const requestSeen = new Promise(resolve => { onRequest = resolve; });
  let address;
  globalThis.fetch = (url, { signal } = {}) => new Promise((_, reject) => {
    address = String(url);
    onRequest();
    const stop = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  });
  try {
    const startup = startSttService({ polzaKey: 'test-only', signal: controller.signal });
    startup.catch(() => {});
    await requestSeen;
    controller.abort();
    await assert.rejects(startup, { name: 'AbortError' });
  } finally { globalThis.fetch = originalFetch; }
  assert.match(address, /^http:\/\/127\.0\.0\.1:\d+\/health$/);
  await assert.rejects(fetch(address));
});

test('отмена после старта разделяет один результат подтверждённого закрытия', async () => {
  const controller = new AbortController();
  const service = await startSttService({ polzaKey: 'test-only', signal: controller.signal });
  controller.abort();
  await Promise.all([service.close(), service.close()]);
  assert.equal(await service.healthy(), false);
  await assert.rejects(fetch(`${service.address}/health`));
});

test('на Linux закрытие проверяет отсутствие всей группы, а не только лидера', { skip: process.platform !== 'linux' }, async () => {
  const service = await startSttService({ polzaKey: 'test-only' });
  const run = join(service.tempRoot, '..');
  const marker = JSON.parse(await readFile(join(run, '.owner.json'), 'utf8'));
  const originalKill = process.kill;
  let checked = false;
  process.kill = function (pid, signal) {
    if (pid === -marker.childPid && signal === 0) checked = true;
    return originalKill.call(process, pid, signal);
  };
  try { await service.close(); } finally { process.kill = originalKill; }
  assert.equal(checked, true);
  assert.throws(() => process.kill(-marker.childPid, 0), error => error.code === 'ESRCH');
});

test('на Linux отсутствие подтверждения группы не выдаётся за успешное закрытие', { skip: process.platform !== 'linux' }, async () => {
  const service = await startSttService({ polzaKey: 'test-only' });
  const run = join(service.tempRoot, '..');
  const marker = JSON.parse(await readFile(join(run, '.owner.json'), 'utf8'));
  const originalKill = process.kill;
  process.kill = function (pid, signal) {
    if (pid === -marker.childPid && signal === 0) throw Object.assign(new Error('нельзя проверить'), { code: 'EPERM' });
    return originalKill.call(process, pid, signal);
  };
  try { await assert.rejects(service.close(), /ещё работают/); } finally { process.kill = originalKill; }
  // Тест сам удаляет пустой каталог только после настоящего подтверждения ESRCH.
  assert.throws(() => process.kill(-marker.childPid, 0), error => error.code === 'ESRCH');
  await rmdir(service.tempRoot);
  await rmdir(join(run, 'service'));
  await unlink(join(run, '.owner.json'));
  await rmdir(run);
});

test('удаляются только старые каталоги без живого родителя и дочернего процесса', async () => {
  const base = await mkdtemp(join(tmpdir(), 'otkazy-clean-test-'));
  const rel = relative(tmpdir(), base);
  assert.ok(rel && !rel.startsWith('..'));
  try {
    const root = join(base, 'otkazy-stt-runtime-v1');
    await mkdir(root, { mode: 0o700 });
    const nowMs = Date.parse('2026-11-05T00:00:00Z');
    async function fixture(name, marker, extra = null) {
      const run = join(root, `run-${name.repeat(32)}`);
      await mkdir(run, { mode: 0o700 });
      await mkdir(join(run, 'service'));
      await mkdir(join(run, 'client'));
      await mkdir(join(run, 'client', 'otkazy-audio-ABC123'));
      await writeFile(join(run, 'service', 'abcdef123456.in'), 'аудио');
      await writeFile(join(run, 'client', 'otkazy-audio-ABC123', 'recording'), 'аудио');
      await writeFile(join(run, '.owner.json'), JSON.stringify(marker), { mode: 0o600 });
      if (extra) await writeFile(join(run, 'service', extra), 'чужой файл');
      return run;
    }
    const old = { version: 1, parentPid: 1111, childPid: 2222, pidNamespace: 'test-pid-namespace', isolatedProcessGroup: true, createdAt: nowMs - 2 * 86400000 };
    const stale = await fixture('a', old);
    const active = await fixture('b', { ...old, parentPid: process.pid });
    const unknown = await fixture('c', old, 'do-not-delete.txt');
    const incomplete = await fixture('d', { ...old, childPid: null });
    const fresh = await fixture('e', { ...old, createdAt: nowMs - 60000 });
    const otherNamespace = await fixture('f', { ...old, pidNamespace: 'other-namespace' });
    const runningGroup = await fixture('0', { ...old, childPid: 3333 });
    const removed = await cleanupStaleAudio({ base, nowMs, namespace: 'test-pid-namespace', isDead: pid => [1111, 2222, 3333].includes(pid), isGroupDead: pid => pid === 2222 });
    assert.equal(removed, 1);
    await assert.rejects(readFile(join(stale, '.owner.json')), { code: 'ENOENT' });
    for (const run of [active, unknown, incomplete, fresh, otherNamespace, runningGroup]) {
      assert.equal(await readFile(join(run, 'service', 'abcdef123456.in'), 'utf8'), 'аудио');
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});
