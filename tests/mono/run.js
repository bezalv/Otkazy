// Моки на моно-записи звонков (prototype/lib/mono-transcript.js).
//
// Три случая из задания: моно с живым разговором, моно только с роботом, стерео как раньше.
// Проверяется:
//   1. признак режима — по пометке _transcript_mode и по тексту, когда пометки нет;
//   2. моно даёт ОДИН факт source=call_transcript, actor=unknown, без префикса «Говорящий:»;
//   3. слов моно-записи нет ни в одном факте с actor=client или actor=manager;
//   4. детектор «разговора не было» отрабатывает раньше и забирает роботов себе;
//   5. стерео-звонок по-прежнему даёт два факта по сторонам.
//
// Запуск: node tests/mono/run.js
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..', '..');
var monoSrc = fs.readFileSync(path.join(ROOT, 'prototype', 'lib', 'mono-transcript.js'), 'utf8');
var M = new Function(monoSrc + '\nreturn { isMonoTranscript: isMonoTranscript, detectTranscriptMode: detectTranscriptMode, stripMonoPrefix: stripMonoPrefix, monoWholeText: monoWholeText, monoFactContent: monoFactContent, monoByText: monoByText };')();

var ncSrc = fs.readFileSync(path.join(ROOT, 'prototype', 'lib', 'no-conversation.js'), 'utf8');
var NC = new Function(ncSrc + '\nreturn { detectNoConversation: detectNoConversation };')();

var pass = 0, fail = 0;
function check(name, cond, hint) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (hint ? '\n       ' + hint : '')); }
}
function eq(name, got, want) {
  check(name, got === want, 'получил: ' + JSON.stringify(got) + '\n       ожидал:  ' + JSON.stringify(want));
}

// ── Слепок ветки звонка из ноды agent-facts-assembler ───────────────────────
// Повторяет порядок развилок: детектор «разговора не было» → моно → стороны.
// При правке ноды править и здесь: тест стережёт именно порядок.
function buildCallFacts(c) {
  var facts = [];
  var dur = c.duration_seconds || 0;
  var isMono = M.isMonoTranscript(c);
  var noTalk = NC.detectNoConversation(c.transcript_client_text, c.transcript_manager_text, dur, isMono);
  if (noTalk) {
    facts.push({ source: 'call_event', actor: 'system', reason: noTalk.reason });
    return facts;
  }
  if (isMono) {
    var monoContent = M.monoFactContent(c);
    if (monoContent) {
      facts.push({ source: 'call_transcript', actor: 'unknown', content: monoContent, transcript_mode: 'mono' });
    } else {
      facts.push({ source: 'call_event', actor: 'system', content: 'без транскрипта' });
    }
    return facts;
  }
  var hasMgr = c.transcript_manager_text && c.transcript_manager_text.trim().length > 0;
  var hasCli = c.transcript_client_text && c.transcript_client_text.trim().length > 0;
  if (hasMgr) facts.push({ source: 'call_transcript', actor: 'manager', content: c.transcript_manager_text.trim() });
  if (hasCli) facts.push({ source: 'call_transcript', actor: 'client', content: c.transcript_client_text.trim() });
  if (!hasMgr && !hasCli) facts.push({ source: 'call_event', actor: 'system', content: 'без транскрипта' });
  return facts;
}

// ── Моки ────────────────────────────────────────────────────────────────────
// Живой моно-разговор: в одной дорожке и менеджер, и клиент. Текст сокращён, строй речи
// как в базе (сделка 107355): приветствие, обсуждение расчёта, перенос решения.
var MONO_ZHIVOY_TEXT = 'Да, Виталий, ещё раз добрый вечер, сейчас удобно пообщаться? Да, всё замечательно, '
  + 'смотрите, вы оставили расчёт на два окна. Получается, по вашим размерам выходит сто двадцать восемь тысяч. '
  + 'Дорого, я думал тысяч на тридцать меньше. Понимаю, давайте посмотрим профиль попроще. Нет, я пока отложу, '
  + 'весной вернёмся к этому вопросу.';

var monoZhivoy = {
  type: 'call', direction: 'outgoing', duration_seconds: 378,
  transcript: 'Говорящий: ' + MONO_ZHIVOY_TEXT,
  transcript_manager_text: MONO_ZHIVOY_TEXT,
  transcript_client_text: '',
  _transcript_mode: 'mono'
};

// Тот же звонок, но пометки режима нет — признак должен найтись по тексту.
var monoBezPometki = {
  type: 'call', direction: 'outgoing', duration_seconds: 378,
  transcript: 'Говорящий: ' + MONO_ZHIVOY_TEXT,
  transcript_manager_text: 'Говорящий: ' + MONO_ZHIVOY_TEXT,
  transcript_client_text: ''
};

// Моно, в котором только служебка оператора: ровно те 43 символа, что лежат у 50 записей базы.
var monoRobot = {
  type: 'call', direction: 'outgoing', duration_seconds: 8,
  transcript: 'Говорящий: Пожалуйста, подождите завершение обработки.',
  transcript_manager_text: 'Пожалуйста, подождите завершение обработки.',
  transcript_client_text: '',
  _transcript_mode: 'mono'
};

// Моно с автоответчиком клиента. Формулировка — самая частая в базе (366 звонков).
var monoAvtootvetchik = {
  type: 'call', direction: 'outgoing', duration_seconds: 14,
  transcript: 'Говорящий: Абонент не может ответить на ваш звонок, оставьте сообщение после звукового сигнала.',
  transcript_manager_text: 'Абонент не может ответить на ваш звонок, оставьте сообщение после звукового сигнала.',
  transcript_client_text: '',
  _transcript_mode: 'mono'
};

// Стерео: как было всегда, стороны разделены.
var stereo = {
  type: 'call', direction: 'outgoing', duration_seconds: 240,
  transcript: 'Менеджер: Добрый день, это Ольга с завода.\nКлиент: Да, здравствуйте.',
  transcript_manager_text: 'Добрый день, это Ольга с завода. По вашему расчёту вышло сто двадцать восемь тысяч, давайте подберём профиль попроще.',
  transcript_client_text: 'Да, здравствуйте. Дорого, я думал тысяч на тридцать меньше. Я пока отложу, весной вернёмся.',
  _transcript_mode: 'stereo'
};

console.log('=== Признак режима ===');
check('моно по пометке', M.isMonoTranscript(monoZhivoy));
check('моно по тексту, когда пометки нет', M.isMonoTranscript(monoBezPometki));
check('стерео не считается моно', !M.isMonoTranscript(stereo));
check('пустая запись не считается моно', !M.isMonoTranscript({ type: 'call' }));
check('пометка stereo сильнее текста', !M.isMonoTranscript({ _transcript_mode: 'stereo', transcript: 'Говорящий: алло' }));
check('слово «говорящий» в середине фразы признаком не является',
  !M.monoByText('Менеджер: не слышно, кто там говорящий на линии'));

console.log('\n=== Режим по ответу подворкфлоу ===');
eq('пометка моно', M.detectTranscriptMode({ _transcript_mode: 'mono' }), 'mono');
eq('channel_count=1 без пометки', M.detectTranscriptMode({ channel_count: 1, formatted_dialog: 'Говорящий: алло' }), 'mono');
eq('стерео-ответ', M.detectTranscriptMode({ channel_count: 2, formatted_dialog: 'Менеджер: алло\nКлиент: да' }), 'stereo');
eq('без пометки и без channel_count — по тексту',
  M.detectTranscriptMode({ formatted_dialog: 'Говорящий: алло, да' }), 'mono');

console.log('\n=== Снятие префикса ===');
eq('один префикс в начале', M.stripMonoPrefix('Говорящий: алло, да'), 'алло, да');
eq('префикс в каждой строке',
  M.stripMonoPrefix('Говорящий: алло\nГоворящий: да, слушаю'), 'алло\nда, слушаю');
eq('префикс с лишними пробелами', M.stripMonoPrefix('  Говорящий : алло'.replace(' : ', ': ')), 'алло');
check('слова «Говорящий» внутри текста не теряются',
  M.stripMonoPrefix('Говорящий: не слышно, кто говорящий').indexOf('кто говорящий') !== -1);
eq('пустой текст', M.stripMonoPrefix(''), '');

console.log('\n=== Моно с живым разговором ===');
var fZhivoy = buildCallFacts(monoZhivoy);
eq('ровно один факт', fZhivoy.length, 1);
eq('source', fZhivoy[0].source, 'call_transcript');
eq('actor', fZhivoy[0].actor, 'unknown');
check('префикса «Говорящий:» в факте нет', fZhivoy[0].content.indexOf('Говорящий:') === -1, fZhivoy[0].content.slice(0, 80));
check('в факте есть пометка, что сторон нет', fZhivoy[0].content.indexOf('без разделения сторон') !== -1);
check('речь клиента сохранена', fZhivoy[0].content.indexOf('я пока отложу') !== -1 || fZhivoy[0].content.indexOf('Нет, я пока отложу') !== -1);
check('речь менеджера сохранена', fZhivoy[0].content.indexOf('сто двадцать восемь тысяч') !== -1);
check('ни одного факта с actor=client', fZhivoy.filter(function (f) { return f.actor === 'client'; }).length === 0);
check('ни одного факта с actor=manager', fZhivoy.filter(function (f) { return f.actor === 'manager'; }).length === 0);

var fBezPometki = buildCallFacts(monoBezPometki);
eq('без пометки — тоже один факт', fBezPometki.length, 1);
eq('без пометки — actor unknown', fBezPometki[0].actor, 'unknown');
check('без пометки префикс тоже снят', fBezPometki[0].content.indexOf('Говорящий:') === -1);

console.log('\n=== Моно только с роботом: забирает детектор ===');
var fRobot = buildCallFacts(monoRobot);
eq('один факт', fRobot.length, 1);
eq('это call_event, а не транскрипт', fRobot[0].source, 'call_event');
eq('actor system', fRobot[0].actor, 'system');
check('фактов call_transcript нет вовсе',
  fRobot.filter(function (f) { return f.source === 'call_transcript'; }).length === 0);

var fAvto = buildCallFacts(monoAvtootvetchik);
eq('автоответчик: один факт', fAvto.length, 1);
eq('автоответчик: call_event', fAvto[0].source, 'call_event');
check('автоответчик не стал репликой', fAvto[0].actor === 'system');

console.log('\n=== Стерео работает как раньше ===');
var fStereo = buildCallFacts(stereo);
eq('два факта', fStereo.length, 2);
eq('первый — менеджер', fStereo[0].actor, 'manager');
eq('второй — клиент', fStereo[1].actor, 'client');
check('в стерео-фактах нет пометки про отсутствие сторон',
  fStereo.every(function (f) { return f.content.indexOf('без разделения сторон') === -1; }));
check('actor=unknown в стерео не появляется',
  fStereo.filter(function (f) { return f.actor === 'unknown'; }).length === 0);

console.log('\n=== Пограничные ===');
var monoPusto = { type: 'call', duration_seconds: 120, transcript: 'Говорящий: ', transcript_manager_text: '', transcript_client_text: '', _transcript_mode: 'mono' };
var fPusto = buildCallFacts(monoPusto);
eq('моно без текста — не транскрипт', fPusto[0].source, 'call_event');
check('моно без текста не даёт факт actor=unknown с пустым content',
  fPusto.filter(function (f) { return f.source === 'call_transcript'; }).length === 0);

// Моно, где подворкфлоу всё же положил что-то в канал клиента: сторон всё равно нет.
var monoOba = {
  type: 'call', duration_seconds: 200, _transcript_mode: 'mono',
  transcript_manager_text: 'Говорящий: Добрый день, это завод пластиковых окон, по вашему расчёту.',
  transcript_client_text: 'Говорящий: Да, слушаю, но мне сейчас неудобно, перезвоните на следующей неделе.'
};
var fOba = buildCallFacts(monoOba);
eq('оба канала — всё равно один факт', fOba.length, 1);
eq('оба канала — actor unknown', fOba[0].actor, 'unknown');
check('текст обоих каналов сохранён',
  fOba[0].content.indexOf('это завод') !== -1 && fOba[0].content.indexOf('перезвоните на следующей неделе') !== -1);
check('префиксов не осталось', fOba[0].content.indexOf('Говорящий:') === -1);

console.log('\n=== Proof Validator: пруф со ссылкой на unknown ===');
// Слепок правила из ноды agent-judge-parse: ссылка на моно-запись как на слова стороны.
function proofWarning(proofType, fact) {
  var speech = ['call_transcript', 'chat', 'chat_voice_transcript', 'screenshot_chat'];
  if (proofType !== 'client_statement' && proofType !== 'manager_statement') return null;
  if (fact.actor === 'unknown' && speech.indexOf(fact.source) !== -1) {
    return { severity: 'warning', kind: 'unknown_actor' };
  }
  if (fact.actor !== (proofType === 'client_statement' ? 'client' : 'manager') || speech.indexOf(fact.source) === -1) {
    return { severity: 'error', kind: 'wrong_actor' };
  }
  return null;
}
var wMono = proofWarning('client_statement', { actor: 'unknown', source: 'call_transcript' });
check('client_statement на моно-запись — предупреждение', wMono && wMono.severity === 'warning', JSON.stringify(wMono));
eq('и помечено как unknown_actor', wMono.kind, 'unknown_actor');
var wMgr = proofWarning('manager_statement', { actor: 'unknown', source: 'call_transcript' });
check('manager_statement на моно-запись — предупреждение', wMgr && wMgr.severity === 'warning');
check('ссылка на crm_comment как на слова клиента осталась ошибкой',
  proofWarning('client_statement', { actor: 'manager', source: 'crm_comment' }).severity === 'error');
check('правильный пруф не ругается',
  proofWarning('client_statement', { actor: 'client', source: 'call_transcript' }) === null);
check('metric-пруф этой проверкой не затронут',
  proofWarning('metric', { actor: 'unknown', source: 'call_transcript' }) === null);

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
if (fail > 0) process.exit(1);
