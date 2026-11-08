// Необязательное восстановление исходных статических бинарников 6.1.1.
// Если зеркало недоступно, приложение использует бинарники из npm registry.
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, rename, unlink } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { resolveBinary } from './binaries.mjs';

const require = createRequire(import.meta.url);
const MAX_GZIP = 40_000_000;
const MAX_BINARY = 100_000_000;
const items = [
  { name: 'ffmpeg', pkg: 'ffmpeg-static', gzipSha: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
    binarySize: 79826272, binarySha: 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99' },
  { name: 'ffprobe', pkg: '@derhuerst/ffprobe-static', gzipSha: '25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067',
    binarySize: 79665792, binarySha: '4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d' },
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** До распаковки и после неё проверяются зафиксированные хеши и пределы. */
export async function downloadVerified(item, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const url = `https://cdn.npmmirror.com/binaries/ffmpeg-static/b6.1.1/${item.name}-linux-x64.gz`;
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Зеркало недоступно');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_GZIP)) {
    await response.body.cancel().catch(() => {});
    throw new Error('Некорректный размер архива');
  }
  const chunks = []; let size = 0;
  try {
    for await (const input of response.body) {
      const chunk = Buffer.from(input); size += chunk.length;
      if (size > MAX_GZIP) { chunk.fill(0); throw new Error('Слишком большой архив'); }
      chunks.push(chunk);
    }
    if (!size || (declared !== null && size !== Number(declared))) throw new Error('Архив загружен не полностью');
    const compressed = Buffer.concat(chunks, size);
    if (sha(compressed) !== item.gzipSha) throw new Error('Хеш архива не совпадает');
    const binary = gunzipSync(compressed, { maxOutputLength: MAX_BINARY });
    if (binary.length !== item.binarySize || sha(binary) !== item.binarySha) throw new Error('Хеш бинарника не совпадает');
    return binary;
  } finally { for (const chunk of chunks) chunk.fill(0); }
}

async function installVerified(item) {
  // Назначение задаётся только фиксированными именами пакетов из этого файла.
  const dest = join(dirname(require.resolve(`${item.pkg}/package.json`)), item.name);
  const temporary = `${dest}.${randomBytes(12).toString('hex')}.tmp`;
  let handle;
  try {
    const binary = await downloadVerified(item);
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(binary);
    await handle.sync();
    await handle.chmod(0o755);
    await handle.close(); handle = null;
    await rename(temporary, dest);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error?.code !== 'ENOENT') throw error; });
  }
}

export async function installPreferred() {
  if (process.platform !== 'linux' || process.arch !== 'x64') return;
  for (const item of items) {
    try { await installVerified(item); console.log(`${item.name}: проверенная версия 6.1.1`); }
    catch { console.warn(`${item.name}: используется резервный бинарник npm`); }
  }
  // Отказ даже резервного пакета должен остановить сборку, а не оставить
  // приложение с ложной готовностью к распознаванию.
  for (const name of ['ffmpeg', 'ffprobe']) execFileSync(resolveBinary(name, {}), ['-version'], { stdio: 'ignore', timeout: 10000 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await installPreferred();
}
