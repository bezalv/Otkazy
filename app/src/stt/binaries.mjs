import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packages = { ffmpeg: 'ffmpeg-static', ffprobe: '@derhuerst/ffprobe-static' };

// Явная настройка важнее встроенной зависимости; отсутствие пакета не мешает
// диагностике и вернёт имя исполняемого файла для поиска в PATH.
export function resolveBinary(name, env = process.env) {
  if (!Object.hasOwn(packages, name)) throw new TypeError('Неизвестный аудиоинструмент');
  const configured = env[name === 'ffmpeg' ? 'STT_FFMPEG_PATH' : 'STT_FFPROBE_PATH'];
  if (configured) return configured;
  try {
    const value = require(packages[name]);
    return typeof value === 'string' && value ? value : name;
  } catch { return name; }
}
