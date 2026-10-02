// Моки на голосовые из чатов (prototype/lib/chat-voice.js), пункт 8.
//
// Проверяется: сообщение с голосовым даёт ОДИН факт chat_voice_transcript, без голосового —
// chat, расшифровка в фактах не удваивается, имя файла в содержание не попадает,
// журнал не печатает расшифровку второй раз.
//
// Запуск: node tests/chat-voice/run.js
var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '..', '..', 'prototype', 'lib', 'chat-voice.js'), 'utf8');
var L = new Function(src + '\nreturn { chatHasVoice: chatHasVoice, chatFactSource: chatFactSource, chatFactContent: chatFactContent };')();

var pass = 0, fail = 0;
function check(name, cond, hint) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (hint ? '\n       ' + hint : '')); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    'получил: ' + JSON.stringify(got) + '\n       ожидал:  ' + JSON.stringify(want));
}

// Моки по реальным данным: сделка 123831, голосовые клиента; 122899, голосовые менеджера.
var GOLOS_KLIENTA = {
  type: 'chat', role: 'client', direction: 'incoming', author_name: 'Клиент',
  date: '2026-09-17T11:45:49+03:00', channel: 'wazzup',
  text: 'eb605f8f-9810-477d-9ebc-91d138affd61.ogg\n\n[Голосовое сообщение]: Вера, а подскажите 2 коммерческих, это что? То есть 167 2 это что, под ключ, или это все суммировать надо?',
  transcript: 'Клиент: Вера, а подскажите 2 коммерческих, это что? То есть 167 2 это что, под ключ, или это все суммировать надо?'
};
var TEKST_BEZ_GOLOSA = {
  type: 'chat', role: 'manager', direction: 'outgoing', author_name: 'Вера',
  date: '2026-09-17T11:50:00+03:00', channel: 'wazzup',
  text: 'Добрый день! Отправила расчёт на два окна, посмотрите, пожалуйста.'
};
var GOLOS_BEZ_TEKSTA = {
  type: 'chat', role: 'client', direction: 'incoming',
  text: '[Голосовое сообщение]: Да, всё верно, спасибо.',
  _has_audio_transcript: true
};
var GOLOS_NERASPOZNAN = {
  type: 'chat', role: 'client', direction: 'incoming',
  text: '[голосовое сообщение, не распознано]',
  _voice_unrecognized: true
};

console.log('=== Признак голосового ===');
check('есть transcript — голосовое', L.chatHasVoice(GOLOS_KLIENTA));
check('есть _has_audio_transcript — голосовое', L.chatHasVoice(GOLOS_BEZ_TEKSTA));
check('обычное сообщение — не голосовое', !L.chatHasVoice(TEKST_BEZ_GOLOSA));
check('нераспознанное голосовое без признаков — не голосовое', !L.chatHasVoice(GOLOS_NERASPOZNAN));
check('пустой transcript не считается', !L.chatHasVoice({ text: 'привет', transcript: '   ' }));
check('пустой вход', !L.chatHasVoice(null));

console.log('\n=== Источник факта ===');
eq('голосовое → chat_voice_transcript', L.chatFactSource(GOLOS_KLIENTA), 'chat_voice_transcript');
eq('текст → chat', L.chatFactSource(TEKST_BEZ_GOLOSA), 'chat');
eq('голосовое без текста → chat_voice_transcript', L.chatFactSource(GOLOS_BEZ_TEKSTA), 'chat_voice_transcript');
eq('нераспознанное → chat', L.chatFactSource(GOLOS_NERASPOZNAN), 'chat');

console.log('\n=== Содержание факта: имя файла убрано ===');
var content = L.chatFactContent(GOLOS_KLIENTA);
check('имени файла нет', content.indexOf('.ogg') === -1, content.slice(0, 80));
check('идентификатора файла нет', content.indexOf('eb605f8f') === -1);
check('расшифровка на месте', content.indexOf('Вера, а подскажите 2 коммерческих') !== -1);
check('пометка «Голосовое сообщение» сохранена', content.indexOf('[Голосовое сообщение]') !== -1);
eq('обычное сообщение не меняется', L.chatFactContent(TEKST_BEZ_GOLOSA),
  'Добрый день! Отправила расчёт на два окна, посмотрите, пожалуйста.');
eq('пустой текст', L.chatFactContent({ text: '' }), '');
eq('только имя файла и ничего больше', L.chatFactContent({ text: 'abc12345.ogg\n\n' }), '');
check('текст, начинающийся со слова с точкой, не режется',
  L.chatFactContent({ text: 'Окна.ogg это не файл, а опечатка\nвторая строка' }).indexOf('Окна.ogg') === 0);
eq('mp3 тоже убирается', L.chatFactContent({ text: 'deadbeef-1234.mp3\n\nТекст после' }), 'Текст после');

console.log('\n=== Один факт вместо двух ===');
// Слепок ветки chat из ноды agent-facts-assembler после правки.
function buildChatFacts(c) {
  var facts = [];
  var txt = L.chatFactContent(c);
  if (!txt) return facts;
  var actor = 'unknown';
  if (c.role === 'client' || (c.direction === 'incoming' && c.author_name === 'Клиент')) actor = 'client';
  else if (c.role === 'manager' || c.direction === 'outgoing') actor = 'manager';
  facts.push({ source: L.chatFactSource(c), actor: actor, content: txt });
  return facts;
}

var fGolos = buildChatFacts(GOLOS_KLIENTA);
eq('голосовое даёт ровно один факт', fGolos.length, 1);
eq('и это chat_voice_transcript', fGolos[0].source, 'chat_voice_transcript');
eq('актор — клиент', fGolos[0].actor, 'client');
check('расшифровка в факте одна', fGolos.filter(function (f) {
  return f.content.indexOf('подскажите 2 коммерческих') !== -1;
}).length === 1);

var fTekst = buildChatFacts(TEKST_BEZ_GOLOSA);
eq('обычное сообщение даёт один факт', fTekst.length, 1);
eq('и это chat', fTekst[0].source, 'chat');
eq('актор — менеджер', fTekst[0].actor, 'manager');

// Было до правки: два факта с одним и тем же текстом.
function buildChatFactsStaryy(c) {
  var facts = [];
  var txt = (c.text || '').trim();
  if (!txt) return facts;
  facts.push({ source: 'chat', content: txt });
  if (c.transcript && c.transcript.trim().length > 0) {
    facts.push({ source: 'chat_voice_transcript', content: c.transcript.trim() });
  }
  return facts;
}
eq('до правки было два факта', buildChatFactsStaryy(GOLOS_KLIENTA).length, 2);
eq('после правки один', buildChatFacts(GOLOS_KLIENTA).length, 1);

console.log('\n=== Журнал: расшифровка печатается один раз ===');
// Слепок ветки чата из ноды «Блок 4: Хронологический журнал» после правки.
function zhurnalLine(d) {
  var line = '[дата] СООБЩЕНИЕ (wazzup)';
  var txt = L.chatFactContent(d);
  if (txt && txt !== '[Голосовое сообщение]') line += '\n' + txt;
  return line;
}
var stroka = zhurnalLine(GOLOS_KLIENTA);
var vhozhdeniy = stroka.split('подскажите 2 коммерческих').length - 1;
eq('расшифровка в строке журнала одна', vhozhdeniy, 1);
check('блока «Транскрипт голосового» больше нет', stroka.indexOf('Транскрипт голосового') === -1);
check('имени файла в журнале нет', stroka.indexOf('.ogg') === -1);

// Было до правки: текст плюс отдельный блок с той же расшифровкой.
function zhurnalLineStaryy(d) {
  var line = '[дата] СООБЩЕНИЕ (wazzup)';
  if (d.text && d.text.length > 0) line += '\n' + d.text.trim();
  if (d.transcript && d.transcript.length > 0) line += '\n--- Транскрипт голосового ---\n' + d.transcript + '\n--- Конец транскрипта ---';
  return line;
}
eq('до правки расшифровка печаталась дважды',
  zhurnalLineStaryy(GOLOS_KLIENTA).split('подскажите 2 коммерческих').length - 1, 2);

console.log('\n=== Пограничные ===');
eq('голосовое без распознавания даёт факт chat с заглушкой',
  buildChatFacts(GOLOS_NERASPOZNAN)[0].source, 'chat');
check('заглушка в содержании сохранена',
  buildChatFacts(GOLOS_NERASPOZNAN)[0].content.indexOf('не распознано') !== -1);
eq('сообщение только с именем файла фактов не даёт', buildChatFacts({ type: 'chat', text: 'abc12345.ogg\n\n' }).length, 0);
eq('актор не определён — unknown', buildChatFacts({ type: 'chat', text: 'текст' })[0].actor, 'unknown');

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
if (fail > 0) process.exit(1);
