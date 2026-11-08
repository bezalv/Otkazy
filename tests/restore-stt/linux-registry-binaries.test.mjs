import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { resolveBinary, resolveLinuxRegistryBinary } from '../../app/src/stt/binaries.mjs';

test('Linux x64 использует бинарники из соответствующего npm-пакета', () => {
  for (const [name, packageName] of [['ffmpeg', '@ffmpeg-installer/linux-x64'], ['ffprobe', '@ffprobe-installer/linux-x64']]) {
    const descriptor = join('example', 'node_modules', packageName, 'package.json');
    let checked;
    const result = resolveLinuxRegistryBinary(name, { platform: 'linux', arch: 'x64',
      resolvePackage(value) { assert.equal(value, `${packageName}/package.json`); return descriptor; },
      checkExecutable(value) { checked = value; },
    });
    assert.equal(result, join(dirname(descriptor), name));
    assert.equal(checked, result);
  }
});

test('на Windows и иной архитектуре Linux-пакеты не используются', () => {
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'arm64'], ['darwin', 'x64']]) {
    assert.equal(resolveLinuxRegistryBinary('ffmpeg', { platform, arch,
      resolvePackage() { assert.fail('Не искать Linux-пакет на неподходящей платформе'); },
    }), null);
  }
});

test('отсутствующий или неисполняемый пакет не считается работоспособным', () => {
  assert.equal(resolveLinuxRegistryBinary('ffprobe', { platform: 'linux', arch: 'x64',
    resolvePackage() { throw new Error('missing'); },
  }), null);
  assert.equal(resolveLinuxRegistryBinary('ffprobe', { platform: 'linux', arch: 'x64',
    resolvePackage() { return join('package', 'package.json'); },
    checkExecutable() { throw new Error('not executable'); },
  }), null);
});

test('явные пути в окружении важнее всех пакетов', () => {
  assert.equal(resolveBinary('ffmpeg', { STT_FFMPEG_PATH: 'my-ffmpeg' }), 'my-ffmpeg');
  assert.equal(resolveBinary('ffprobe', { STT_FFPROBE_PATH: 'my-ffprobe' }), 'my-ffprobe');
  assert.throws(() => resolveBinary('unknown', {}), TypeError);
});
