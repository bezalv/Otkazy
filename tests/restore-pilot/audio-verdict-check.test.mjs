import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectOneAudio, runAudioCommand, chooseAudioModel, audioMetadata } from '../../app/src/pilot/audio-verdict-check.mjs';

const model = 'xiaomi/mimo-v2.6-flash';
const signal = () => new AbortController().signal;
function wav() {
  const b = Buffer.alloc(48); b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(4, 40);
  return b;
}
function harness({ owner = '96621', available = true, redirect = null, recording = wav(), selectedModel = model } = {}) {
  const requests = [], methods = [];
  const client = { async request(method, body) {
    methods.push({ method, body });
    if (method === 'crm.activity.get') return { result: { ID: '1454929', OWNER_ID: owner, OWNER_TYPE_ID: 2, TYPE_ID: 2,
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
