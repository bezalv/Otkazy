import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const ffmpegPackage = resolve('tmp/fftools/node_modules/ffmpeg-static');
const ffprobePackage = resolve('tmp/fftools/node_modules/@derhuerst/ffprobe-static');
const available = existsSync(ffmpegPackage) && existsSync(ffprobePackage);
const exec = promisify(execFile);

test('настоящие ffmpeg и ffprobe обрабатывают тишину и стереосигнал без обращения к Polza', { skip: !available }, async t => {
  const ffmpeg = require(ffmpegPackage), ffprobe = require(ffprobePackage);
  const work = await mkdtemp(join(tmpdir(), 'otkazy-real-audio-'));
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const key = 'test-local-stt-key-24-symbols';
  const child = spawn(process.execPath, ['app/src/stt/server.cjs'], { env: {
    ...process.env, STT_KEY: key, STT_BIND: '127.0.0.1', STT_PORT: String(port),
    STT_FFMPEG_PATH: ffmpeg, STT_FFPROBE_PATH: ffprobe, WORK_DIR: work,
    LOG_FILE: join(work, 'service.log'), POLZA_API_KEY: 'test-only', RESERVE_MODEL: 'gigaam',
    OTKAZY_MOCK_EMPTY_EVERY: '2',
    NODE_OPTIONS: `--require=${resolve('tests/restore-stt/mock-polza-only.cjs')}`,
  }, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    await rm(work, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Сервис завершился при запуске');
    try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; if (ready) break; } catch { /* ожидаем старт */ }
    await delay(50);
  }
  assert.equal(ready, true);
  for (const [name, channels, layout, codec] of [
    ['silence.mp3', 2, 'stereo', 'libmp3lame'], ['silence.ogg', 1, 'mono', 'libvorbis'],
  ]) {
    const file = join(work, name);
    await exec(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=16000:cl=${layout}`, '-t', '1.2', '-c:a', codec, file]);
    const response = await fetch(`http://127.0.0.1:${port}/v1/transcribe?channels=${layout}`, {
      method: 'POST', headers: { 'X-STT-Key': key }, body: await readFile(file),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.channels, channels);
    assert.equal(body.polza_calls, 0);
    assert.deepEqual(body.segments, []);
    assert.equal(body.transcription_coverage.status, 'no_empty_fragments');
  }
  const signal = join(work, 'signal.wav');
  await exec(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=1.2', '-ac', '2', signal]);
  const response = await fetch(`http://127.0.0.1:${port}/v1/transcribe?channels=stereo`, {
    method: 'POST', headers: { 'X-STT-Key': key }, body: await readFile(signal),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.polza_calls, 2);
  assert.equal(result.segments.length, 1);
  assert.ok(result.segments.every(item => item.text === 'тестовая реплика'));
  assert.equal(result.transcription_coverage.status, 'incomplete');
  assert.equal(result.transcription_coverage.total_fragments, 2);
  assert.equal(result.transcription_coverage.unrecognized_count, 1);
  const gap = result.transcription_coverage.unrecognized_segments[0];
  assert.ok([0,1].includes(gap.channel)); assert.ok(gap.end > gap.start);
});
