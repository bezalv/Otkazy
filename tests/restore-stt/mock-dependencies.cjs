'use strict';

// Загружается только дочерним тестовым процессом. Внешняя сеть в нём недоступна.
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { Writable } = require('node:stream');

const scenario = process.env.STT_TEST_SCENARIO;
const originalMkdir = fs.mkdirSync;
const originalCreateWriteStream = fs.createWriteStream;
const originalSetTimeout = global.setTimeout;

if (scenario === 'aiesa_poll_invalid') {
  global.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, ms === 3000 ? 0 : ms, ...args);
}

if (scenario === 'mkdir_failure') {
  fs.mkdirSync = function (dir, options) {
    if (dir === process.env.WORK_DIR) throw Object.assign(new Error('test ENOSPC'), { code: 'ENOSPC' });
    return originalMkdir.call(this, dir, options);
  };
}

if (scenario === 'write_failure') {
  fs.createWriteStream = function (file, options) {
    if (String(file).endsWith('.in')) {
      return new Writable({
        write(chunk, encoding, callback) { callback(Object.assign(new Error('test ENOSPC'), { code: 'ENOSPC' })); }
      });
    }
    return originalCreateWriteStream.call(this, file, options);
  };
}

childProcess.execFile = function (command, args, options, callback) {
  if (command === 'ffprobe') {
    const channels = scenario === 'slow_peer' || scenario === 'second_track_failure' ? 2 : 1;
    return setImmediate(() => callback(null, JSON.stringify({ streams: [{ codec_type: 'audio', channels }], format: { duration: 2 } }), ''));
  }
  if (command !== 'ffmpeg') return setImmediate(() => callback(new Error('unexpected binary'), '', ''));
  const detecting = args.includes('silencedetect=noise=-40dB:d=0.4');
  if (detecting) {
    const input = args[args.indexOf('-i') + 1];
    if (scenario === 'slow_peer' && input.endsWith('_1.mp3')) {
      return setTimeout(() => {
        fs.writeFileSync(path.join(process.env.WORK_DIR, 'peer-complete.flag'), 'done');
        callback(null, '', '');
      }, 300);
    }
    const silence = scenario === 'silence' ? 'silence_start: 0\nsilence_end: 2\n' : '';
    return setImmediate(() => callback(null, '', silence));
  }
  const output = args[args.length - 1];
  fs.writeFileSync(output, 'audio');
  if (scenario === 'second_track_failure' && output.endsWith('_1.mp3')) {
    return setImmediate(() => callback(new Error('second track failed'), '', 'ffmpeg failed'));
  }
  return setImmediate(() => callback(null, '', ''));
};

global.fetch = async function (url) {
  if (!String(url).startsWith('https://api.polza.ai/api/v1/audio/transcriptions')) throw new Error('external network forbidden');
  if (scenario === 'provider_secret') return Response.json({ error: { message: 'secret-must-not-appear' } }, { status: 400 });
  if (scenario === 'aiesa_poll_invalid') {
    return String(url).endsWith('/test-job') ? new Response('{', { status: 200 }) : Response.json({ status: 'processing', id: 'test-job' });
  }
  if (scenario === 'invalid_json') return new Response('{', { status: 200 });
  if (scenario === 'missing_text' || scenario === 'slow_peer') return Response.json({});
  if (scenario === 'empty_text') return Response.json({ text: '' });
  if (scenario === 'aiesa_missing_segments') return Response.json({ status: 'completed' });
  if (scenario === 'aiesa_bad_segments') return Response.json({ status: 'completed', segments: [{ start: 0, end: 1 }] });
  if (scenario === 'aiesa_empty') return Response.json({ status: 'completed', segments: [] });
  return Response.json({ text: 'распознанная речь' });
};
