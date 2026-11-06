import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveBinary } from './binaries.mjs';

const ALLOWED_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'NODE_ENV',
  'MAX_TASKS', 'QUEUE_MAX', 'REQUEST_TIMEOUT_SEC', 'MAX_FILE_MB', 'MAX_AUDIO_SEC',
  'LOG_FILE', 'LOGS_DIRECTORY',
];

const ROOT_NAME = 'otkazy-stt-runtime-v1';
const RUN_PATTERN = /^run-[a-f0-9]{32}$/;
const SERVICE_FILE = /^[a-f0-9]{12}(?:\.in|_(?:[01m]|c[01]_\d+)\.mp3)$/;
const CLIENT_DIR = /^otkazy-audio-[a-zA-Z0-9]{6}$/;
const STALE_MS = 24 * 60 * 60 * 1000;
function privatelyOwned(info) {
  return process.platform !== 'linux' || typeof process.getuid !== 'function'
    || (info.uid === process.getuid() && (info.mode & 0o077) === 0);
}

// Никогда не удаляем по вычисленному имени, пока оно не проверено внутри
// канонической директории temp. Не используем рекурсивное удаление.
function directChild(parent, name) {
  const child = resolve(parent, name);
  if (dirname(child) !== parent) throw new Error('Некорректная временная директория');
  return child;
}
async function tempRoot(base) {
  const system = await realpath(tmpdir());
  const actual = await realpath(base);
  const rel = relative(system, actual);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || resolve(actual) !== actual) throw new Error('Временная директория вне системной');
  const root = directChild(actual, ROOT_NAME);
  try { await mkdir(root, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || !privatelyOwned(info) || await realpath(root) !== root) throw new Error('Небезопасная временная директория');
  return root;
}
function processIsDead(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}
function processGroupIsDead(pid) {
  if (process.platform !== 'linux') return false;
  try { process.kill(-pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}
async function processNamespace() {
  // PID другого контейнера нельзя проверять через локальный kill(pid, 0).
  if (process.platform !== 'linux') return null;
  try {
    const value = await readlink('/proc/self/ns/pid');
    return /^pid:\[\d+\]$/.test(value) ? value : null;
  } catch { return null; }
}

// Возвращает только полностью проверенный набор путей. Неожиданные файлы,
// подкаталоги и ссылки оставляем без изменений для ручной диагностики.
async function knownContents(root, runName) {
  if (!RUN_PATTERN.test(runName)) return null;
  const run = directChild(root, runName);
  const st = await lstat(run);
  if (!st.isDirectory() || st.isSymbolicLink() || !privatelyOwned(st) || await realpath(run) !== run) return null;
  const entries = await readdir(run, { withFileTypes: true });
  if (entries.length > 3 || entries.some(e => !['service', 'client', '.owner.json'].includes(e.name))) return null;
  const files = [], dirs = [];
  for (const entry of entries) {
    const path = directChild(run, entry.name);
    if (entry.name === '.owner.json') {
      if (!entry.isFile() || entry.isSymbolicLink()) return null;
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    dirs.push(path);
    const children = await readdir(path, { withFileTypes: true });
    if (children.length > 5000) return null;
    for (const child of children) {
      const candidate = directChild(path, child.name);
      if (entry.name === 'service') {
        if (!child.isFile() || child.isSymbolicLink() || !SERVICE_FILE.test(child.name)) return null;
        files.push(candidate);
      } else {
        if (!child.isDirectory() || child.isSymbolicLink() || !CLIENT_DIR.test(child.name)) return null;
        const contents = await readdir(candidate, { withFileTypes: true });
        if (contents.some(f => f.name !== 'recording' || !f.isFile() || f.isSymbolicLink()) || contents.length > 1) return null;
        if (contents.length) files.push(directChild(candidate, 'recording'));
        dirs.push(candidate);
      }
    }
  }
  return { run, files, dirs: dirs.reverse(), marker: directChild(run, '.owner.json') };
}

async function clearKnownRun(root, runName) {
  const known = await knownContents(root, runName);
  if (!known) return false;
  try {
    for (const file of known.files) await unlink(file);
    for (const dir of known.dirs) await rmdir(dir);
    await unlink(known.marker).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await rmdir(known.run);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    return false;
  }
}

/** Удаляет лишь старые каталоги, когда отсутствие обоих процессов доказано ОС. */
export async function cleanupStaleAudio({ base = tmpdir(), nowMs = Date.now(), minAgeMs = STALE_MS,
  isDead = processIsDead, isGroupDead = processGroupIsDead, namespace } = {}) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(minAgeMs) || minAgeMs < STALE_MS
      || typeof isDead !== 'function' || typeof isGroupDead !== 'function') throw new TypeError('Некорректные параметры очистки');
  const root = await tempRoot(base);
  const currentNamespace = namespace === undefined ? await processNamespace() : namespace;
  if (typeof currentNamespace !== 'string' || !currentNamespace) return 0;
  let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !RUN_PATTERN.test(entry.name)) continue;
    try {
      const known = await knownContents(root, entry.name);
      if (!known) continue;
      const markerInfo = await lstat(known.marker);
      if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || !privatelyOwned(markerInfo) || markerInfo.size > 1024) continue;
      const marker = JSON.parse(await readFile(known.marker, 'utf8'));
      if (marker.version !== 1 || marker.pidNamespace !== currentNamespace || marker.isolatedProcessGroup !== true
        || !Number.isSafeInteger(marker.parentPid) || marker.parentPid <= 1
        || !Number.isSafeInteger(marker.childPid) || marker.childPid <= 1 || !Number.isFinite(marker.createdAt)
        || marker.createdAt > nowMs - minAgeMs) continue;
      if (!isDead(marker.parentPid) || !isDead(marker.childPid) || !isGroupDead(marker.childPid)) continue;
      if (await clearKnownRun(root, entry.name)) removed++;
    } catch { /* Неполный каталог не трогаем. */ }
  }
  return removed;
}

export function buildSttEnv({ env, port, key, polzaKey, workDir }) {
  const safe = Object.fromEntries(ALLOWED_ENV.filter(name => typeof env[name] === 'string').map(name => [name, env[name]]));
  return { ...safe, STT_BIND: '127.0.0.1', STT_PORT: String(port), STT_KEY: key, POLZA_API_KEY: polzaKey,
    RESERVE_MODEL: 'gigaam', STT_FFMPEG_PATH: resolveBinary('ffmpeg', env), STT_FFPROBE_PATH: resolveBinary('ffprobe', env),
    ...(workDir ? { WORK_DIR: workDir } : {}) };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function cancelled() {
  const error = new Error('Запуск сервиса распознавания отменён');
  error.name = 'AbortError';
  error.code = 'STT_CANCELLED';
  return error;
}

// Явный запуск: отдельно от импортирования приложения и только на loopback.
// При отмене после spawn close завершается только после проверки всей группы.
export async function startSttService({ polzaKey, timeoutMs = 10000, env = process.env, signal } = {}) {
  if (typeof polzaKey !== 'string' || !polzaKey) throw new TypeError('Не задан ключ Polza');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new TypeError('Некорректный таймаут запуска');
  if (signal != null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function')) throw new TypeError('Некорректный сигнал отмены');
  const checkCancelled = () => { if (signal?.aborted) throw cancelled(); };
  checkCancelled();
  const port = await freePort();
  checkCancelled();
  const key = randomBytes(32).toString('hex');
  const address = `http://127.0.0.1:${port}`;
  await cleanupStaleAudio();
  checkCancelled();
  const root = await tempRoot(tmpdir());
  checkCancelled();
  const runName = `run-${randomBytes(16).toString('hex')}`;
  const run = directChild(root, runName);
  const workDir = directChild(run, 'service');
  const clientTempRoot = directChild(run, 'client');
  const marker = directChild(run, '.owner.json');
  const pidNamespace = await processNamespace();
  checkCancelled();
  const isolatedProcessGroup = process.platform === 'linux';
  const createdAt = Date.now();
  await mkdir(run, { mode: 0o700 });
  try {
    checkCancelled();
    await mkdir(workDir, { mode: 0o700 });
    checkCancelled();
    await mkdir(clientTempRoot, { mode: 0o700 });
    checkCancelled();
    await writeFile(marker, JSON.stringify({ version: 1, parentPid: process.pid, childPid: null, pidNamespace, isolatedProcessGroup, createdAt }), { flag: 'wx', mode: 0o600 });
    checkCancelled();
  } catch (error) {
    await clearKnownRun(root, runName);
    throw error;
  }
  let child;
  try {
    checkCancelled();
    child = spawn(process.execPath, [fileURLToPath(new URL('./server.cjs', import.meta.url))], {
      env: buildSttEnv({ env, port, key, polzaKey, workDir }),
      stdio: 'ignore', windowsHide: true, detached: isolatedProcessGroup,
    });
  } catch (error) {
    await clearKnownRun(root, runName);
    throw error;
  }
  let failed = false;
  let stopping = false, unexpectedlyExited = false;
  child.once('error', () => { failed = true; });
  child.once('exit', () => { if (!stopping) unexpectedlyExited = true; });
  async function healthy() {
    if (failed || child.exitCode !== null || child.signalCode !== null) return false;
    try {
      const timeout = AbortSignal.timeout(1000);
      const response = await fetch(`${address}/health`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      const body = await response.json();
      return response.ok && body.ok === true && body.model === 'ai-sage/gigaam-v3'
        && !failed && child.exitCode === null && child.signalCode === null;
    } catch { return false; }
  }
  let closePromise;
  let markerUpdate = Promise.resolve();
  const onAbort = () => { close().catch(() => {}); };
  function close() {
    if (!closePromise) closePromise = (async () => {
      signal?.removeEventListener('abort', onAbort);
      const wasRunning = child.exitCode === null && child.signalCode === null && !failed;
      stopping = true;
      if (child.exitCode === null && child.signalCode === null && !failed) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await Promise.race([exited, delay(3000, undefined, { ref: false })]);
        if (child.exitCode === null && child.signalCode === null && !failed) {
          child.kill('SIGKILL');
          await Promise.race([exited, delay(3000, undefined, { ref: false })]);
        }
      }
      if (child.exitCode === null && child.signalCode === null && !failed) throw new Error('Не удалось остановить сервис распознавания');
      // После внезапной смерти Node у него могут остаться потомки ffmpeg.
      // На Linux проверяем всю выделенную группу; на других системах при
      // внезапном завершении не можем доказать отсутствие потомков.
      if (isolatedProcessGroup && child.pid && !processGroupIsDead(child.pid)) throw new Error('Процессы аудио ещё работают; временные файлы сохранены');
      if (!isolatedProcessGroup && (unexpectedlyExited || !wasRunning) && child.pid) throw new Error('Не подтверждена остановка потомков; временные файлы сохранены');
      // Запись маркера и отмена могут пересечься; не удаляем каталог до её
      // завершения, иначе поздняя запись оставила бы файл после очистки.
      await markerUpdate.catch(() => {});
      if (!await clearKnownRun(root, runName)) throw new Error('Не удалось очистить временный каталог распознавания');
    })();
    return closePromise;
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    checkCancelled();
    markerUpdate = writeFile(marker, JSON.stringify({ version: 1, parentPid: process.pid, childPid: child.pid ?? null, pidNamespace, isolatedProcessGroup, createdAt }), { mode: 0o600 });
    await markerUpdate;
    checkCancelled();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      checkCancelled();
      if (failed || child.exitCode !== null || child.signalCode !== null) throw new Error('Сервис распознавания не запустился');
      try {
        if (await healthy()) {
          checkCancelled();
          return { address, key, healthy, close, tempRoot: clientTempRoot };
        }
      } catch { /* локальный процесс ещё запускается */ }
      checkCancelled();
      await delay(50, undefined, signal ? { signal } : undefined);
    }
    throw new Error('Сервис распознавания не ответил при запуске');
  } catch (error) {
    await close();
    throw error;
  }
}
