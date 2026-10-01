// Моки на полноту данных и блокировку вердикта (prototype/lib/pipeline-gate.js), шаг Б.
//
// Четыре случая из задания: сбой распознавания, тишина, сбор неполный, третья неудача.
// Плюс границы: неподдерживаемые форматы, звонки без записи, моно после моно-прохода.
//
// Запуск: node tests/pipeline-gate/run.js
var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '..', '..', 'prototype', 'lib', 'pipeline-gate.js'), 'utf8');
var L = new Function(src + '\nreturn {' + [
  'PG_SOURCES', 'PG_MAX_ATTEMPTS', 'pgSourceLabel', 'pgInitMarks', 'pgMarkComplete', 'pgMarkFailed',
  'pgIncompleteSources', 'pgVoiceUnsupported', 'pgIsRecognitionFailure', 'pgRecognitionFailures',
  'pgDecide', 'pgUnrecognizedCallFact', 'pgChannelsMismatch', 'pgCallDuration', 'PG_SILENCE_MAX_SEC'
].map(function (n) { return n + ':' + n; }).join(',') + '};')();

var pass = 0, fail = 0;
function check(name, cond, hint) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (hint ? '\n       ' + hint : '')); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    'получил: ' + JSON.stringify(got) + '\n       ожидал:  ' + JSON.stringify(want));
}

// Все источники прочитаны — основа для случаев, где дело не в сборе.
function vseProchitano() {
  var m = L.pgInitMarks();
  for (var k in L.PG_SOURCES) L.pgMarkComplete(m, k, 1);
  return m;
}

console.log('=== Отметки полноты ===');
var marks0 = L.pgInitMarks();
eq('до сбора все источники считаются непрочитанными',
  L.pgIncompleteSources(marks0).sort(), ['calls', 'comments', 'openlines', 'tasks']);
eq('после полного сбора неполных нет', L.pgIncompleteSources(vseProchitano()), []);

var marksPart = vseProchitano();
L.pgMarkFailed(marksPart, 'openlines', new Error('503 Service Unavailable'), 3);
eq('упавший источник виден', L.pgIncompleteSources(marksPart), ['openlines']);
check('у упавшего источника сохранён текст ошибки', /503/.test(marksPart.openlines.error));
eq('и число попыток', marksPart.openlines.attempts, 3);

eq('пустая карта — всё непрочитано',
  L.pgIncompleteSources({}).sort(), ['calls', 'comments', 'openlines', 'tasks']);
eq('карты нет вовсе — тоже всё непрочитано',
  L.pgIncompleteSources(null).length, 4);
check('источник с complete:false считается непрочитанным',
  L.pgIncompleteSources({ calls: { complete: false } }).indexOf('calls') !== -1);
eq('русские названия для pipeline_error', L.pgSourceLabel('calls'), 'звонки');
eq('название открытых линий', L.pgSourceLabel('openlines'), 'открытые линии');

console.log('\n=== Сбор неполный: блокирует всегда ===');
var dCollect = L.pgDecide({ sources: marksPart, recognition: {} });
check('блокирует', dCollect.block === true);
eq('вид сбоя', dCollect.kind, 'collect');
eq('текст ошибки', dCollect.pipeline_error, 'сбор неполный: открытые линии');
check('помечено как окончательное — повтор не поможет сам собой', dCollect.final === true);

var dCollectLast = L.pgDecide({ sources: marksPart, recognition: {}, last_attempt: true });
check('и на третьей попытке тоже блокирует: без данных вердикта нет', dCollectLast.block === true);
eq('на третьей попытке вид тот же', dCollectLast.kind, 'collect');

var marksTwo = vseProchitano();
L.pgMarkFailed(marksTwo, 'calls', 'timeout', 3);
L.pgMarkFailed(marksTwo, 'tasks', 'ECONNRESET', 3);
eq('два источника перечисляются через запятую',
  L.pgDecide({ sources: marksTwo, recognition: {} }).pipeline_error, 'сбор неполный: звонки, задачи');

console.log('\n=== Технический сбой распознавания ===');
var recCall = { calls: [{ activity_id: '555', retryable: true, error: '503 upstream' }] };
var dRec = L.pgDecide({ sources: vseProchitano(), recognition: recCall });
check('блокирует', dRec.block === true);
eq('вид сбоя', dRec.kind, 'recognition');
check('в тексте виден звонок', /звонок 555/.test(dRec.pipeline_error), dRec.pipeline_error);
check('не помечено окончательным — повтор имеет смысл', dRec.final === false);

var dVoice = L.pgDecide({
  sources: vseProchitano(),
  recognition: { voices: [{ file_id: '77', retryable: true, error: 'ETIMEDOUT', file_name: 'audio.ogg' }] }
});
check('сбой голосового блокирует', dVoice.block === true);
check('в тексте сказано «голосовое»', /голосовое 77/.test(dVoice.pipeline_error));

var dScr = L.pgDecide({
  sources: vseProchitano(),
  recognition: { screenshots: [{ id: 'f9', retryable: true, error: '500' }] }
});
check('сбой скриншота блокирует', dScr.block === true);
check('в тексте сказано «скриншот»', /скриншот f9/.test(dScr.pipeline_error));

console.log('\n=== Тишина и прочее, что НЕ блокирует ===');
var dSilence = L.pgDecide({
  sources: vseProchitano(),
  recognition: { calls: [{ activity_id: '1', retryable: false, error: '' }] }
});
check('пустой результат без ошибки вердикт не держит', dSilence.block === false);
eq('и вид решения обычный', dSilence.kind, 'ok');

check('звонок вообще без признака retryable не считается сбоем',
  !L.pgIsRecognitionFailure({ activity_id: '2', error: 'пусто' }));
check('моно-запись после моно-прохода не сбой',
  !L.pgIsRecognitionFailure({ activity_id: '3', retryable: false, channels_mismatch: true }));
check('m4a голосовое — известное ограничение, не сбой',
  !L.pgIsRecognitionFailure({ retryable: true, file_name: 'golos.m4a' }));
check('wav голосовое — тоже', !L.pgIsRecognitionFailure({ retryable: true, file_name: 'golos.WAV' }));
check('ogg голосовое со сбоем — настоящий сбой',
  L.pgIsRecognitionFailure({ retryable: true, file_name: 'golos.ogg' }));
check('явно помеченное unsupported не сбой',
  !L.pgIsRecognitionFailure({ retryable: true, unsupported: true, file_name: 'x.ogg' }));
check('m4a распознаётся по расширению', L.pgVoiceUnsupported('файл.m4a'));
check('ogg не в списке неподдерживаемых', !L.pgVoiceUnsupported('файл.ogg'));

var dEmpty = L.pgDecide({ sources: vseProchitano(), recognition: { calls: [], voices: [], screenshots: [] } });
check('всё чисто — не блокирует', dEmpty.block === false);
eq('вид решения', dEmpty.kind, 'ok');

console.log('\n=== Длинная запись с отказом по каналам — это сбой, а не тишина ===');
// Повод: 124041, входящий на 863 секунды. Моно отбился по каналам, ошибка считалась
// неповторяемой, судья вынес «неправомерен» — а в записи клиент говорил про конкурента.
var KANALY = 'Audio has 2 channels, but 1 requested in specification';
check('863 сек — считаем сбоем',
  L.pgIsRecognitionFailure({ activity_id: '1', retryable: false, error: KANALY, duration_sec: 863 }));
check('31 сек — уже сбой (порог 30)',
  L.pgIsRecognitionFailure({ retryable: false, error: KANALY, duration_sec: 31 }));
check('ровно 30 сек — ещё тишина',
  !L.pgIsRecognitionFailure({ retryable: false, error: KANALY, duration_sec: 30 }));
check('6 сек — тишина, как было',
  !L.pgIsRecognitionFailure({ retryable: false, error: KANALY, duration_sec: 6 }));
check('0 сек — тишина',
  !L.pgIsRecognitionFailure({ retryable: false, error: KANALY, duration_sec: 0 }));
check('длительности нет — не придумываем сбой',
  !L.pgIsRecognitionFailure({ retryable: false, error: KANALY }));
check('длинный звонок, но ошибка не про каналы — не сбой',
  !L.pgIsRecognitionFailure({ retryable: false, error: 'пустой результат', duration_sec: 400 }));
check('длинный звонок с неподдерживаемым форматом — не сбой',
  !L.pgIsRecognitionFailure({ retryable: false, error: KANALY, duration_sec: 400, unsupported: true }));
eq('порог вынесен константой', L.PG_SILENCE_MAX_SEC, 30);

var dDlinnyy = L.pgDecide({
  sources: vseProchitano(),
  recognition: { calls: [{ activity_id: '1583401', retryable: false, error: KANALY, duration_sec: 863 }] }
});
check('такая сделка блокируется', dDlinnyy.block === true);
eq('и это сбой распознавания', dDlinnyy.kind, 'recognition');
check('значит уйдёт в ночной повтор', dDlinnyy.final === false);

var dKorotkiy = L.pgDecide({
  sources: vseProchitano(),
  recognition: { calls: [{ activity_id: '1520243', retryable: false, error: KANALY, duration_sec: 6 }] }
});
check('а шестисекундный сброс вердикт не держит', dKorotkiy.block === false);

console.log('\n=== Длительность звонка из duration_start/duration_end ===');
eq('поля duration_seconds нет — считаем из границ',
  L.pgCallDuration({ duration_start: '2026-08-17T14:08:07+03:00', duration_end: '2026-08-17T14:08:13+03:00' }), 6);
eq('длинный звонок', L.pgCallDuration({ duration_start: '2026-09-23T11:26:33+03:00', duration_end: '2026-09-23T11:40:56+03:00' }), 863);
eq('поле есть — берём его', L.pgCallDuration({ duration_seconds: 42 }), 42);
eq('границ нет', L.pgCallDuration({}), 0);
eq('конец раньше начала', L.pgCallDuration({ duration_start: '2026-08-17T14:08:13+03:00', duration_end: '2026-08-17T14:08:07+03:00' }), 0);
eq('мусор в датах', L.pgCallDuration({ duration_start: 'нет', duration_end: 'нет' }), 0);

console.log('\n=== Отказ по каналам: тот же текст, что в stt-reliability ===');
check('формулировка СПИН', L.pgChannelsMismatch(KANALY));
check('без «in specification»', L.pgChannelsMismatch('Audio has 1 channels, but 2 requested'));
check('посторонняя ошибка', !L.pgChannelsMismatch('503 upstream'));

console.log('\n=== Третья попытка: сделку больше не держим ===');
var dLast = L.pgDecide({ sources: vseProchitano(), recognition: recCall, last_attempt: true });
check('не блокирует', dLast.block === false);
eq('но сбой записан в решении', dLast.kind, 'recognition_accepted');
eq('и перечислен', dLast.failures.length, 1);
eq('с видом и номером', [dLast.failures[0].kind, dLast.failures[0].id], ['звонок', '555']);
eq('порог попыток', L.PG_MAX_ATTEMPTS, 3);

console.log('\n=== Факт для нераспознанного звонка ===');
var factUnrec = L.pgUnrecognizedCallFact('outgoing', 185, true);
check('сказано, что запись есть', /запись есть/.test(factUnrec));
check('сказано, что не распознана', /не распознана/.test(factUnrec));
check('сказано, что содержание неизвестно', /содержание неизвестно/.test(factUnrec));
check('длительность на месте', /185 сек/.test(factUnrec));
check('направление на месте', /outgoing/.test(factUnrec));
check('нет слов, которые судья прочтёт как отсутствие разговора',
  factUnrec.indexOf('без транскрипта') === -1 && factUnrec.indexOf('не отвечал') === -1);

var factNoRec = L.pgUnrecognizedCallFact('incoming', 0, false);
check('звонок без записи описан иначе', /записи нет/.test(factNoRec));
check('и не говорит про нераспознанную запись', factNoRec.indexOf('не распознана') === -1);

console.log('\n=== Порядок проверок: сбор важнее распознавания ===');
var dBoth = L.pgDecide({ sources: marksPart, recognition: recCall });
eq('при двух бедах сначала сообщаем про сбор', dBoth.kind, 'collect');
check('и текст про сбор', /сбор неполный/.test(dBoth.pipeline_error));

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
if (fail > 0) process.exit(1);
