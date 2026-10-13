// Моки на надёжность транскрипции (prototype/lib/stt-reliability.js), пункт 4 документа.
//
// Ветки, которые проверяются:
//   1. временная помеха против постоянной ошибки;
//   2. отказ по числу каналов → моно-проход, retryable=false;
//   3. ответ операции с error → success:false, а не пустая запись;
//   4. счётчик попыток берёт attempt из предыдущей итерации, предел 60 работает;
//   5. временная ошибка опроса не прерывает цикл, считается в poll_transient;
//   6. адрес записи берётся и из audio_files[0].url, и из audio_url;
//   7. успешный ответ по-прежнему проходит насквозь;
//   8. резерв распознавания: переключатель, предохранитель, разбор ответа сервиса,
//      роли по каналам, сборка транскрипта и совпадение формата с ответом SpeechKit.
//
// Запуск: node tests/stt/run.js
var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '..', '..', 'prototype', 'lib', 'stt-reliability.js'), 'utf8');
var L = new Function(src + '\nreturn {' + [
  'sttTransient', 'sttChannelsMismatch', 'sttErrorText', 'sttOperationFailure',
  'sttMergePollState', 'sttRetryOrTimeout', 'sttNeedsMonoFallback', 'sttPickAudioUrl', 'sttDownloadFailure', 'STT_MIN_AUDIO_BYTES',
  'STT_MAX_ATTEMPTS',
  // резерв распознавания (13.10.2026)
  'sttMode', 'STT_BREAKER_MS', 'sttBreakerOpen', 'sttBreakerUntil', 'sttUseReserveFirst',
  'sttReserveAfterFailure', 'sttReserveChannels', 'sttReserveFailure', 'sttEngineLabel',
  'STT_ENGINE_SPEECHKIT', 'sttReserveRole', 'sttReserveToTranscript'
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

console.log('\n=== Скачивание записи: проверка до загрузки в S3 ===');
var okFile = L.sttDownloadFailure(200, 250000, META);
eq('годная запись проходит', okFile, null);
check('ровно порог тоже проходит', L.sttDownloadFailure(200, L.STT_MIN_AUDIO_BYTES, META) === null);

var f404 = L.sttDownloadFailure(404, 0, META);
check('HTTP 404: success false', f404.success === false);
check('HTTP 404: retryable true', f404.retryable === true);
check('HTTP 404: причина понятная, с кодом', /404/.test(f404.error) && /не скачана/i.test(f404.error));
check('HTTP 404: помечено download_failed', f404.download_failed === true);
check('HTTP 404: activity_id сохранён', f404.activity_id === '12345');

var f500 = L.sttDownloadFailure(500, 0, META);
check('HTTP 500 тоже ошибка скачивания', f500.success === false && f500.retryable === true);

var fNoStatus = L.sttDownloadFailure(undefined, 100000, META);
check('кода ответа нет вовсе — ошибка', fNoStatus.success === false);
check('в причине сказано, что кода нет', /без кода ответа/.test(fNoStatus.error));

var fEmpty = L.sttDownloadFailure(200, 0, META);
check('200 с пустым файлом — ошибка', fEmpty.success === false);
check('пустой файл: причина про 0 байт', /0 байт/.test(fEmpty.error));
check('пустой файл: retryable true', fEmpty.retryable === true);

var fTiny = L.sttDownloadFailure(200, 300, META);
check('200 с огрызком (300 байт) — ошибка', fTiny.success === false);
check('огрызок: в причине виден размер и порог', /300/.test(fTiny.error) && /1024/.test(fTiny.error));
eq('огрызок: размер записан в поле', fTiny.bytes, 300);

// Страница ошибки Битрикса, отданная с кодом 200 — тот самый случай, который раньше
// уходил в S3 и возвращался от SpeechKit пустым результатом.
var fHtml = L.sttDownloadFailure(200, 820, META);
check('страница ошибки под кодом 200 не уходит в S3', fHtml.success === false);

check('ошибка скачивания моно-проход НЕ запускает',
  !L.sttNeedsMonoFallback({ success: false, retryable: true, download_failed: true, error: 'Запись не скачана: HTTP 404' }, 2));

// ═══════════════════════════════════════════════════════════════════════════════
// РЕЗЕРВНОЕ РАСПОЗНАВАНИЕ (13.10.2026)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== Переключатель STT_MODE ===');
eq('auto', L.sttMode('auto'), 'auto');
eq('speechkit', L.sttMode('speechkit'), 'speechkit');
eq('reserve', L.sttMode('reserve'), 'reserve');
eq('регистр не важен', L.sttMode('ReSeRvE'), 'reserve');
eq('пробелы по краям', L.sttMode('  speechkit  '), 'speechkit');
eq('пустая строка — авто', L.sttMode(''), 'auto');
eq('null — авто', L.sttMode(null), 'auto');
eq('undefined — авто', L.sttMode(undefined), 'auto');
eq('опечатка не останавливает распознавание', L.sttMode('rezerv'), 'auto');

console.log('\n=== Предохранитель: окно 15 минут (Д2) ===');
eq('окно ровно 15 минут', L.STT_BREAKER_MS, 900000);
var NOW = Date.parse('2026-10-13T10:00:00.000Z');
check('отметки нет — закрыт', !L.sttBreakerOpen(null, NOW));
check('пустая строка — закрыт', !L.sttBreakerOpen('', NOW));
check('мусор вместо даты — закрыт', !L.sttBreakerOpen('позже', NOW));
check('отметка в будущем — открыт', L.sttBreakerOpen('2026-10-13T10:05:00.000Z', NOW));
check('отметка в прошлом — закрыт', !L.sttBreakerOpen('2026-10-13T09:59:00.000Z', NOW));
check('отметка ровно сейчас — закрыт', !L.sttBreakerOpen('2026-10-13T10:00:00.000Z', NOW));
check('отметка числом миллисекунд', L.sttBreakerOpen(NOW + 60000, NOW));
eq('новая отметка — через 15 минут', L.sttBreakerUntil(NOW), '2026-10-13T10:15:00.000Z');

console.log('\n=== Куда идти ДО попытки SpeechKit ===');
check('режим «только резерв» — сразу в резерв', L.sttUseReserveFirst('reserve', null, NOW));
check('режим «только резерв» не смотрит на предохранитель',
  L.sttUseReserveFirst('reserve', '2026-10-13T09:00:00.000Z', NOW));
check('режим «только SpeechKit» — резерв не трогаем', !L.sttUseReserveFirst('speechkit', null, NOW));
check('режим «только SpeechKit»: предохранитель не действует (Д2)',
  !L.sttUseReserveFirst('speechkit', '2026-10-13T10:10:00.000Z', NOW));
check('авто + предохранитель открыт — сразу в резерв',
  L.sttUseReserveFirst('auto', '2026-10-13T10:10:00.000Z', NOW));
check('авто + предохранитель закрыт — сначала SpeechKit',
  !L.sttUseReserveFirst('auto', '2026-10-13T09:50:00.000Z', NOW));
check('авто без отметки — сначала SpeechKit', !L.sttUseReserveFirst('auto', null, NOW));

console.log('\n=== Куда идти ПОСЛЕ сбоя SpeechKit ===');
var FAIL_RETRY = { success: false, retryable: true, error: 'SpeechKit: HTTP 503' };
check('повторяемый сбой — в резерв', L.sttReserveAfterFailure('auto', FAIL_RETRY));
check('успех — резерв не нужен', !L.sttReserveAfterFailure('auto', { success: true, formatted_dialog: 'Менеджер: да' }));
check('тишина (успех с пустым диалогом) — резерв не нужен',
  !L.sttReserveAfterFailure('auto', { success: true, formatted_dialog: '' }));
check('отказ по числу каналов — не резерв, а моно-проход',
  !L.sttReserveAfterFailure('auto', { success: false, retryable: false, channels_mismatch: true, error: 'Audio has 1 channels, but 2 requested' }));
check('сбой скачивания записи — резерв не поможет, файл тот же (Д3)',
  !L.sttReserveAfterFailure('auto', { success: false, retryable: true, download_failed: true, error: 'Запись не скачана: HTTP 404' }));
check('неповторяемый сбой — не в резерв',
  !L.sttReserveAfterFailure('auto', { success: false, retryable: false, error: 'bad request' }));
check('режим «только SpeechKit» — в резерв не уходим даже при сбое',
  !L.sttReserveAfterFailure('speechkit', FAIL_RETRY));
check('пустой результат без признаков — не в резерв', !L.sttReserveAfterFailure('auto', {}));

console.log('\n=== Параметр channels для сервиса ===');
eq('просили 2 канала — stereo', L.sttReserveChannels(2), 'stereo');
eq('просили 1 канал — mono', L.sttReserveChannels(1), 'mono');
eq('не указано — stereo', L.sttReserveChannels(undefined), 'stereo');
eq('ноль — stereo (как и у SpeechKit по умолчанию)', L.sttReserveChannels(0), 'stereo');

console.log('\n=== Разбор ошибок сервиса (по его договору) ===');
var RMETA = { activity_id: '777', comm_index: 5, channel_count: 2 };
var RMETA1 = { activity_id: '888', comm_index: 1, channel_count: 1 };
check('успешный ответ — ошибки нет', L.sttReserveFailure(200, { ok: true, segments: [] }, RMETA) === null);

var eProv = L.sttReserveFailure(502, { ok: false, error: { code: 'provider_error', message: 'Polza HTTP 503', retryable: true } }, RMETA);
check('provider_error повторяем', eProv.retryable === true);
check('помечен как сбой резерва', eProv.reserve_failed === true);
check('в тексте ошибки виден код', eProv.error.indexOf('provider_error') !== -1);
eq('метаданные звонка на месте', [eProv.activity_id, eProv.comm_index, eProv.channel_count], ['777', 5, 2]);

var eMono = L.sttReserveFailure(422, { ok: false, error: { code: 'bad_audio', message: 'stereo requested, file is mono', retryable: false } }, RMETA);
check('stereo у моно-файла → признак «нужен моно-проход»', eMono.channels_mismatch === true);
check('и он не повторяемый', eMono.retryable === false);
check('моно-проход запустится по этому ответу', L.sttNeedsMonoFallback(eMono, 2));

var eBadMono = L.sttReserveFailure(422, { ok: false, error: { code: 'bad_audio', message: 'нет звуковой дорожки', retryable: false } }, RMETA1);
check('битый моно-файл — это не mismatch', eBadMono.channels_mismatch === false);
check('и моно-проход второй раз не запускается', !L.sttNeedsMonoFallback(eBadMono, 1));

check('401 не повторяем', L.sttReserveFailure(401, { ok: false, error: { code: 'unauthorized', message: 'нет ключа', retryable: false } }, RMETA).retryable === false);
check('413 не повторяем', L.sttReserveFailure(413, { ok: false, error: { code: 'too_large', message: 'больше 50 МБ', retryable: false } }, RMETA).retryable === false);
check('503 перегрузка повторяема', L.sttReserveFailure(503, { ok: false, error: { code: 'overloaded', message: 'очередь полна', retryable: true } }, RMETA).retryable === true);
check('504 таймаут повторяем', L.sttReserveFailure(504, { ok: false, error: { code: 'timeout', message: '600 с', retryable: true } }, RMETA).retryable === true);
check('500 сервиса повторяем', L.sttReserveFailure(500, { ok: false, error: { code: 'internal', message: 'сбой', retryable: true } }, RMETA).retryable === true);
check('тела нет, 502 — повторяем', L.sttReserveFailure(502, null, RMETA).retryable === true);
check('тела нет, 400 — не повторяем', L.sttReserveFailure(400, null, RMETA).retryable === false);
check('обрыв соединения (кода нет) — повторяем', L.sttReserveFailure(0, null, RMETA).retryable === true);
check('429 без тела — повторяем', L.sttReserveFailure(429, null, RMETA).retryable === true);
check('ok:false при коде 200 — всё равно ошибка',
  L.sttReserveFailure(200, { ok: false, error: { code: 'internal', message: 'сбой', retryable: true } }, RMETA) !== null);

console.log('\n=== Пометка «кто распознал» (Д5) ===');
eq('speechkit', L.STT_ENGINE_SPEECHKIT, 'speechkit');
eq('GigaAM', L.sttEngineLabel('ai-sage/gigaam-v3'), 'reserve:gigaam');
eq('Aiesa', L.sttEngineLabel('aiesa/transcribe'), 'reserve:aiesa');
eq('Aiesa fast — та же пометка', L.sttEngineLabel('aiesa/transcribe-fast'), 'reserve:aiesa');
eq('модель не названа', L.sttEngineLabel(''), 'reserve:unknown');
eq('модели нет вовсе', L.sttEngineLabel(null), 'reserve:unknown');
eq('незнакомая модель — из имени', L.sttEngineLabel('openai/whisper-large-v3'), 'reserve:whisper-large-v3');
check('пометка влезает в varchar(32)', L.sttEngineLabel('vendor/ochen-dlinnoe-imya-modeli-dlya-proverki-granicy').length <= 32);

console.log('\n=== Роли по каналам (Д8) ===');
eq('канал 0 — менеджер', L.sttReserveRole(0), 'Менеджер');
eq('канал 1 — клиент', L.sttReserveRole(1), 'Клиент');
eq('канал строкой', L.sttReserveRole('0'), 'Менеджер');

console.log('\n=== Сборка транскрипта: стерео ===');
var SEG = [
  { channel: 0, start: 0.4, end: 3.1, text: 'Здравствуйте, компания Динал' },
  { channel: 1, start: 3.4, end: 5.0, text: 'Да, слушаю' },
  { channel: 0, start: 5.2, end: 7.0, text: 'Вам удобно говорить' },
  { channel: 0, start: 7.1, end: 9.0, text: 'по замеру' },
  { channel: 1, start: 9.5, end: 11.0, text: 'Я уже купил окна' }
];
var tr = L.sttReserveToTranscript(
  { ok: true, model: 'ai-sage/gigaam-v3', channels: 2, duration_sec: 11.2, speech_sec: 8.1, request_id: 'abc123', segments: SEG },
  { activity_id: '999', comm_index: 2, channel_count: 2, call_date: '2026-10-12T09:00:00+07:00', call_direction: 'outgoing' });
check('распознано успешно', tr.success === true);
eq('реплик после склейки подряд идущих', tr.total_replicas, 4);
eq('первая реплика — менеджер', tr.conversation[0].speaker, 'Менеджер');
eq('вторая — клиент', tr.conversation[1].speaker, 'Клиент');
eq('подряд идущие реплики одного канала склеены', tr.conversation[2].text, 'Вам удобно говорить по замеру');
eq('текст менеджера собран', tr.manager_text, 'Здравствуйте, компания Динал Вам удобно говорить по замеру');
eq('текст клиента собран', tr.client_text, 'Да, слушаю Я уже купил окна');
check('диалог в прежнем формате «Роль: текст»', tr.formatted_dialog.indexOf('Менеджер: Здравствуйте') === 0);
eq('пометка движка', tr.transcript_engine, 'reserve:gigaam');
eq('метаданные звонка пробрасываются', [tr.activity_id, tr.comm_index, tr.direction], ['999', 2, 'outgoing']);
eq('идентификатор запроса сервиса вместо operation_id', tr.operation_id, 'abc123');
eq('в S3 резерв ничего не кладёт', tr.s3_file, null);

var trSort = L.sttReserveToTranscript(
  { ok: true, model: 'ai-sage/gigaam-v3', channels: 2, segments: [
    { channel: 1, start: 9.0, end: 10.0, text: 'Второй' },
    { channel: 0, start: 1.0, end: 2.0, text: 'Первый' }
  ] }, { channel_count: 2 });
eq('отрезки сортируются по времени', trSort.conversation.map(function (c) { return c.text; }), ['Первый', 'Второй']);

var trEmpty = L.sttReserveToTranscript({ ok: true, model: 'ai-sage/gigaam-v3', channels: 2, segments: [] }, { channel_count: 2 });
check('тишина — это успех, а не сбой (Д3)', trEmpty.success === true);
eq('реплик нет', trEmpty.total_replicas, 0);
eq('диалог пустой', trEmpty.formatted_dialog, '');
check('тишина вердикт не блокирует: моно-проход по ней не запускается',
  L.sttNeedsMonoFallback(trEmpty, 2) === true);

var trBlank = L.sttReserveToTranscript(
  { ok: true, model: 'ai-sage/gigaam-v3', channels: 2, segments: [
    { channel: 0, start: 1, end: 2, text: '   ' },
    { channel: 1, start: 3, end: 4, text: 'Слушаю' }
  ] }, { channel_count: 2 });
eq('пустые отрезки в реплики не идут', trBlank.total_replicas, 1);
eq('и роль у оставшейся верная', trBlank.conversation[0].speaker, 'Клиент');

console.log('\n=== Сборка транскрипта: моно (урок СПИН) ===');
var MONO = { ok: true, model: 'ai-sage/gigaam-v3', channels: 1, source_channels: 1, segments: [
  { channel: 0, start: 0.5, end: 2.0, text: 'Алло, да' },
  { channel: 0, start: 2.5, end: 4.0, text: 'я вас слушаю' }
] };
var trMono = L.sttReserveToTranscript(MONO, { channel_count: 1, speaker_role: 'Говорящий' });
eq('моно даёт одну реплику', trMono.total_replicas, 1);
eq('без разделения сторон', trMono.conversation[0].speaker, 'Говорящий');
eq('весь текст слит', trMono.conversation[0].text, 'Алло, да я вас слушаю');
eq('префикс «Говорящий:» в диалоге — по нему режим узнаёт «Собрать итог»',
  trMono.formatted_dialog, 'Говорящий: Алло, да я вас слушаю');
eq('текст клиента пуст — сторон нет', trMono.client_text, '');
check('текст лежит в manager_text, как в моно-ветке SpeechKit', trMono.manager_text.length > 0);

var trMonoVoice = L.sttReserveToTranscript(MONO, { channel_count: 1, speaker_role: 'Клиент' });
eq('голосовое клиента — в client_text', trMonoVoice.client_text, 'Алло, да я вас слушаю');
eq('и manager_text пуст', trMonoVoice.manager_text, '');
var trMonoChat = L.sttReserveToTranscript(MONO, { channel_count: 1, speaker_role: 'Участник чата' });
eq('«Участник чата» — роль сохраняется', trMonoChat.conversation[0].speaker, 'Участник чата');

// Та самая ловушка СПИН: просили стерео, а сервис вернул один канал.
// Если бы такой ответ разобрали как стерео, вышел бы звонок «без содержания».
var trTrap = L.sttReserveToTranscript(
  { ok: true, model: 'ai-sage/gigaam-v3', channels: 1, source_channels: 1, segments: [
    { channel: 0, start: 1, end: 3, text: 'Один канал в ответе' }
  ] }, { channel_count: 2 });
eq('ответ с одним каналом разбирается как моно, даже если просили стерео', trTrap.total_replicas, 1);
eq('и роль не приписывается менеджеру наугад', trTrap.conversation[0].speaker, 'Говорящий');

console.log('\n=== Формат совпадает с ответом SpeechKit ===');
// Ключи, которые отдаёт «Парсинг транскрипта»: ниже ничего не должно пропасть,
// иначе «Собрать итог» и сборщик фактов потеряют поле молча.
var KLUCHI_SPEECHKIT = ['activity_id', 'comm_index', 'date', 'direction', 'channel_count',
  'speaker_role', 'total_replicas', 'conversation', 'formatted_dialog', 'manager_text',
  'client_text', 'operation_id', 's3_file', 'success'];
var poteryano = KLUCHI_SPEECHKIT.filter(function (k) { return !(k in tr); });
eq('ни одно поле прежнего формата не потеряно', poteryano, []);
check('добавлена только пометка движка и метрики резерва',
  'transcript_engine' in tr && 'reserve_duration_sec' in tr && 'reserve_speech_sec' in tr);

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
if (fail > 0) process.exit(1);
