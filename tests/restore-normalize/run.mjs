import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectDeal } from '../../app/src/collect/index.mjs';
import { normalizeCommunications } from '../../app/src/collect/normalize.mjs';
import { buildJournal } from '../../app/src/analysis/journal.mjs';
import { buildCommunicationAnalytics } from '../../app/src/analysis/communication-analytics.mjs';
import { assembleFacts } from '../../app/src/analysis/facts-assembler.mjs';
import { processDeal } from '../../app/src/process-deal.mjs';

const voiceFile = { id: 101, name: 'voice.ogg', type: 'audio', extension: 'ogg' };
const otherVoice = { id: 102, name: 'orphan.ogg', type: 'audio', extension: 'ogg', authorid: 77 };
const sessionHistory = {
  sessionId: 80, chatId: 100,
  chat: { 100: {} },
  users: { 77: { name: 'Менеджер', active: true, connector: false, extranet: false, externalAuthId: 'default' } },
  files: { 101: voiceFile, 102: otherVoice },
  message: {
    11: { id: 11, senderid: 0, text: '', params: { FILE_ID: [101] }, date: '2026-11-01T01:00:00Z' },
    12: { id: 12, text: 'Здравствуйте', date: '2026-11-01T01:01:00Z' },
    13: { id: 13, senderid: 0, text: 'Сессия завершена' },
    14: { id: 14, senderid: 0, text: '=== Исходящее сообщение, автор: Менеджер (Ольга) ===\n[USER=1]Ответ[/USER]' },
  },
};

test('коммуникация без ID не может затереть другое событие', async () => {
  for (const raw of [{ calls: [{}] }, { comments: [{}] }, { tasks: [{}] },
    { calls: [{ ID: {} }] }, { comments: [{ ID: true }] }, { tasks: [{ id: [] }] }]) {
    await assert.rejects(normalizeCommunications({ collection: collected(raw) }), /устойчивого идентификатора/);
  }
  await assert.rejects(normalizeCommunications({ collection: collected({ sessions: [{ session_id: 1, history: {
    message: [{ text: 'Сообщение без ID' }], chatId: 1, chat: { 1: {} }, files: {}, users: {},
  } }] }) }), /устойчивого идентификатора/);
});

test('повтор ID на страницах не превращается в два факта и одну запись', async () => {
  for (const calls of [[{ ID: 123 }, { ID: 123 }], [{ ID: 123 }, { ID: 123, SUBJECT: 'другая версия' }]]) {
    await assert.rejects(normalizeCommunications({ collection: collected({ calls }) }), /повтор идентификатора/);
  }
});

function collected(overrides = {}) {
  return {
    deal_id: 42, silent: true, _status: 'pending_normalization',
    _sources: Object.fromEntries(['calls', 'openlines', 'comments', 'tasks'].map(key => [key, { complete: true }])),
    deal_data: { deal_id: 42 },
    raw: { calls: [], comments: [], tasks: [], chats: [], sessions: [], ...overrides },
  };
}

test('чат определяется по chatId истории, а не по порядку ключей', async () => {
  const collection = collected({chats:[{CHAT_ID:100,CONNECTOR_ID:'wz_test'},{CHAT_ID:200,CONNECTOR_ID:'wappi'}],
    sessions:[{session_id:80,history:{chatId:200,chat:{100:{},200:{}},files:{},users:{55:{connector:true}},
      message:{1:{id:1,senderid:55,text:'Сообщение'}}}}]});
  const result=await normalizeCommunications({collection});
  const event=result.deal_data.communications[0];
  assert.equal(String(event.chat_id),'200');assert.equal(event.connector_id,'wappi');assert.equal(event.message_id,'80_1');
  collection.raw.sessions[0].history.chatId=null;
  await assert.rejects(normalizeCommunications({collection}),/Не подтверждён чат/);
  collection.raw.sessions[0].history.chatId=200;
  collection.raw.sessions[0].history.chat={100:{}};
  await assert.rejects(normalizeCommunications({collection}),/Чат отсутствует в карте/);
});

test('отдельное голосовое без подтверждённого чата не отправляется на распознавание', async () => {
  const collection=collected({sessions:[{session_id:80,history:{message:{},chat:{},users:{77:{active:true}},
    files:{102:{id:102,name:'orphan.ogg',type:'audio',authorid:77}}}}]});
  let calls=0;
  await assert.rejects(normalizeCommunications({collection,resolveFile:async()=>{calls++;},transcribeVoice:async()=>{calls++;}}),/Не подтверждён чат/);
  assert.equal(calls,0);
});

test('сбор и нормализация голосовых, дублей сессии, звонков, комментариев и задач', async () => {
  const calls = [];
  const client = {
    async request(method, body) {
      switch (method) {
        case 'crm.deal.userfield.list': return { result: [{ LIST: [{ ID: 4, VALUE: 'Другая причина' }] }] };
        case 'crm.deal.get': return { result: { ID: '42', STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: 65, UF_CRM_1584703948317: 4 } };
        case 'crm.stagehistory.list': return { result: { items: [{ ID: '101', STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-01T00:00:00Z' }] } };
        case 'crm.activity.list':
          if (body.filter.TYPE_ID) return { result: [{ ID: 1, DIRECTION: '2', CREATED: '2026-11-01T00:00:00Z', START_TIME: '2026-11-01T00:20:00Z', END_TIME: '2026-11-01T00:21:00Z', SETTINGS: { RECORD_URL: 'https://example.test/call' } }] };
          return { result: [{ ASSOCIATED_ENTITY_ID: 80 }, { ASSOCIATED_ENTITY_ID: 81 }] };
        case 'crm.timeline.comment.list': return { result: [
          { ID: 50, COMMENT: 'AI-анализ отказа: наш текст', FILES: {} },
          { ID: 51, COMMENT: 'Комментарий менеджера', FILES: {
            2: { id: 2, type: 'image', name: 'Screenshot_10.png', date: '2026-11-01T01:00:00Z' },
            3: { id: 3, type: 'image', name: 'Screenshot_2.png', date: '2026-11-01T01:00:00Z' },
          } },
        ] };
        case 'imopenlines.crm.chat.get': return { result: [
          { CHAT_ID: 100, CONNECTOR_ID: 'wz_test', CONNECTOR_TITLE: 'Wazzup' },
          { CHAT_ID: 200, CONNECTOR_ID: 'wappi', CONNECTOR_TITLE: 'Wappi' },
        ] };
        case 'imopenlines.session.history.get':
          if (body.SESSION_ID === 80 || body.CHAT_ID === 100) return { result: sessionHistory };
          if (body.SESSION_ID === 81 || body.CHAT_ID === 200) return { result: { sessionId: 81, chatId: 200, chat: { 200: {} }, users: { 55: { connector: true } }, message: { 21: { id: 21, senderid: 55, text: 'Вопрос Wappi' } }, files: {} } };
          throw new Error('Неожиданная история');
        case 'tasks.task.list': return { result: { tasks: [{ id: 70, title: 'Позвонить', description: 'а'.repeat(520) }] } };
        default: throw new Error(`Неожиданный метод ${method}`);
      }
    },
  };
  const collection = await collectDeal({ client, dealId: 42, silent: true, now: Date.parse('2026-11-05T00:00:00Z'), wait: async () => {} });
  assert.equal(collection._status, 'pending_normalization');
  // В ответе истории чата может повториться сообщение, уже полученное по сессии.
  collection.raw.sessions.push({ chat_id: 100, history: { ...sessionHistory, message: { 11: sessionHistory.message[11] } } });
  const result = await normalizeCommunications({
    collection,
    async resolveFile(id) {
      calls.push(`file:${id}`);
      return { NAME: id === '101' ? 'voice.ogg' : 'orphan.ogg', DOWNLOAD_URL: `https://example.test/${id}` };
    },
    async transcribeVoice(input) {
      calls.push(`voice:${input.file_id}`);
      return { success: true, formatted_dialog: 'Участник чата: интересует цена', total_replicas: 1 };
    },
  });
  const events = result.deal_data.communications;
  const voice = events.find(event => event.message_id === '80_11');
  assert.equal(voice.text, 'Участник чата: интересует цена');
  assert.equal(voice._has_audio_transcript, true);
  assert.equal(voice._has_files, true);
  assert.equal(voice.role, 'unknown');
  assert.equal(events.filter(event => event.message_id?.endsWith('_11')).length, 1);
  assert.equal(events.some(event => event.message_id === '80_13'), false);
  assert.equal(events.find(event => event.message_id === '80_12').text, 'Здравствуйте');
  assert.equal(events.find(event => event.message_id === '80_14').role, 'Менеджер');
  assert.equal(events.find(event => event.message_id === '80_14').text, 'Ответ');
  assert.equal(events.find(event => event.message_id === '81_21').role, 'Клиент');
  assert.equal(events.find(event => event.message_id === '81_21').channel, 'Wappi');
  assert.equal(events.find(event => event.message_id === '80_file_102').role, 'Менеджер');
  assert.deepEqual(calls, ['file:101', 'voice:101', 'file:102', 'voice:102']);
  const comment = events.find(event => event.comment_id === 51);
  assert.deepEqual(comment.screenshots.map(shot => shot.name), ['Screenshot_2.png', 'Screenshot_10.png']);
  assert.ok(events.some(event => event.text?.includes('AI-анализ отказа')));
  assert.equal(result.analysis_communications.some(event => event.text?.includes('AI-анализ отказа')), false);
  assert.equal(events.find(event => event.type === 'call').duration_end, '2026-11-01T00:20:00Z');
  assert.equal(events.find(event => event.type === 'task').description.length, 500);
  assert.equal(result.voice_failures.length, 0);
  assert.equal(result.ready_for_analysis, false);
});

test('провал загрузки или распознавания блокируется через retryable voice_failures без утечки секрета', async () => {
  const collection = collected({ chats: [{ CHAT_ID: 100 }], sessions: [{ session_id: 80, history: sessionHistory }] });
  for (const mode of ['file', 'transcription']) {
    const result = await normalizeCommunications({
      collection,
      async resolveFile() {
        if (mode === 'file') throw new Error('https://example.test/rest/65/secret/');
        return { NAME: 'voice.ogg', DOWNLOAD_URL: 'https://example.test/private' };
      },
      async transcribeVoice() { throw new Error('secret'); },
    });
    assert.ok(result.voice_failures.length > 0);
    assert.ok(result.voice_failures.every(failure => failure.retryable === true));
    assert.equal(JSON.stringify(result.voice_failures).includes('secret'), false);
    assert.ok(result.deal_data.communications.some(event => event._voice_unrecognized));
    assert.equal(result.ready_for_analysis, false);
  }
});

test('пустой успешный ответ ASR и неподдерживаемый формат различаются с техсбоем', async () => {
  const collection = collected({
    chats: [{ CHAT_ID: 2 }],
    sessions: [{ session_id: 1, history: { chat: { 2: {} }, files: [{ id: 1, type: 'audio', name: 'empty.ogg' }, { id: 2, type: 'audio', name: 'file.m4a' }], message: { 1: { text: '', params: { FILE_ID: [1, 2] } } } } }],
  });
  const result = await normalizeCommunications({
    collection,
    async resolveFile(id) { return { NAME: id === '1' ? 'empty.ogg' : 'file.m4a', DOWNLOAD_URL: 'https://example.test/audio' }; },
    async transcribeVoice() { return { success: true, formatted_dialog: '' }; },
  });
  assert.equal(result.voice_failures.length, 1);
  assert.equal(result.voice_failures[0].unsupported, true);
  assert.equal(result.voice_failures[0].retryable, false);
  assert.equal(result.deal_data.communications[0]._voice_unrecognized, 2);
});

test('успешная расшифровка остаётся в тексте даже если адаптер не разделил роли', async () => {
  const collection = collected({
    chats: [{ CHAT_ID: 2 }],
    sessions: [{ session_id: 1, history: { chat: { 2: {} }, files: [voiceFile], message: { 1: { text: '', params: { FILE_ID: [101] } } } } }],
  });
  const result = await normalizeCommunications({
    collection,
    async resolveFile() { return { NAME: 'voice.ogg', DOWNLOAD_URL: 'https://example.test/audio' }; },
    async transcribeVoice() { return { success: true, formatted_dialog: 'Участник: готов обсудить' }; },
  });
  assert.equal(result.deal_data.communications[0].text, 'Участник: готов обсудить');
  assert.equal(result.deal_data.communications[0]._has_audio_transcript, true);
});

test('неполный первичный сбор не допускается к нормализации', async () => {
  const collection = collected();
  collection._sources.openlines.complete = false;
  await assert.rejects(normalizeCommunications({ collection }), /не полностью/);
  collection._sources.openlines.complete = true;
  delete collection._sources.tasks;
  await assert.rejects(normalizeCommunications({ collection }), /не полностью/);
});

test('расходящиеся копии сообщения с вложением останавливают нормализацию', async () => {
  const collection = collected({
    chats: [{ CHAT_ID: 2 }],
    sessions: [
      { session_id: 1, history: { chat: { 2: {} }, message: { 7: { id: 7, text: 'Текст' } } } },
      { chat_id: 2, history: { message: { 7: { id: 7, text: 'Текст', params: { FILE_ID: [101] } } }, files: [voiceFile] } },
    ],
  });
  await assert.rejects(normalizeCommunications({ collection }), /версии сообщения/i);
});

test('неопределённый тип вложения разрешается через адаптер или блокирует разбор', async () => {
  const collection = collected({
    chats: [{ CHAT_ID: 2 }],
    sessions: [{ session_id: 1, history: {
      chat: { 2: {} }, files: [{ id: 101, type: 'file' }],
      message: { 1: { senderid: 0, text: '', params: { FILE_ID: [101] } } },
    } }],
  });
  const result = await normalizeCommunications({
    collection,
    async resolveFile() { return { NAME: 'voice.ogg', DOWNLOAD_URL: 'https://example.test/audio' }; },
    async transcribeVoice() { return { success: true, formatted_dialog: 'Участник: хорошо' }; },
  });
  assert.equal(result.deal_data.communications[0].text, 'Участник: хорошо');
  const bad = await normalizeCommunications({ collection, async resolveFile() { return {}; } });
  assert.equal(bad.voice_failures[0].retryable, true);
  assert.equal(bad.voice_failures[0].step, 'disk_file_get');
  assert.equal(bad.ready_for_analysis, false);
});

test('файлы истории с ID в ключе объекта и расширением с точкой не теряются', async () => {
  const collection = collected({
    chats: [{ CHAT_ID: 2 }],
    sessions: [{ session_id: 1, history: {
      chat: { 2: {} }, files: { 101: { type: 'file', extension: '.ogg' } },
      message: { 1: { senderid: 0, text: '', params: { FILE_ID: [101] } } },
    } }],
  });
  let resolvedId;
  const result = await normalizeCommunications({
    collection,
    async resolveFile(id) { resolvedId = id; return { NAME: 'voice.ogg', DOWNLOAD_URL: 'https://example.test/audio' }; },
    async transcribeVoice() { return { success: true, formatted_dialog: 'Участник: понял' }; },
  });
  assert.equal(resolvedId, '101');
  assert.equal(result.deal_data.communications.length, 1);
  assert.equal(result.deal_data.communications[0].text, 'Участник: понял');
});

test('отсутствие формата известного аудио считается сбоем, а не неподдерживаемым форматом', async () => {
  const collection = collected({
    chats: [{ CHAT_ID: 2 }],
    sessions: [{ session_id: 1, history: {
      chat: { 2: {} }, files: { 101: { type: 'audio' } },
      message: { 1: { text: '', params: { FILE_ID: [101] } } },
    } }],
  });
  const result = await normalizeCommunications({ collection, async resolveFile() { return {}; } });
  assert.equal(result.voice_failures[0].retryable, true);
  assert.equal(result.voice_failures[0].step, 'disk_file_get');
  assert.notEqual(result.voice_failures[0].unsupported, true);
});

test('известное OGG без имени в disk.file.get не объявляется неподдерживаемым', async () => {
  const collection = collected({
    chats: [{ CHAT_ID: 2 }],
    sessions: [{ session_id: 1, history: {
      chat: { 2: {} }, files: { 101: { type: 'audio', extension: 'ogg' } },
      message: { 1: { text: '', params: { FILE_ID: [101] } } },
    } }],
  });
  const result = await normalizeCommunications({ collection, async resolveFile() { return { DOWNLOAD_URL: 'https://example.test/audio' }; } });
  assert.equal(result.voice_failures[0].retryable, true);
  assert.notEqual(result.voice_failures[0].unsupported, true);
});

test('успешный ASR без строкового formatted_dialog блокируется, пустая строка допускается', async () => {
  const collection = collected({
    chats: [{ CHAT_ID: 2 }],
    sessions: [{ session_id: 1, history: {
      chat: { 2: {} }, files: [voiceFile], message: { 1: { text: '', params: { FILE_ID: [101] } } },
    } }],
  });
  for (const value of [undefined, null, {}, 3]) {
    const result = await normalizeCommunications({ collection,
      async resolveFile() { return { NAME: 'voice.ogg', DOWNLOAD_URL: 'https://example.test/audio' }; },
      async transcribeVoice() { return { success: true, formatted_dialog: value }; },
    });
    assert.equal(result.voice_failures[0].retryable, true);
  }
  const silence = await normalizeCommunications({ collection,
    async resolveFile() { return { NAME: 'voice.ogg', DOWNLOAD_URL: 'https://example.test/audio' }; },
    async transcribeVoice() { return { success: true, formatted_dialog: '' }; },
  });
  assert.deepEqual(silence.voice_failures, []);
});

test('отдельное вложение неизвестного типа не пропускается как заведомо неаудио', async () => {
  const collection = collected({
    chats: [{ CHAT_ID: 2 }],
    sessions: [{ session_id: 1, history: { chat: { 2: {} }, files: { 5: { type: 'file' } }, message: {} } }],
  });
  await assert.rejects(normalizeCommunications({ collection }), /тип отдельного файла/);
});

test('сообщение только со ссылкой без senderid сохраняется как общение', async () => {
  const collection = collected({
    chats: [{ CHAT_ID: 2 }],
    sessions: [{ session_id: 1, history: {
      chat: { 2: {} }, message: { 1: { text: 'https://example.test/page' } },
    } }],
  });
  const result = await normalizeCommunications({ collection });
  assert.equal(result.deal_data.communications.length, 1);
  assert.equal(result.deal_data.communications[0].text, 'https://example.test/page');
});

test('история без явного списка сообщений не считается пустой', async () => {
  const collection = collected({ sessions: [{ session_id: 1, history: {} }] });
  await assert.rejects(normalizeCommunications({ collection }), /нет списка сообщений/);
  collection.raw.sessions[0].history = { message: {} };
  const result = await normalizeCommunications({ collection });
  assert.deepEqual(result.deal_data.communications, []);
});

test('шаблон служебного сообщения с вложением сохраняется и расшифровывается', async () => {
  const collection = collected({
    chats: [{ CHAT_ID: 2, CONNECTOR_ID: 'wz_test', CONNECTOR_TITLE: 'Wazzup' }],
    sessions: [{ session_id: 1, history: {
      chat: { 2: {} }, files: [voiceFile],
      message: { 1: { senderid: 0, text: 'Сессия завершена', params: { FILE_ID: [101] }, date: '2026-10-18T11:00:00Z' } },
    } }],
  });
  collection.deal_data.lose_date = '2026-10-19T10:00:00Z';
  const result = await normalizeCommunications({
    collection,
    async resolveFile() { return { NAME: 'voice.ogg', DOWNLOAD_URL: 'https://example.test/audio' }; },
    async transcribeVoice() { return { success: true, formatted_dialog: 'Участник чата: речь' }; },
  });
  assert.equal(result.deal_data.communications.length, 1);
  assert.equal(result.deal_data.communications[0]._has_files, true);
  assert.equal(result.deal_data.communications[0].text, 'Сессия завершена\n\n[Голосовое сообщение]: Участник чата: речь');
  const journal = buildJournal(result.deal_data);
  const analytics = buildCommunicationAnalytics(journal, new Date('2026-10-19T12:00:00Z'));
  assert.equal(analytics.comm_analytics.chats_total, 1);
  const assembled = assembleFacts(analytics, 'Тестовый промпт');
  const fact = assembled.facts_packet.facts.find(item => item.source === 'chat_voice_transcript');
  assert.ok(fact);
  assert.equal(fact.actor, 'unknown');
  assert.match(fact.content, /речь/);
});

test('Wazzup: роли из наблюдаемых заголовков, неопределённые авторы и голосовые доходят до фактов', async () => {
  const messages = {
    1: { senderid: 55, text: '=== Исходящее сообщение ===\nПодберём дату замера' },
    2: { senderid: 55, text: '=== Исходящее сообщение, автор: Менеджер (Ольга) ===\nУточните адрес' },
    3: { senderid: 55, text: 'Спасибо, заказали у других' },
    4: { senderid: 55, text: 'Цитата:\n=== Исходящее сообщение, автор: Менеджер (Ольга) ===\nПодберём дату' },
    5: { senderid: 55, text: '=== Входящее сообщение ===\nУточнение' },
    6: { text: 'Сообщение без senderid' },
    7: { senderid: 55, text: '', params: { FILE_ID: [101] } },
    8: { senderid: 77, text: 'Ответ действующего сотрудника' },
    9: { senderid: 55, text: '=== Исходящее сообщение ===\n=== Входящее сообщение ===\nПротиворечивые заголовки' },
    10: { senderid: 55, text: '', params: { FILE_ID: [103] } },
  };
  const collection = collected({
    chats: [{ CHAT_ID: 2, CONNECTOR_ID: 'wz_test', CONNECTOR_TITLE: 'Wazzup' }, { CHAT_ID: 3, CONNECTOR_ID: 'wappi', CONNECTOR_TITLE: 'Wappi' }],
    sessions: [
      { chat_id: 2, session_id: 1, history: { users: { 55: { connector: true }, 77: { active: true, connector: false, extranet: false, externalAuthId: 'default', name: 'Сотрудник' } }, message: messages, files: [voiceFile, { id: 103, name: 'screen.png', type: 'image' }] } },
      { chat_id: 3, session_id: 2, history: { users: { 55: { connector: true }, 77: { name: 'Сотрудник', active:true, connector:false, extranet:false, externalAuthId:'default' } }, message: { 11: { senderid: 55, text: 'Вопрос клиента Wappi' }, 12: { senderid: 77, text: 'Ответ сотрудника Wappi' } }, files: [] } },
    ],
  });
  let voiceRequest;
  const result = await normalizeCommunications({ collection,
    async resolveFile() { return { NAME: 'voice.ogg', DOWNLOAD_URL: 'https://example.test/audio' }; },
    async transcribeVoice(input) { voiceRequest = input; return { success: true, formatted_dialog: 'Участник чата: Голосовое сообщение', total_replicas: 1 }; },
  });
  const events = result.deal_data.communications;
  const event = id => events.find(item => item.message_id === `1_${id}`);
  assert.equal(event(1).role, 'Менеджер');
  assert.equal(event(1).direction, 'outgoing');
  assert.equal(event(2).author_name, 'Ольга');
  assert.equal(event(8).role, 'Менеджер');
  for (const id of [3, 4, 5, 6, 7, 9, 10]) {
    assert.equal(event(id).role, 'unknown', `роль сообщения ${id}`);
    assert.equal(event(id).direction, 'unknown');
    assert.equal(event(id).author_name, 'Участник чата');
    assert.equal(event(id)._wazzup_author_ambiguous, true);
  }
  assert.match(event(4).text, /=== Исходящее сообщение/);
  assert.equal(voiceRequest.call_direction, 'unknown');
  assert.equal(voiceRequest.speaker_role, 'Участник чата');
  assert.equal(events.find(item => item.message_id === '2_11').role, 'Клиент');
  assert.equal(events.find(item => item.message_id === '2_12').role, 'Менеджер');
  const analytics = buildCommunicationAnalytics(buildJournal(result.deal_data));
  const facts = assembleFacts(analytics, 'Тест').facts_packet.facts;
  assert.equal(facts.find(item => item.content.includes('заказали у других')).actor, 'unknown');
  assert.equal(facts.find(item => item.content.includes('Голосовое сообщение')).actor, 'unknown');
  assert.equal(facts.find(item => item.content.includes('Подберём дату замера')).actor, 'manager');
  assert.equal(facts.find(item => item.content.includes('Вопрос клиента Wappi')).actor, 'client');
});

test('неопределённый автор Wazzup сохраняется при ошибке STT и у отдельного файла', async () => {
  const collection = collected({ chats: [{ CHAT_ID: 2, CONNECTOR_ID: 'wz_test' }], sessions: [{ chat_id: 2, session_id: 1, history: {
    users: { 55: { connector: true } }, message: { 1: { senderid: 55, params: { FILE_ID: [101] } } },
    files: [voiceFile, { id: 102, name: 'orphan.ogg', type: 'audio', authorid: 55 }],
  } }] });
  const result = await normalizeCommunications({ collection, async resolveFile() { throw new Error('недоступно'); } });
  assert.equal(result.voice_failures.length, 2);
  assert.equal(result.deal_data.communications.length, 2);
  for (const item of result.deal_data.communications) {
    assert.equal(item._wazzup_author_ambiguous, true);
    assert.equal(item.role, 'unknown');
    assert.equal(item.direction, 'unknown');
    assert.equal(item._voice_unrecognized, 1);
  }
});

test('без ID коннектора или карточки чата автор коннектора остаётся неизвестным', async () => {
  for (const chats of [[], [{ CHAT_ID: 2, CONNECTOR_TITLE: 'Wazzup' }], [{ CHAT_ID: 2, CONNECTOR_ID: '' }]]) {
    const result = await normalizeCommunications({ collection: collected({ chats, sessions: [{ chat_id: 2, session_id: 1, history: {
      users: { 55: { connector: true } }, message: { 1: { senderid: 55, text: 'Содержательный текст' } }, files: [],
    } }] }) });
    const event = result.deal_data.communications[0];
    assert.equal(event.role, 'unknown');
    assert.equal(event.direction, 'unknown');
    assert.equal(event._chat_connector_unknown, true);
    assert.equal(event._wazzup_author_ambiguous, undefined);
  }
});

test('противоречащие друг другу ID и название коннектора не определяют сторону автора', async () => {
  for (const meta of [
    { CONNECTOR_ID: 'wappi', CONNECTOR_TITLE: 'Wazzup' },
    { CONNECTOR_ID: 'arbitrary', CONNECTOR_TITLE: 'Wazzup' },
    { CONNECTOR_ID: 'wz_test', CONNECTOR_TITLE: 'Wappi' },
  ]) {
    const result = await normalizeCommunications({ collection: collected({ chats: [{ CHAT_ID: 2, ...meta }], sessions: [{ chat_id: 2, session_id: 1, history: {
      users: { 55: { active: true, connector: false, extranet: false, externalAuthId: 'default' } }, message: { 1: { senderid: 55, text: 'Содержательный текст' } }, files: [],
    } }] }) });
    const event = result.deal_data.communications[0];
    assert.equal(event.role, 'unknown');
    assert.equal(event._chat_connector_unknown, true);
  }
});

test('структурный заголовок Wazzup с senderid=0 и дополнительными пробелами не отбрасывается как служебный', async () => {
  const result = await normalizeCommunications({ collection: collected({ chats: [{ CHAT_ID: 2, CONNECTOR_ID: 'wz_test' }], sessions: [{ chat_id: 2, session_id: 1, history: {
    message: { 1: { senderid: 0, text: '===   Исходящее сообщение ===\nПодберём дату' } }, files: [],
  } }] }) });
  assert.equal(result.deal_data.communications.length, 1);
  assert.equal(result.deal_data.communications[0].role, 'Менеджер');
  assert.equal(result.deal_data.communications[0].text, 'Подберём дату');
});

test('active без подтверждённых полей пользователя не доказывает авторство менеджера Wazzup', async () => {
  const users = { 55: { active: true, name: 'Пользователь без признаков' }, 56: { active: true, connector: false, extranet: false } };
  const result = await normalizeCommunications({ collection: collected({ chats: [{ CHAT_ID: 2, CONNECTOR_ID: 'wz_test' }], sessions: [{ chat_id: 2, session_id: 1, history: {
    users, message: { 1: { senderid: 55, text: 'Первое сообщение' }, 2: { senderid: 56, text: 'Второе сообщение' } }, files: [],
  } }] }) });
  assert.equal(result.deal_data.communications.length, 2);
  for (const item of result.deal_data.communications) {
    assert.equal(item.role, 'unknown');
    assert.equal(item._wazzup_author_ambiguous, true);
  }
});

test('Wappi не приписывает менеджеру сообщение при неполных признаках пользователя', async () => {
  const users={1:{name:'Неполный'},2:{name:'Сотрудник',active:true,connector:false,extranet:false,externalAuthId:'default'},
    3:{name:'Внешний',connector:true}};
  const collection=collected({chats:[{CHAT_ID:2,CONNECTOR_ID:'opaque',CONNECTOR_TITLE:'Wappi'}],
    sessions:[{session_id:1,history:{chatId:2,chat:{2:{}},users,files:{},message:{
      1:{id:1,senderid:1,text:'Неизвестный автор'},2:{id:2,senderid:2,text:'Сообщение сотрудника'},
      3:{id:3,senderid:3,text:'Сообщение клиента'}}}}]});
  const events=(await normalizeCommunications({collection})).deal_data.communications;
  assert.deepEqual(events.map(x=>x.role),['unknown','Менеджер','Клиент']);
  assert.deepEqual(events.map(x=>x.direction),['unknown','outgoing','incoming']);
});

test('Wappi не приписывает отдельное вложение клиенту без данных автора', async () => {
  const collection=collected({chats:[{CHAT_ID:2,CONNECTOR_ID:'opaque',CONNECTOR_TITLE:'Wappi'}],
    sessions:[{session_id:1,history:{chatId:2,chat:{2:{}},users:{},message:{},
      files:{102:{id:102,name:'orphan.ogg',type:'audio'}}}}]});
  const result=await normalizeCommunications({collection,resolveFile:async()=>{throw Error('disabled');}});
  assert.equal(result.deal_data.communications[0].role,'unknown');
});

test('заголовок входящего Wappi не переопределяет признаки автора и не назначает менеджера', async () => {
  const collection=collected({chats:[{CHAT_ID:2,CONNECTOR_ID:'opaque',CONNECTOR_TITLE:'Wappi'}],
    sessions:[{session_id:1,history:{chatId:2,chat:{2:{}},users:{3:{connector:true}},files:{},message:{
      1:{id:1,senderid:3,text:'=== Входящее сообщение, автор: Клиент (Имя) ===\nВопрос'},
      2:{id:2,text:'Цитата: === Входящее сообщение, автор: Клиент (Имя) ===\nВопрос'}}}}]});
  const events=(await normalizeCommunications({collection})).deal_data.communications;
  assert.deepEqual(events.map(x=>x.role),['Клиент','unknown']);
});

test('processDeal блокирует OGG без имени файла и некорректный успешный ответ ASR', async () => {
  for (const scenario of ['missing_name', 'malformed_transcript']) {
    let judgeCalls = 0;
    let voiceCalls = 0;
    const bitrix = { async request(method, body) {
      if (method === 'crm.deal.userfield.list') return { result: [{ LIST: [{ ID: 4, VALUE: 'Другая' }] }] };
      if (method === 'crm.deal.get') return { result: { ID: '42', STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: '65', UF_CRM_1584703948317: 4 } };
      if (method === 'crm.stagehistory.list') return { result: { items: [{ ID: '101', STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] } };
      if (method === 'crm.activity.list') return { result: body.filter.TYPE_ID ? [] : [{ ASSOCIATED_ENTITY_ID: '80' }] };
      if (method === 'crm.timeline.comment.list') return { result: [] };
      if (method === 'imopenlines.crm.chat.get') return { result: [{ CHAT_ID: 100, CONNECTOR_ID: 'wappi' }] };
      if (method === 'imopenlines.session.history.get') return { result: {
        sessionId: 80, chatId: 100, chat: { 100: {} }, files: { 101: { type: 'audio', extension: 'ogg' } },
        users: { 55: { connector: true } },
        message: { 1: { senderid: 55, text: '', params: { FILE_ID: [101] } } },
      } };
      if (method === 'tasks.task.list') return { result: { tasks: [] } };
      throw new Error('Неожиданный метод');
    } };
    const result = await processDeal({
      dealId: 42, bitrix, nowMs: Date.parse('2026-11-05T00:00:00Z'), wait: async () => {},
      audioWaitEnabledAt: '2026-11-01T00:00:00Z',
      judgeSystemPrompt: 'Промпт судьи', writerSystemPrompt: 'Промпт писателя',
      async resolveFile() { return { ...(scenario === 'missing_name' ? {} : { NAME: 'voice.ogg' }), DOWNLOAD_URL: 'https://example.test/audio' }; },
      async transcribe() { voiceCalls++; return { success: true }; },
      llm: { async complete() { judgeCalls++; throw new Error('Судья не должен вызываться'); } },
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.pipelineGate.kind, 'recognition');
    assert.equal(result.analysis, undefined);
    assert.equal(judgeCalls, 0);
    assert.equal(voiceCalls, scenario === 'missing_name' ? 0 : 1);
  }
});
