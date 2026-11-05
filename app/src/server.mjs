import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

// Только диагностика процесса: отсутствие обработки явно отражается в readiness.
// Внешние сети, база, секреты и процессы транскрипции здесь не запускаются.
export function createAppServer() {
  return createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    const pathname = (req.url || '').split('?')[0];
    if (pathname === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, mode: 'setup', ready: false }));
      return;
    }
    if (pathname === '/ready') {
      res.writeHead(503);
      res.end(JSON.stringify({ ok: false, mode: 'setup', ready: false }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false }));
  });
}

// Не возвращаем путь бинарника или сырой текст ошибки в журналы и ответы.
export async function checkRuntime({ execute = execFileAsync, env = process.env, nodeVersion = process.versions.node } = {}) {
  const [major, minor] = String(nodeVersion).split('.').map(Number);
  const node = major === 24 && minor >= 14;
  async function binary(name, path) {
    try {
      const { stdout } = await execute(path, ['-version'], { timeout: 5000, maxBuffer: 65536, windowsHide: true });
      return String(stdout).toLowerCase().startsWith(name + ' version ');
    } catch { return false; }
  }
  const [ffmpeg, ffprobe] = await Promise.all([
    binary('ffmpeg', env.STT_FFMPEG_PATH || 'ffmpeg'),
    binary('ffprobe', env.STT_FFPROBE_PATH || 'ffprobe'),
  ]);
  return { ok: node && ffmpeg && ffprobe, node, ffmpeg, ffprobe, ready: false };
}

async function main() {
  if (process.argv.slice(2).includes('--check-runtime')) {
    const status = await checkRuntime();
    console.log(JSON.stringify(status));
    if (!status.ok) process.exitCode = 1;
    return;
  }
  const port = Number(process.env.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Некорректный PORT');
  const server = createAppServer();
  server.on('error', () => { console.error('Не удалось запустить HTTP-сервер'); process.exitCode = 1; });
  server.listen(port, process.env.HOST || '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Ошибка запуска приложения'); process.exitCode = 1; });
}
