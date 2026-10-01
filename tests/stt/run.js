// Моки на надёжность транскрипции (prototype/lib/stt-reliability.js), пункт 4 документа.
//
// Ветки, которые проверяются:
//   1. временная помеха против постоянной ошибки;
//   2. отказ по числу каналов → моно-проход, retryable=false;
//   3. ответ операции с error → success:false, а не пустая запись;
//   4. счётчик попыток берёт attempt из предыдущей итерации, предел 60 работает;
//   5. временная ошибка опроса не прерывает цикл, считается в poll_transient;
//   6. адрес записи берётся и из audio_files[0].url, и из audio_url;
//   7. успешный ответ по-прежнему проходит насквозь.
//
// Запуск: node tests/stt/run.js
var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '..', '..', 'prototype', 'lib', 'stt-reliability.js'), 'utf8');
var L = new Function(src + '\nreturn {' + [
  'sttTransient', 'sttChannelsMismatch', 'sttErrorText', 'sttOperationFailure',
  'sttMergePollState', 'sttRetryOrTimeout', 'sttNeedsMonoFallback', 'sttPickAudioUrl',
  'STT_MAX_ATTEMPTS'
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

var META = { activity_id: '12345', comm_index: 3, channel_count: 2, file_name: 'deal_1_act_2.mp3' };

console.log('=== Временная помеха ===');
['503 Service Unavailable', 'Request failed with status code 500', 'ETIMEDOUT',
  'socket hang up', 'ECONNRESET', 'read ECONNREFUSED', 'EAI_AGAIN', 'timeout of 60000ms exceeded'
].forEach(function (m) { check('временная: ' + m, L.sttTransient(m)); });

['400 Bad Request', 'Audio has 1 channels, but 2 requested in specification',
  'invalid api key', 'Permission denied', '404 Not Found'
].forEach(function (m) { check('НЕ временная: ' + m, !L.sttTransient(m)); });
check('5 в середине числа не считается 5xx', !L.sttTransient('код 1500 ошибка'));

console.log('\n=== Отказ по числу каналов ===');
check('формулировка СПИН', L.sttChannelsMismatch('Audio has 1 channels, but 2 requested in specification'));
check('формулировка без «in specification»', L.sttChannelsMismatch('Audio has 1 channels, but 2 requested'));
check('единственное число', L.sttChannelsMismatch('Audio has 1 channel, but 2 requested'));
check('обратный случай (2 канала, запрошен 1)', L.sttChannelsMismatch('Audio has 2 channels, but 1 requested'));
check('посторонняя ошибка не путается', !L.sttChannelsMismatch('403 Forbidden'));
check('слово channels без requested не считается', !L.sttChannelsMismatch('audio channels decoded'));

console.log('\n=== Ответ операции ===');
var okResp = { done: true, response: { chunks: [{ alternatives: [{ text: 'алло' }] }] } };
eq('успешный ответ парсится как раньше', L.sttOperationFailure(okResp, META), null);

var failTransient = L.sttOperationFailure({ done: true, error: { message: '503 upstream error' } }, META);
check('временная ошибка: success false', failTransient.success === false);
check('временная ошибка: retryable true', failTransient.retryable === true);
check('временная ошибка: activity_id сохранён', failTransient.activity_id === '12345');
check('временная ошибка: не пустая запись, текст ошибки на месте', /503/.test(failTransient.error));

var failChannels = L.sttOperationFailure(
  { done: true, error: { message: 'Audio has 1 channels, but 2 requested in specification' } }, META);
check('каналы: success false', failChannels.success === false);
check('каналы: retryable FALSE — повтор ничего не изменит', failChannels.retryable === false);
check('каналы: помечено channels_mismatch', failChannels.channels_mismatch === true);

var failNoResponse = L.sttOperationFailure({ done: true }, META);
check('операция без response и без error — тоже ошибка', failNoResponse.success === false);
check('операция без response: retryable true', failNoResponse.retryable === true);

var failString = L.sttOperationFailure({ error: 'Audio has 1 channels, but 2 requested' }, META);
check('error строкой, а не объектом', failString.success === false && failString.retryable === false);
eq('текст ошибки из строки', L.sttErrorText({ error: 'плохо' }), 'плохо');
eq('текста ошибки нет', L.sttErrorText({ done: true }), '');

console.log('\n=== Счётчик попыток ===');
var step1 = L.sttRetryOrTimeout({ attempt: 0, operation_id: 'op1', activity_id: '1', channel_count: 2 });
eq('первая итерация даёт attempt=1', step1.attempt, 1);
var step2 = L.sttRetryOrTimeout(step1);
eq('вторая итерация считает от предыдущей, а не от нуля', step2.attempt, 2);
var step3 = L.sttRetryOrTimeout(step2);
eq('третья итерация', step3.attempt, 3);
check('operation_id переносится', step3.operation_id === 'op1');

// Главный дефект: раньше attempt всегда читался из «Подготовить поллинг» (там 0),
// поэтому счётчик навсегда оставался 1 и предел не наступал никогда.
var attempt = 0, guard = 0, state = { attempt: 0, operation_id: 'op1', activity_id: '1' };
for (;;) {
  state = L.sttRetryOrTimeout(state);
  guard++;
  if (state.success === false) { attempt = state.attempt; break; }
  if (guard > 200) break;
}
eq('цикл обрывается ровно на 60-й попытке', attempt, L.STT_MAX_ATTEMPTS);
check('выход помечен success:false', state.success === false);
check('таймаут помечен retryable:true — звонок можно пробовать позже', state.retryable === true);
check('в тексте ошибки видно число попыток', /60/.test(state.error));

var limited = { attempt: 0, activity_id: '1' };
for (var i = 0; i < 5; i++) limited = L.sttRetryOrTimeout(limited, 5);
check('предел настраивается (limit=5)', limited.success === false && limited.attempt === 5);

console.log('\n=== Опрос: временная ошибка не прерывает цикл ===');
var st0 = { attempt: 7, operation_id: 'op1', api_key: 'k', activity_id: '1' };
var merged1 = L.sttMergePollState(st0, { error: { message: '502 Bad Gateway' } });
check('временная ошибка опроса стёрта', !merged1.error);
eq('poll_transient стал 1', merged1.poll_transient, 1);
eq('attempt не тронут', merged1.attempt, 7);
check('operation_id сохранён — задание не пересоздаётся', merged1.operation_id === 'op1');

var merged2 = L.sttMergePollState(merged1, { error: { message: 'ETIMEDOUT' } });
eq('poll_transient накапливается', merged2.poll_transient, 2);

var mergedDone = L.sttMergePollState(st0, { done: true, response: { chunks: [] } });
check('готовый ответ проходит', mergedDone.done === true);
check('у готового ответа response на месте', !!mergedDone.response);

var mergedHard = L.sttMergePollState(st0, { done: true, error: { message: 'Audio has 1 channels, but 2 requested' } });
check('постоянная ошибка НЕ стирается — её должен увидеть парсер', !!mergedHard.error);
check('постоянная ошибка не растит poll_transient', !mergedHard.poll_transient);

console.log('\n=== Моно-проход ===');
check('пустой стерео-диалог → моно (как было до правки)',
  L.sttNeedsMonoFallback({ success: true, formatted_dialog: '' }, 2));
check('пробелы вместо диалога → моно',
  L.sttNeedsMonoFallback({ success: true, formatted_dialog: '   \n ' }, 2));
check('отказ по каналам → моно',
  L.sttNeedsMonoFallback({ success: false, error: 'Audio has 1 channels, but 2 requested in specification' }, 2));
check('отказ по каналам без «in specification» → тоже моно',
  L.sttNeedsMonoFallback({ success: false, error: 'Audio has 1 channels, but 2 requested' }, 2));
check('флаг channels_mismatch тоже запускает моно',
  L.sttNeedsMonoFallback({ success: false, channels_mismatch: true, error: 'что-то про каналы' }, 2));
check('временная ошибка НЕ запускает моно — это не про каналы',
  !L.sttNeedsMonoFallback({ success: false, retryable: true, error: '503 upstream' }, 2));
check('живой стерео-диалог моно не запускает',
  !L.sttNeedsMonoFallback({ success: true, formatted_dialog: 'Менеджер: алло\nКлиент: да' }, 2));
check('после самого моно-прохода второго моно не бывает',
  !L.sttNeedsMonoFallback({ success: false, error: 'Audio has 1 channels, but 2 requested' }, 1));
check('пустой моно-результат моно не перезапускает',
  !L.sttNeedsMonoFallback({ success: true, formatted_dialog: '' }, 1));

console.log('\n=== Адрес записи ===');
eq('из audio_files[0].url',
  L.sttPickAudioUrl({ audio_files: [{ url: 'https://b24/file?fileId=1' }] }), 'https://b24/file?fileId=1');
eq('из audio_url, когда audio_files пуст',
  L.sttPickAudioUrl({ audio_files: [], audio_url: 'https://b24/rec?fileId=2' }), 'https://b24/rec?fileId=2');
eq('из audio_url, когда audio_files нет вовсе',
  L.sttPickAudioUrl({ audio_url: 'https://b24/rec?fileId=3' }), 'https://b24/rec?fileId=3');
eq('audio_files с пустым url — берём следующий элемент',
  L.sttPickAudioUrl({ audio_files: [{ url: '' }, { url: 'https://b24/f?fileId=4' }] }), 'https://b24/f?fileId=4');
eq('audio_files со пустыми url — падаем на audio_url',
  L.sttPickAudioUrl({ audio_files: [{ url: '  ' }], audio_url: 'https://b24/rec?fileId=5' }), 'https://b24/rec?fileId=5');
eq('записи нет вообще', L.sttPickAudioUrl({ type: 'call' }), '');
eq('пустой вход', L.sttPickAudioUrl(null), '');
check('audio_files приоритетнее audio_url',
  L.sttPickAudioUrl({ audio_files: [{ url: 'https://a/1' }], audio_url: 'https://b/2' }) === 'https://a/1');

console.log('\n=== Создание задания: три попытки с паузами 5 и 10 с ===');
// Слепок логики sttRetry из ноды «Запустить SpeechKit»: проверяем число попыток и паузы,
// не дожидаясь их по-настоящему.
function fakeRetry(answers) {
  var pauses = [], calls = 0;
  function run() {
    for (var a = 1; a <= 3; a++) {
      calls++;
      var res = answers[a - 1];
      if (res.ok) return { value: res.value, calls: calls, pauses: pauses };
      if (!L.sttTransient(res.error) || a === 3) return { thrown: res.error, calls: calls, pauses: pauses };
      pauses.push(a * 5000);
    }
  }
  return run();
}
var r1 = fakeRetry([{ ok: true, value: 'ok' }]);
eq('успех с первой попытки — повторов нет', [r1.calls, r1.pauses], [1, []]);

var r2 = fakeRetry([{ error: '503' }, { ok: true, value: 'ok' }]);
eq('503, потом успех — одна пауза 5 с', [r2.calls, r2.pauses], [2, [5000]]);

var r3 = fakeRetry([{ error: '500' }, { error: 'ETIMEDOUT' }, { ok: true, value: 'ok' }]);
eq('две помехи — паузы 5 и 10 с', [r3.calls, r3.pauses], [3, [5000, 10000]]);

var r4 = fakeRetry([{ error: '503' }, { error: '503' }, { error: '503' }]);
eq('три помехи — сдаёмся после третьей', [r4.calls, r4.pauses], [3, [5000, 10000]]);
check('после трёх помех ошибка пробрасывается', !!r4.thrown);

var r5 = fakeRetry([{ error: '400 Bad Request' }]);
eq('400 падает сразу, без повторов', [r5.calls, r5.pauses], [1, []]);
check('400 пробрасывается', /400/.test(r5.thrown));

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
if (fail > 0) process.exit(1);
