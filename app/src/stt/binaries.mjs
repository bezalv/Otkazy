import { createRequire } from 'node:module';
import { accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const packages = { ffmpeg: 'ffmpeg-static', ffprobe: '@derhuerst/ffprobe-static' };
const linuxPackages = { ffmpeg: '@ffmpeg-installer/linux-x64', ffprobe: '@ffprobe-installer/linux-x64' };

// В Linux бинарник включён в npm-пакет: `npm ci --ignore-scripts` не зависит
// от временной доступности GitHub и не запускает сторонние install-скрипты.
// На других платформах Linux-пакеты не используются, даже если они присутствуют.
export function resolveLinuxRegistryBinary(name, { platform = process.platform, arch = process.arch,
  resolvePackage = value => require.resolve(value), checkExecutable = value => accessSync(value, constants.X_OK) } = {}) {
  if (!Object.hasOwn(linuxPackages, name)) throw new TypeError('Неизвестный аудиоинструмент');
  if (platform !== 'linux' || arch !== 'x64') return null;
  try {
    const packageFile = resolvePackage(`${linuxPackages[name]}/package.json`);
    const binary = join(dirname(packageFile), name);
    checkExecutable(binary);
    return binary;
  } catch { return null; }
}

// Явная настройка важнее встроенной зависимости; отсутствие пакета не мешает
// диагностике и вернёт имя исполняемого файла для поиска в PATH.
export function resolveBinary(name, env = process.env) {
  if (!Object.hasOwn(packages, name)) throw new TypeError('Неизвестный аудиоинструмент');
  const configured = env[name === 'ffmpeg' ? 'STT_FFMPEG_PATH' : 'STT_FFPROBE_PATH'];
  if (configured) return configured;
  // Предпочитаем первоначальную поставку 6.1.1, если она установлена и
  // исполняема. Доступность пакета сама по себе не доказывает наличие файла.
  let legacyBinary = null;
  try {
    const value = require(packages[name]);
    if (typeof value === 'string' && value) {
      legacyBinary = value;
      accessSync(value, constants.X_OK);
      return value;
    }
  } catch { /* Нет исходного бинарника — пробуем автономную поставку. */ }
  const registryBinary = resolveLinuxRegistryBinary(name);
  if (registryBinary) return registryBinary;
  return legacyBinary || name;
}
