import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { transcribeCalls } from '../../app/src/calls/index.mjs';
import { pgDecide } from '../../app/src/rules/pipeline-gate.mjs';

const snapshot = 'tmp/backup/GLQ2iuzRaCQZM7QU/транскрибировать-все-звонки-2026-10-19.js';
const sourceMarks = Object.fromEntries(['calls', 'openlines', 'comments', 'tasks'].map(key => [key, { complete: true }]));
const call = {
  type: 'call', activity_id: '123', date: '2026-10-19T09:00:00Z', direction: 'incoming',
  duration_start: '2026-10-19T09:00:00Z', duration_end: '2026-10-19T09:01:00Z',
  _needs_transcription: true, audio_url: 'https://example.test/call?fileId=100',
};
const deal = { deal_id: 42, title: 'Пример', communications: [call, { type: 'comment', text: 'Заметка' }] };

function output(request, body = {}) {
  return {
    success: true, activity_id: request.activity_id, comm_index: request.comm_index,
    channel_count: request.channel_count, formatted_dialog: 'Клиент: Добрый день',
    conversation: [{ id: 1, speaker: 'Клиент', text: 'Добрый день' }],
    client_text: 'Добрый день', manager_text: '', total_replicas: 1,
    transcript_engine: 'reserve:gigaam', ...body,
  };
}

test('стерео сохраняет исходные поля, роли, движок и статистику', async () => {
  const requests = [];
  const before = structuredClone(deal);
  const result = await transcribeCalls({ dealData: deal, async transcribe(req) { requests.push(req); return output(req); } });
  assert.deepEqual(deal, before);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].file_id, '100');
  assert.equal(requests[0].channel_count, 2);
  assert.equal(result.communications[0].transcript, 'Клиент: Добрый день');
  assert.equal(result.communications[0]._transcript_mode, 'stereo');
  assert.equal(result.communications[0].transcript_engine, 'reserve:gigaam');
  assert.equal(result.communications[1].text, 'Заметка');
  assert.equal(result.full_data.title, 'Пример');
  assert.equal(result.transcription_stats.calls_by_reserve, 1);
  assert.equal(result.transcription_stats.calls_failed, 0);
  assert.equal(result.ready_for_analysis, false);
});

test('несовпадение каналов или пустой стерео вызывает моно, текст остаётся без назначения стороны', async () => {
  for (const stereo of [
    { success: false, error: 'Audio has 1 channel, but 2 requested', retryable: false },
    { success: false, error: 'bad_audio', channels_mismatch: true, retryable: false },
    { success: true, formatted_dialog: '' },
  ]) {
    const requests = [];
    const result = await transcribeCalls({ dealData: deal, async transcribe(req) {
      requests.push(req);
      return req.channel_count === 2 ? stereo : output(req, { formatted_dialog: 'Говорящий: текст', client_text: '', manager_text: 'текст' });
    } });
    assert.deepEqual(requests.map(item => item.channel_count), [2, 1]);
    assert.equal(requests[1].speaker_role, 'Говорящий');
    assert.equal(result.communications[0]._transcript_mode, 'mono');
    assert.equal(result.communications[0].transcript, 'Говорящий: текст');
    assert.equal(result.transcription_errors.length, 0);
  }
});

test('стерео с пустым результатом и пустой моно-проход — тишина, а не техсбой', async () => {
  const result = await transcribeCalls({ dealData: deal, async transcribe(req) { return output(req, { formatted_dialog: '' }); } });
  assert.equal(result.transcription_errors.length, 0);
  assert.equal(result.communications[0]._transcription_empty, true);
  assert.equal(result.transcription_stats.calls_empty, 1);
  assert.equal(pgDecide({ sources: sourceMarks, recognition: { calls: result.transcription_errors } }).block, false);
});

test('временный отказ стерео не запускает моно и блокирует судью', async () => {
  const calls = [];
  const result = await transcribeCalls({ dealData: deal, async transcribe(req) {
    calls.push(req.channel_count);
    return { success: false, retryable: true, error: 'HTTP 503' };
  } });
  assert.deepEqual(calls, [2]);
  assert.equal(result.transcription_errors[0].retryable, true);
  assert.equal(result.transcription_errors[0].duration_sec, 60);
  assert.equal(pgDecide({ sources: sourceMarks, recognition: { calls: result.transcription_errors } }).block, true);
});

test('длинный отказ моно по каналам попадает в gate даже при retryable=false', async () => {
  const result = await transcribeCalls({ dealData: deal, async transcribe(req) {
    if (req.channel_count === 2) return { success: true, formatted_dialog: '' };
    return { success: false, retryable: false, channels_mismatch: true, error: 'bad_audio' };
  } });
  assert.match(result.transcription_errors[0].error, /channels.*requested/i);
  assert.equal(result.transcription_errors[0].retryable, false);
  assert.equal(pgDecide({ sources: sourceMarks, recognition: { calls: result.transcription_errors } }).block, true);
});

test('короткая подтверждённая ошибка каналов сохраняет порог 30/31 секунду', async () => {
  for (const [duration, block] of [[30, false], [31, true]]) {
    const data = { ...deal, communications: [{ ...call, duration_seconds: duration }] };
    const result = await transcribeCalls({ dealData: data, async transcribe(req) {
      return req.channel_count === 2 ? { success: true, formatted_dialog: '' }
        : { success: false, retryable: false, channels_mismatch: true, error: 'bad_audio' };
    } });
    assert.equal(result.transcription_errors[0].technical_failure, block);
    assert.equal(pgDecide({ sources: sourceMarks, recognition: { calls: result.transcription_errors } }).block, block);
  }
});

test('постоянный технический отказ сохраняет retryable=false и явный признак сбоя', async () => {
  const result = await transcribeCalls({ dealData: deal, async transcribe() {
    return { success: false, retryable: false, error: 'bad_audio' };
  } });
  assert.equal(result.transcription_errors[0].retryable, false);
  assert.equal(result.transcription_errors[0].technical_failure, true);
});

test('URL из audio_files имеет приоритет, пустые значения пропускаются', async () => {
  const data = { ...deal, communications: [{ ...call, audio_files: [{ url: '' }, { url: 'https://example.test/audio?fileId=202' }] }] };
  let request;
  await transcribeCalls({ dealData: data, async transcribe(req) { request = req; return output(req); } });
  assert.equal(request.file_id, '202');
});

test('ссылка в _needs_transcription попадает в обработку', async () => {
  const data = { ...deal, communications: [{ ...call, _needs_transcription: 'https://example.test/call?fileId=100' }] };
  let called = false;
  const result = await transcribeCalls({ dealData: data, async transcribe(req) { called = true; return output(req); } });
  assert.equal(called, true);
  assert.equal(result.transcription_stats.calls_transcribed, 1);
});

test('старый звонок без флага, но с URL обрабатывается, явное false сохраняется', async () => {
  const { _needs_transcription, ...oldCall } = call;
  const data = { ...deal, communications: [oldCall, { ...call, activity_id: '124', _needs_transcription: false }] };
  const requests = [];
  const result = await transcribeCalls({ dealData: data, async transcribe(req) { requests.push(req); return output(req); } });
  assert.deepEqual(requests.map(req => req.activity_id), ['123']);
  assert.equal(result.transcription_stats.calls_with_audio, 1);
  assert.equal(result.communications[1]._transcribed, undefined);
});

test('отсутствующий URL, fileId или ID звонка не превращается в якобы полные данные', async () => {
  for (const item of [
    { ...call, audio_url: '' },
    { ...call, audio_url: 'https://example.test/audio' },
    { ...call, activity_id: null },
  ]) {
    const result = await transcribeCalls({ dealData: { ...deal, communications: [item] }, async transcribe() { throw new Error('Не должен вызываться'); } });
    assert.equal(result.transcription_errors[0].retryable, true);
    assert.equal(pgDecide({ sources: sourceMarks, recognition: { calls: result.transcription_errors } }).block, true);
  }
});

test('ошибки и URL токенов из внешнего адаптера очищаются', async () => {
  const result = await transcribeCalls({ dealData: deal, async transcribe() {
    throw new Error('502 https://example.test/rest/65/sampletoken/?auth=sampletoken');
  } });
  const error = JSON.stringify(result.transcription_errors);
  assert.equal(error.includes('sampletoken'), false);
  assert.equal(error.includes('https://'), false);
  assert.equal(result.transcription_errors[0].retryable, true);
});

test('ошибочный или повторяющийся ID результата не привязывает чужой текст', async () => {
  const wrong = await transcribeCalls({ dealData: deal, async transcribe(req) { return output(req, { activity_id: '999' }); } });
  assert.equal(wrong.transcription_errors[0].retryable, true);
  assert.equal(wrong.communications[0].transcript, undefined);
  const duplicate = await transcribeCalls({ dealData: { ...deal, communications: [call, call] }, async transcribe(req) { return output(req); } });
  assert.equal(duplicate.transcription_errors[0].retryable, true);
});

test('явное моно в стерео-ответе сохраняется как моно', async () => {
  const result = await transcribeCalls({ dealData: deal, async transcribe(req) {
    return output(req, { formatted_dialog: 'Говорящий: текст', channel_count: 1 });
  } });
  assert.equal(result.communications[0]._transcript_mode, 'mono');
});

test('непустой стерео-диалог без текста сторон блокирует судью', async () => {
  const result = await transcribeCalls({ dealData: deal, async transcribe(req) {
    return output(req, { formatted_dialog: 'Клиент: текст', manager_text: '', client_text: '' });
  } });
  assert.equal(result.transcription_errors[0].technical_failure, true);
  assert.equal(result.transcription_errors[0].retryable, true);
  assert.equal(result.communications[0].transcript, undefined);
  assert.equal(pgDecide({ sources: sourceMarks, recognition: { calls: result.transcription_errors } }).block, true);
});

test('реплики обеих сторон не теряются, тишина одной стороны допустима', async () => {
  for (const [dialog, manager, client, block] of [
    ['Менеджер: ответ\nКлиент: вопрос', 'ответ', '', true],
    ['Менеджер: ответ\nКлиент: вопрос', '', 'вопрос', true],
    ['Менеджер: ответ', 'ответ', '', false],
    ['Клиент: вопрос', '', 'вопрос', false],
  ]) {
    const result = await transcribeCalls({ dealData: deal, async transcribe(req) {
      return output(req, { formatted_dialog: dialog, manager_text: manager, client_text: client });
    } });
    assert.equal(result.transcription_errors.length > 0, block);
  }
});

test('пустая или некорректная коммуникация не превращается в пустой объект', async () => {
  await assert.rejects(transcribeCalls({ dealData: { ...deal, communications: [null] } }), /Некорректная коммуникация/);
  await assert.rejects(transcribeCalls({ dealData: { ...deal, communications: ['не объект'] } }), /Некорректная коммуникация/);
  await assert.rejects(transcribeCalls({ dealData: { ...deal, deal_id: null } }), /ID сделки/);
});

test('успешный ответ без строкового formatted_dialog — сбой на любом проходе', async () => {
  for (const invalid of [undefined, null, 0, {}]) {
    const invalidResponse = { success: true, formatted_dialog: invalid };
    const stereo = await transcribeCalls({ dealData: deal, async transcribe() { return invalidResponse; } });
    assert.equal(stereo.transcription_errors[0].retryable, true);
    assert.equal(stereo.transcription_errors[0].step, 'pass1_stereo');
    assert.equal(pgDecide({ sources: sourceMarks, recognition: { calls: stereo.transcription_errors } }).block, true);
    const mono = await transcribeCalls({ dealData: deal, async transcribe(req) {
      return req.channel_count === 2 ? { success: true, formatted_dialog: '' } : invalidResponse;
    } });
    assert.equal(mono.transcription_errors[0].retryable, true);
    assert.equal(mono.transcription_errors[0].step, 'pass2_mono');
    assert.equal(pgDecide({ sources: sourceMarks, recognition: { calls: mono.transcription_errors } }).block, true);
  }
});

async function runOriginal(transcribe) {
  const original = readFileSync(snapshot, 'utf8');
  // Нода хранит credentials. Извлекаем только код, подменяя обе строки до исполнения.
  const source = original.replace(/^var B24_API\s*=.*;\s*$/m, "var B24_API = 'https://example.test';")
    .replace(/^var YANDEX_API_KEY\s*=.*;\s*$/m, "var YANDEX_API_KEY = 'placeholder';");
  assert.notEqual(source, original, 'Не удалось удалить credentials из эталона');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('$input', source);
  const state = { deal_id: 42, full_data: deal, calls_total: 1, calls_with_audio: 1, calls_to_transcribe: [
    { index: 0, activity_id: '123', date: call.date, direction: call.direction, audio_url: call.audio_url },
  ] };
  const helpers = { async httpRequest(request) {
    if (request.method === 'GET') return { result: { DOWNLOAD_URL: 'https://example.test/download' } };
    return transcribe(request.body);
  } };
  return (await run.call({ helpers }, { first: () => ({ json: state }) }))[0].json;
}

for (const scenario of ['stereo', 'mono_mismatch', 'mono_empty']) {
  test(`паритет ноды на моке: ${scenario}`, { skip: !existsSync(snapshot) }, async () => {
    const fake = async req => {
      if (req.channel_count === 2 && scenario === 'mono_mismatch') return { success: false, retryable: false, error: 'Audio has 1 channel, but 2 requested' };
      if (req.channel_count === 2 && scenario === 'mono_empty') return output(req, { formatted_dialog: '' });
      if (req.channel_count === 1) return output(req, { formatted_dialog: 'Говорящий: текст', manager_text: 'текст', client_text: '' });
      return output(req);
    };
    const old = await runOriginal(fake);
    const restored = await transcribeCalls({ dealData: deal, transcribe: fake });
    assert.deepEqual(restored.transcription_results, old.transcription_results);
    assert.deepEqual(restored.transcription_errors, old.transcription_errors);
    assert.equal(restored.calls_total, old.calls_total);
    assert.equal(restored.calls_with_audio, old.calls_with_audio);
  });
}
