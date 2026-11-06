import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectOneAudio, runAudioCommand, chooseAudioModel, audioMetadata, mp3ClipMetadata, clipAudio } from '../../app/src/pilot/audio-verdict-check.mjs';
import { resolveBinary } from '../../app/src/stt/binaries.mjs';

const model = 'xiaomi/mimo-v2.6-flash';
const signal = () => new AbortController().signal;
function wav() {
  const b = Buffer.alloc(48); b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(4, 40);
  return b;
}
function harness({ owner = '96621', activityId = '1454929', available = true, redirect = null, recording = wav(), selectedModel = model } = {}) {
  const requests = [], methods = [];
  const client = { async request(method, body) {
    methods.push({ method, body });
    if (method === 'crm.activity.get') return { result: { ID: activityId, OWNER_ID: owner, OWNER_TYPE_ID: 2, TYPE_ID: 2,
      FILES: [{ urlDownload: '/download?fileId=42' }] } };
    if (method === 'disk.file.get') return { result: { DOWNLOAD_URL: 'https://dinalnsk.bitrix24.ru/download/42' } };
    throw new Error('unexpected method');
  } };
  const fetchImpl = async (url, options) => {
    const u = String(url); requests.push({ u, options });
    if (u === 'https://api.polza.ai/api/v1/models') return Response.json({ data: available ? [{ id: selectedModel, architecture: { input_modalities: ['audio', 'text'] } }] : [] });
    if (u === 'https://dinalnsk.bitrix24.ru/download/42') return redirect
      ? new Response(null, { status: 302, headers: { location: redirect } })
      : new Response(recording, { headers: { 'content-type': 'audio/wav' } });
    if (u === 'https://api.polza.ai/api/v1/chat/completions') return Response.json({ choices: [{ message: { content: 'На записи слышен голос; роль неясна.' } }] });
    throw new Error('unexpected URL');
  };
  return { client, fetchImpl, requests, methods };
}

test('разрешает только подтверждённые точные модели с audio input', () => {
  assert.equal(chooseAudioModel({ data: [{ id: model, architecture: { input_modalities: ['audio'] } }] }, model), model);
  assert.throws(() => chooseAudioModel({ data: [{ id: model, architecture: { input_modalities: ['text'] } }] }, model));
  assert.throws(() => chooseAudioModel({ data: [{ id: 'another', input_modalities: ['audio'] }] }, 'another'));
  assert.throws(() => chooseAudioModel({ data: [] }, model));
});

function longWav(seconds, channels = 2) {
  const rate = 8000, bytes = seconds * rate * channels * 2, b = Buffer.alloc(44 + bytes);
  b.write('RIFF'); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40);
  for (let second = 0; second < seconds; second++) for (let frame = 0; frame < rate; frame++) for (let channel = 0; channel < channels; channel++) {
    b.writeInt16LE((second + 1) * 100, 44 + ((second * rate + frame) * channels + channel) * 2);
  }
  return b;
}

function longTones(seconds, channels = 2) {
  const b = longWav(seconds, channels), rate = 8000;
  for (let second = 0; second < seconds; second++) for (let frame = 0; frame < rate; frame++) for (let channel = 0; channel < channels; channel++) {
    const frequency = 250 + second * 4 + channel * 90;
    b.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * frequency * frame / rate)), 44 + ((second * rate + frame) * channels + channel) * 2);
  }
  return b;
}

test('четыре коротких MP3 сохраняют каналы и смещение, длительность проверена по фреймам', async () => {
  const original = longTones(109), cases = [[80,95],[95,109],[60,72],[72,83]];
  for (const [start, end] of cases) {
    const output = await clipAudio(original, { start_seconds: start, end_seconds: end, signal: signal(), format: 'mp3' });
    const meta = mp3ClipMetadata(output);
    assert.equal(meta.channels, 2); assert.equal(meta.sample_rate, 16000);
    assert.ok(Math.abs(meta.duration_seconds - (end - start)) < 0.15);
    const decoded = spawnSync(resolveBinary('ffmpeg'), ['-hide_banner','-loglevel','error','-i','pipe:0','-f','s16le','-acodec','pcm_s16le','pipe:1'],
      { input: output, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(decoded.status, 0);
    // Вторая секунда относится к start + 1; разная частота каналов также
    // обнаружит ошибочное смешивание стерео при перекодировании.
    for (let channel = 0; channel < 2; channel++) {
      let up = 0, previous = 0;
      for (let n = 16000 + 3200; n < 16000 + 11200; n++) {
        const current = decoded.stdout.readInt16LE((n * 2 + channel) * 2);
        if (previous <= 0 && current > 0) up++;
        previous = current;
      }
      assert.ok(Math.abs(up * 2 - (250 + (start + 1) * 4 + channel * 90)) < 5, `wrong frequency/offset ${start} channel ${channel}`);
    }
  }
  const mono = await clipAudio(longTones(109, 1), { start_seconds: 80, end_seconds: 95, signal: signal(), format: 'mp3' });
  assert.equal(mp3ClipMetadata(mono).channels, 1);
  assert.throws(() => mp3ClipMetadata(mono.subarray(0, mono.length - 10)));
});

test('MP3-клипы ограничены точными парами и диапазонами до сетевых запросов', async () => {
  const h = harness();
  for (const [dealId, activityId, clip] of [
    ['96621','1454929',{start_seconds:80,end_seconds:95}],
    ['126554','1660320',{start_seconds:60,end_seconds:72}],
    ['126956','1665898',{start_seconds:80,end_seconds:95}],
    ['126554','1660320',{start_seconds:80,end_seconds:94}],
  ]) await assert.rejects(() => inspectOneAudio({ dealId, activityId, clip, clipFormat: 'mp3', model, apiKey: 'secret', ...h, signal: signal() }));
  assert.equal(h.requests.length, 0);
  await assert.rejects(() => inspectOneAudio({ dealId: '126554', activityId: '1660320', clipFormat: 'mp3', model, apiKey: 'secret', ...h, signal: signal() }));
});

test('отмена MP3-нарезки ожидает закрытия дочернего процесса', async () => {
  const controller = new AbortController(); let closed = false;
  const spawnImpl = (_executable, _args, options) => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], options);
    child.once('close', () => { closed = true; }); return child;
  };
  const work = clipAudio(wav(), { start_seconds: 80, end_seconds: 95, signal: controller.signal, format: 'mp3', spawnImpl });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(work); assert.equal(closed, true);
});

test('Polza получает только заданный MP3-клип с правильным offset и метаданными', async () => {
  const recording = longWav(109), h = harness({ owner: '126554', activityId: '1660320', recording });
  const result = await inspectOneAudio({ dealId: '126554', activityId: '1660320', model, apiKey: 'secret', ...h,
    clip: { start_seconds: 80, end_seconds: 95 }, clipFormat: 'mp3', signal: signal() });
  assert.equal(result.clip.offset_seconds, 80); assert.equal(result.clip.audio_metadata.channels, 2);
  assert.equal(result.clip.audio_metadata.format, 'mp3'); assert.ok(Math.abs(result.clip.audio_metadata.duration_seconds - 15) < 0.15);
  const posted = JSON.parse(h.requests.find(x => x.u.endsWith('/chat/completions')).options.body);
  const item = posted.messages[0].content.find(x => x.type === 'input_audio');
  assert.equal(item.input_audio.format, 'mp3'); assert.equal(mp3ClipMetadata(Buffer.from(item.input_audio.data, 'base64')).channels, 2);
  assert.match(posted.messages[0].content[0].text, /фрагмент с 80 по 95 секунду/);
});

test('MP3 неверной длительности или числа каналов не отправляется в Polza', async () => {
  const stereo = longWav(109, 2), mono = longWav(109, 1);
  const wrongLength = await clipAudio(stereo, { start_seconds: 60, end_seconds: 72, format: 'mp3', signal: signal() });
  const wrongChannels = await clipAudio(mono, { start_seconds: 80, end_seconds: 95, format: 'mp3', signal: signal() });
  for (const output of [wrongLength, wrongChannels]) {
    const h = harness({ owner: '126554', activityId: '1660320', recording: stereo });
    await assert.rejects(() => inspectOneAudio({ dealId:'126554', activityId:'1660320', model, apiKey:'secret', ...h,
      clip: { start_seconds:80, end_seconds:95 }, clipFormat:'mp3', clipper: async () => Buffer.from(output), signal:signal() }));
    assert.equal(h.requests.some(x => x.u.endsWith('/chat/completions')), false);
  }
});

test('семь разрешённых сегментов создаются ffmpeg в памяти с сохранением каналов и правильным смещением', async () => {
  const original = longWav(109), cases = [[0,30],[30,60],[60,90],[90,109],[0,30],[30,60],[60,83]];
  for (const [start, end] of cases) {
    const output = await clipAudio(original, { start_seconds: start, end_seconds: end, signal: signal() });
    const meta = audioMetadata(output);
    assert.equal(meta.channels, 2); assert.equal(meta.sample_rate, 16000);
    assert.ok(Math.abs(meta.duration_seconds - (end - start)) < 0.05);
    let at = 12;
    while (output.toString('ascii', at, at + 4) !== 'data') { const n = output.readUInt32LE(at + 4); at += 8 + n + (n & 1); }
    const sample = output.readInt16LE(at + 8 + 16000 * 2 * 2);
    assert.ok(Math.abs(sample - (start + 2) * 100) < 10, `wrong offset ${start}`);
  }
});

test('клипы доступны только закреплённым диапазонам двух звонков до любых запросов', async () => {
  const h = harness();
  for (const [dealId, activityId, clip] of [
    ['96621','1454929',{start_seconds:0,end_seconds:30}],
    ['126554','1660320',{start_seconds:60,end_seconds:83}],
    ['126956','1665898',{start_seconds:90,end_seconds:109}],
    ['126554','1660320',{start_seconds:1,end_seconds:30}],
  ]) {
    await assert.rejects(() => inspectOneAudio({ dealId, activityId, clip, model, apiKey: 'secret', ...h, signal: signal() }));
  }
  assert.equal(h.requests.length, 0);
});

test('отмена завершает процесс ffmpeg до отклонения и не оставляет открытых ресурсов', async () => {
  const controller = new AbortController(); let closed = false;
  const spawnImpl = (_executable, _args, options) => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], options);
    child.once('close', () => { closed = true; }); return child;
  };
  const work = clipAudio(wav(), { start_seconds: 0, end_seconds: 30, signal: controller.signal, spawnImpl });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(work); assert.equal(closed, true);
});

test('в клип отправляются только байты нарезки и сохраняется смещение оригинала', async () => {
  const recording = longWav(109);
  const h = harness({ owner: '126554', activityId: '1660320', recording });
  const report = await inspectOneAudio({ dealId: '126554', activityId: '1660320', model, apiKey: 'secret', ...h,
    clip: { start_seconds: 30, end_seconds: 60 }, signal: signal() });
  assert.equal(report.clip.offset_seconds, 30);
  assert.equal(report.clip.audio_metadata.channels, 2);
  const posted = JSON.parse(h.requests.find(x => x.u.endsWith('/chat/completions')).options.body);
  const input = posted.messages[0].content.find(x => x.type === 'input_audio');
  assert.notEqual(input.input_audio.data, recording.toString('base64'));
  assert.equal(audioMetadata(Buffer.from(input.input_audio.data, 'base64')).duration_seconds, 30);
  assert.match(posted.messages[0].content[0].text, /фрагмент с 30 по 60 секунду/);
});

test('распознаёт параметры WAV, отвергает неподдерживаемый и повреждённый файл', () => {
  assert.deepEqual(audioMetadata(wav()), { format: 'wav', bytes: 48, channels: 1, sample_rate: 8000, duration_seconds: 0.00025 });
  assert.throws(() => audioMetadata(Buffer.alloc(64)));
  const broken = wav(); broken.writeUInt32LE(100, 40); assert.throws(() => audioMetadata(broken));
});

test('запрашивает только чтение Bitrix и отправляет Polza исходное аудио, не транскрипт', async () => {
  const h = harness();
  const result = await inspectOneAudio({ dealId: '96621', activityId: '1454929', model, apiKey: 'secret', ...h, signal: signal() });
  assert.deepEqual(h.methods.map(x => x.method), ['crm.activity.get', 'disk.file.get']);
  const audioFetch = h.requests.find(x => x.u.includes('/download/'));
  assert.equal(audioFetch.options.headers, undefined);
  const posted = JSON.parse(h.requests.find(x => x.u.endsWith('/chat/completions')).options.body);
  const item = posted.messages[0].content.find(x => x.type === 'input_audio');
  assert.equal(item.input_audio.data, wav().toString('base64'));
  assert.equal(item.input_audio.format, 'wav');
  assert.equal(result.machine_audio_analysis, 'На записи слышен голос; роль неясна.');
  assert.equal(result.limitations.includes('machine_audio_interpretation_not_human_listening'), true);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('неверная пара, владелец, недоступная модель и редирект на чужой хост останавливают отправку', async () => {
  const options = { dealId: '96621', activityId: '1454929', model, apiKey: 'secret', signal: signal() };
  let h = harness();
  await assert.rejects(() => inspectOneAudio({ ...options, activityId: '42', ...h }));
  assert.equal(h.requests.length, 0);
  h = harness({ owner: '126554' }); await assert.rejects(() => inspectOneAudio({ ...options, ...h }));
  assert.equal(h.methods.some(x => x.method === 'disk.file.get'), false);
  h = harness({ available: false }); await assert.rejects(() => inspectOneAudio({ ...options, ...h }));
  assert.equal(h.methods.length, 0);
  for (const target of ['https://evil.example/audio', 'http://127.0.0.1/a', 'https://user:password@dinalnsk.bitrix24.ru/a']) {
    h = harness({ redirect: target }); await assert.rejects(() => inspectOneAudio({ ...options, ...h }));
    assert.equal(h.requests.some(x => x.u.endsWith('/chat/completions')), false);
    assert.equal(h.requests.length, 2);
  }
});

test('CLI отвергает отсутствие sealed и недопустимый ключ до сети, stdout пуст', () => {
  const path = new URL('../../app/src/pilot/audio-verdict-check.mjs', import.meta.url);
  for (const args of [['96621', '1454929', model], ['96621', '1454929', model, '--sealed', 'bad']]) {
    const child = spawnSync(process.execPath, [fileURLToPath(path), ...args], { encoding: 'utf8', env: {} });
    assert.equal(child.status, 1); assert.equal(child.stdout, '');
    assert.match(child.stderr, /Защищённая проверка не завершена/);
  }
});

test('ошибки модели и отсутствия записи дают только разрешённые коды после закрытия ресурсов', async () => {
  let closes = 0;
  const options = { dealId: '96621', activityId: '1454929', model, apiKey: 'secret', closeLimiter: () => { closes++; } };
  let h = harness({ available: false });
  let report = await runAudioCommand({ ...options, ...h });
  assert.deepEqual(report, { status: 'error', phase: 'model_check', error_code: 'model_unavailable', resources_closed: true, service_closed: true });
  h = harness(); h.client.request = async () => ({ result: { ID: '1454929', OWNER_ID: '96621', OWNER_TYPE_ID: 2, TYPE_ID: 2 } });
  report = await runAudioCommand({ ...options, ...h });
  assert.deepEqual(report, { status: 'error', phase: 'bitrix_lookup', error_code: 'audio_unavailable', resources_closed: true, service_closed: true });
  h = harness({ recording: Buffer.alloc(100) }); report = await runAudioCommand({ ...options, ...h });
  assert.equal(report.error_code, 'unsupported_format'); assert.equal(report.phase, 'audio_download');
  h = harness(); h.fetchImpl = async () => new Response('private detail', { status: 503 });
  report = await runAudioCommand({ ...options, ...h });
  assert.equal(report.error_code, 'polza_http_503'); assert.doesNotMatch(JSON.stringify(report), /secret|private detail/);
  assert.equal(closes, 4);
});

test('таймаут останавливает запрос и закрывает ресурсы без внешних текстов', async () => {
  let closed = 0;
  const h = harness();
  h.fetchImpl = async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('secret')), { once: true }));
  const report = await runAudioCommand({ dealId: '96621', activityId: '1454929', model, apiKey: 'secret', ...h,
    closeLimiter: () => { closed++; }, deadlineMs: 20 });
  assert.deepEqual(report, { status: 'error', phase: 'model_check', error_code: 'deadline', resources_closed: true, service_closed: true });
  assert.equal(closed, 1); assert.doesNotMatch(JSON.stringify(report), /secret/);
});

test('если завершение нарезки не подтверждено за grace, маркер закрытия не выдаётся', async () => {
  const h = harness({ owner: '126554', activityId: '1660320' });
  const clipper = async () => new Promise(resolve => setTimeout(() => resolve(wav()), 150));
  await assert.rejects(() => runAudioCommand({ dealId: '126554', activityId: '1660320', model, apiKey: 'secret', ...h,
    clip: { start_seconds: 0, end_seconds: 30 }, clipper, closeLimiter: () => {}, deadlineMs: 20, closeGraceMs: 20 }),
  error => error?.code === 'AUDIO_CLEANUP_UNKNOWN');
  assert.equal(h.requests.some(x => x.u.endsWith('/chat/completions')), false);
});
