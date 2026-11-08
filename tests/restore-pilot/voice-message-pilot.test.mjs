import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runVoiceMessagePilot } from '../../app/src/pilot/voice-message-pilot.mjs';

const cutoff = '2026-10-28T05:35:03.000Z';
function fixture() {
  const state = { calls: [], downloads: 0, stt: 0, inspected: 0, fileReads: 0, failOnDownload: false,
    history: { chatId: 12, sessionId: 34, chat: { 12: { entityId: 'wz_test|9|client|user' } }, users: {},
      files: { 88: { id: 88, name: 'voice.ogg', type: 'audio' } }, message: {
        50: { id: 50, text: '', date: '2026-10-27T00:00:00Z', params: { FILE_ID: [88] } },
        51: { id: 51, text: 'Другое сообщение', date: '2026-10-27T01:00:00Z' },
      } },
    meta: { ID: 88, NAME: 'voice.ogg', SIZE: 2048, DOWNLOAD_URL: 'https://dinalnsk.bitrix24.ru/rest/65/testkey/download/?token=test' },
    record: { id: 34, chatId: 12, configId: 9, crmEntityType: 'deal', crmEntityId: 127114, dateCreate: '2026-10-26T00:00:00Z' },
    deal: { ID: '127114', STAGE_ID: 'C23:LOSE' }, transition: '321', type: 'audio/ogg', bodyLength: 2048,
    result: { success: true, formatted_dialog: 'Участник чата: тестовая расшифровка' } };
  const client = { async request(method, body) {
    state.calls.push({ method, body: structuredClone(body) });
    if (method === 'crm.deal.get') return { result: structuredClone(state.deal) };
    if (method === 'crm.stagehistory.list') return { result: { items: [
      { ID: state.transition, STAGE_ID: 'C23:LOSE', CREATED_TIME: cutoff },
      { ID: '300', STAGE_ID: 'C23:NEW', CREATED_TIME: '2026-10-27T00:00:00Z' },
    ] } };
    if (method === 'imopenlines.crm.chat.get') return { result: [{ CHAT_ID: 12, CONNECTOR_ID: 'wz_test', CONNECTOR_TITLE: 'Wazzup' }] };
    if (method === 'imopenlines.session.history.get') return { result: structuredClone(state.history) };
    if (method === 'imopenlines.v2.Session.list') return { result: { sessions: [structuredClone(state.record)], hasNextPage: false } };
    if (method === 'disk.file.get') { state.fileReads++; return { result: structuredClone(state.meta) }; }
    throw new Error('Запрещённый метод');
  } };
  const args = { dealId: '127114', transitionId: '321', chatId: '12', sessionId: '34', messageId: '50', fileId: '88',
    cutoff, from: '2026-01-01T00:00:00Z', bitrixRestBase: 'https://dinalnsk.bitrix24.ru/rest/65/testkey/',
    signal: new AbortController().signal, client,
    async fetchImpl(url, options) {
      state.downloads++; assert.equal(url, state.meta.DOWNLOAD_URL); assert.equal(options.redirect, 'error');
      if (state.failOnDownload) throw new Error('network');
      return new Response(Buffer.alloc(state.bodyLength, 5), { status: 200, headers: { 'content-type': state.type, 'content-length': String(state.bodyLength) } });
    },
    async inspectAudio(bytes, options) { state.inspected++; assert.equal(bytes.length, 2048); assert.equal(options.extension, 'ogg');
      return { duration_sec: 64, channels: 1, audio_streams: 1, video_streams: 0, other_streams: 0 }; },
    async transcribeAudio(bytes, options) { state.stt++; state.borrowed = bytes; assert.equal(bytes.length, 2048);
      assert.equal(options.channel_count, 1); assert.equal(options.speaker_role, 'Участник чата'); return structuredClone(state.result); },
  };
  return { args, state };
}

test('один подтверждённый файл скачивается и распознаётся один раз без записи или других файлов', async () => {
  const f = fixture(), result = await runVoiceMessagePilot(f.args);
  assert.equal(result.status, 'unverified'); assert.equal(result.delivery_permitted, false);
  assert.equal(result.history_complete, null); assert.equal(result.duration_sec, 64);
  assert.match(result.audio_sha256, /^[a-f0-9]{64}$/); assert.equal(result.transcript.success, true);
  assert.equal(f.state.downloads, 1); assert.equal(f.state.stt, 1); assert.equal(f.state.inspected, 1);
  assert.equal(f.state.fileReads, 3); assert.ok(f.state.borrowed.every(x => x === 0));
  assert.deepEqual([...new Set(f.state.calls.map(x => x.method))].sort(),
    ['crm.deal.get','crm.stagehistory.list','disk.file.get','imopenlines.crm.chat.get','imopenlines.session.history.get','imopenlines.v2.Session.list'].sort());
  assert.ok(f.state.calls.filter(x => x.method === 'disk.file.get').every(x => x.body.id === 88));
});

test('чужие сделка, переход, чат, сессия, сообщение или файл не приводят к скачиванию', async () => {
  for (const change of [a => a.dealId = '1', a => a.transitionId = '1', a => a.chatId = '13',
    a => a.sessionId = '35', a => a.messageId = '51', a => a.fileId = '89']) {
    const f = fixture(); change(f.args); await assert.rejects(runVoiceMessagePilot(f.args));
    assert.equal(f.state.downloads, 0); assert.equal(f.state.stt, 0);
  }
});

test('сессия должна быть привязана к сделке, а сообщение — к единственному выбранному файлу до отказа', async () => {
  for (const change of [s => s.record.crmEntityId = '9', s => s.record.crmEntityType = 'lead',
    s => s.history.message[50].params.FILE_ID.push(89), s => s.history.message[50].date = '2026-11-01T00:00:00Z',
    s => s.history.files[88].type = 'video', s => s.history.files[88].CONTENT_TYPE = 'image/png',
    s => s.history.chat[12].entityId = 'another|9|client|user']) {
    const f = fixture(); change(f.state); await assert.rejects(runVoiceMessagePilot(f.args));
    assert.equal(f.state.downloads, 0); assert.equal(f.state.stt, 0);
  }
});

test('неизвестный тип, другой ID, внешний URL, конфликт изображения и расширения блокируют до скачивания', async () => {
  for (const change of [s => s.meta.ID = 89, s => s.meta.NAME = 'image.png', s => s.meta.TYPE = 'video',
    s => s.meta.MIME_TYPE = 'image/png', s => s.meta.DOWNLOAD_URL = 'https://example.org/file',
    s => s.meta.DOWNLOAD_URL = 'https://user:pass@dinalnsk.bitrix24.ru/file',
    s => s.meta.DOWNLOAD_URL = 'https://dinalnsk.bitrix24.ru/rest/65/testkey/crm.deal.delete?token=test',
    s => s.meta.DOWNLOAD_URL = 'https://dinalnsk.bitrix24.ru/rest/65/wrong/download/?token=test',
    s => s.meta.DOWNLOAD_URL = 'https://dinalnsk.bitrix24.ru/rest/65/testkey/download/?token=test&action=delete',
    s => s.meta.DOWNLOAD_URL = 'https://dinalnsk.bitrix24.ru/rest/65/testkey/download/?token=test&token=test',
    s => s.meta.SIZE = 99_000_000]) {
    const f = fixture(); change(f.state); await assert.rejects(runVoiceMessagePilot(f.args));
    assert.equal(f.state.downloads, 0); assert.equal(f.state.stt, 0);
  }
});

test('изменение метаданных между проверками блокирует до скачивания', async () => {
  const f = fixture(), real = f.args.client.request;
  f.args.client.request = async (...args) => { const r = await real(...args); if (args[0] === 'disk.file.get' && f.state.fileReads === 1) f.state.meta.NAME = 'video.mp4'; return r; };
  await assert.rejects(runVoiceMessagePilot(f.args)); assert.equal(f.state.downloads, 0); assert.equal(f.state.stt, 0);
});

test('меняющийся token не считается изменением файла; скачивается ссылка последнего чтения', async () => {
  const f = fixture(), real = f.args.client.request;
  f.args.client.request = async (...args) => {
    if (args[0] === 'disk.file.get') f.state.meta.DOWNLOAD_URL = `https://dinalnsk.bitrix24.ru/rest/65/testkey/download/?token=token${f.state.fileReads + 1}`;
    return real(...args);
  };
  const result = await runVoiceMessagePilot(f.args);
  assert.equal(result.status, 'unverified'); assert.equal(f.state.fileReads, 3);
  assert.equal(f.state.downloads, 1); assert.equal(f.state.stt, 1);
});

test('вместе с новым token изменение настоящих метаданных всё равно блокирует скачивание', async () => {
  const f = fixture(), real = f.args.client.request;
  f.args.client.request = async (...args) => {
    if (args[0] === 'disk.file.get') {
      f.state.meta.DOWNLOAD_URL = `https://dinalnsk.bitrix24.ru/rest/65/testkey/download/?token=token${f.state.fileReads + 1}`;
      if (f.state.fileReads > 0) f.state.meta.SIZE = 2049;
    }
    return real(...args);
  };
  await assert.rejects(runVoiceMessagePilot(f.args)); assert.equal(f.state.downloads, 0); assert.equal(f.state.stt, 0);
});

test('изменение перехода, истории или метаданных во время скачивания блокирует передачу в STT', async () => {
  for (const mutate of [s => s.transition = '322', s => s.history.message[50].params.FILE_ID = [89], s => s.meta.NAME = 'other.ogg']) {
    const f = fixture(), real = f.args.fetchImpl;
    f.args.fetchImpl = async (...args) => { const response = await real(...args); mutate(f.state); return response; };
    await assert.rejects(runVoiceMessagePilot(f.args)); assert.equal(f.state.downloads, 1); assert.equal(f.state.stt, 0);
  }
});

test('не аудио, повреждённая запись, слишком длинное аудио и ошибка STT не дают успешного результата', async () => {
  for (const setup of [f => f.state.type = 'text/html', f => f.state.bodyLength = 10,
    f => f.args.inspectAudio = async () => ({ duration_sec: 121, channels: 1, audio_streams: 1, video_streams: 0, other_streams: 0 }),
    f => f.args.inspectAudio = async () => ({ duration_sec: 64, channels: 1, audio_streams: 1, video_streams: 1, other_streams: 0 }),
    f => f.args.inspectAudio = async () => ({ duration_sec: 64, channels: 1, audio_streams: 1, video_streams: 0, other_streams: 1 }),
    f => f.args.inspectAudio = async () => ({ duration_sec: 64, channels: 1 }),
    f => f.state.result = { success: false }]) {
    const f = fixture(); setup(f); await assert.rejects(runVoiceMessagePilot(f.args));
    assert.ok(f.state.stt <= 1);
  }
});

test('неверное окно, лимит продолжительности, домен и отмена останавливают до обращений к сети', async () => {
  for (const change of [a => a.from = '2020-01-01T00:00:00Z', a => a.maxDurationSec = 121,
    a => a.bitrixRestBase = 'https://example.org/rest/1/test/', a => a.maxPages = 21,
    a => a.signal = null, a => a.signal = AbortSignal.abort()]) {
    const f = fixture(); change(f.args); await assert.rejects(runVoiceMessagePilot(f.args));
    assert.equal(f.state.calls.length, 0); assert.equal(f.state.stt, 0);
  }
});

test('отмена во время транскрибации не выдаёт успешный результат', async () => {
  const f = fixture(), controller = new AbortController(); f.args.signal = controller.signal;
  f.args.transcribeAudio = async () => { controller.abort(); return { success: true, formatted_dialog: 'текст' }; };
  await assert.rejects(runVoiceMessagePilot(f.args), { name: 'AbortError' });
});
