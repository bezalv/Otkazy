// Надёжность транскрипции: ошибки SpeechKit, счётчик попыток, повторы, моно-проход.
//
// Пункт 4 документа otkazy-reshennoe-v-spin.md. Что было сломано:
//   1. «Повторить или таймаут» читал attempt из «Подготовить поллинг», где он всегда 0.
//      Счётчик всегда был 1, предел 60 попыток не работал: при зависании SpeechKit
//      подворкфлоу ждал без конца.
//   2. «Парсинг транскрипта» не смотрел на error в ответе операции. Ошибка принималась
//      за пустую запись, и звонок молча оставался без текста.
//   3. Создание задания не повторялось: временная 500-я от SpeechKit теряла звонок.
//      В сбойные часы 23.09 падало около 6% запросов.
//   4. Временная ошибка опроса валила весь подворкфлоу.
//
// Образец — «КП: Транскрипция звонка» (1JigaLPeRINUzePO), Ф7.1/Ф7.3/Ф7.5/Ф7.7 СПИН.
//
// ВАЖНО про порядок переноса: проверка ошибки SpeechKit (п. 2) работает только вместе с
// моно-проходом (п. 5). Сейчас Отказы проходят моно-записи случайно — как раз потому, что
// ошибку «Audio has N channels, but M requested» не видят и считают её пустым результатом.
// Без моно-прохода включение проверки превратит каждую моно-запись в ошибку сделки.
//
// Источник правок — этот файл. Сборка для вставки в ноды: stt-reliability.node.js
// Моки: tests/stt/run.js

// Сколько раз опрашиваем операцию, прежде чем сдаться.
var STT_MAX_ATTEMPTS = 60;

// Сколько раз пытаемся создать задание и с какими паузами (секунды множатся на номер попытки).
var STT_CREATE_ATTEMPTS = 3;
var STT_CREATE_PAUSE_MS = 5000;

// Временная помеха: 5xx, таймаут, обрыв соединения. Такое имеет смысл повторять.
function sttTransient(message) {
  var m = String(message || '');
  return /(^|[^0-9])5\d\d([^0-9]|$)/.test(m)
    || /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|timeout/i.test(m);
}

// Отказ из-за числа каналов: «Audio has 1 channels, but 2 requested in specification».
// Регулярка шире, чем в СПИН (там требовалось «requested in specification»): формулировка
// у SpeechKit менялась, а ошибиться здесь дорого — незамеченный случай превращает моно-запись
// в сбой сделки. Лишнее срабатывание безопаснее: оно всего лишь запустит моно-проход.
function sttChannelsMismatch(message) {
  var m = String(message || '');
  return /channels?/i.test(m) && /requested/i.test(m);
}

// Текст ошибки из ответа операции в любом виде, в каком его отдаёт API.
function sttErrorText(operation) {
  var o = operation || {};
  if (!o.error) return '';
  return String(o.error.message || o.error);
}

// Разбор ответа операции ДО сборки транскрипта.
// Возвращает null, если результат можно парсить, либо готовый ответ об ошибке.
// retryable=false ставится там, где повтор ничего не изменит: файл какой есть, такой и останется.
function sttOperationFailure(operation, meta) {
  var o = operation || {};
  if (!o.error && o.response) return null;

  var text = o.error
    ? sttErrorText(o)
    : 'SpeechKit: нет результата операции';
  var channels = sttChannelsMismatch(text);
  var m = meta || {};
  return {
    success: false,
    retryable: !channels,
    channels_mismatch: channels,
    activity_id: m.activity_id,
    comm_index: m.comm_index,
    channel_count: m.channel_count || 2,
    error: text
  };
}

// Состояние опроса: временная ошибка не завершает цикл, а считается в poll_transient
// в пределах тех же STT_MAX_ATTEMPTS. Задание при этом не пересоздаётся.
function sttMergePollState(state, polled) {
  var s = state || {};
  var p = {};
  for (var k in (polled || {})) if (Object.prototype.hasOwnProperty.call(polled, k)) p[k] = polled[k];

  if (p.error && sttTransient(sttErrorText(p))) {
    delete p.error;
    delete p.done;
    p.poll_transient = (Number(s.poll_transient) || 0) + 1;
  }

  var out = {};
  for (var sk in s) if (Object.prototype.hasOwnProperty.call(s, sk)) out[sk] = s[sk];
  for (var pk in p) if (Object.prototype.hasOwnProperty.call(p, pk)) out[pk] = p[pk];
  return out;
}

// Счётчик попыток. prev — состояние ПРЕДЫДУЩЕЙ итерации, а не «Подготовить поллинг».
function sttRetryOrTimeout(prev, limit) {
  var p = prev || {};
  var max = limit || STT_MAX_ATTEMPTS;
  var attempt = (Number(p.attempt) || 0) + 1;

  if (attempt >= max) {
    return {
      activity_id: p.activity_id,
      comm_index: p.comm_index,
      attempt: attempt,
      poll_transient: Number(p.poll_transient) || 0,
      retryable: true,
      success: false,
      error: 'Timeout after ' + max + ' attempts'
    };
  }

  return {
    operation_id: p.operation_id,
    attempt: attempt,
    poll_transient: Number(p.poll_transient) || 0,
    api_key: p.api_key,
    activity_id: p.activity_id,
    call_date: p.call_date,
    call_direction: p.call_direction,
    file_name: p.file_name,
    comm_index: p.comm_index,
    channel_count: p.channel_count || 2,
    speaker_role: p.speaker_role || ''
  };
}

// Нужен ли моно-проход после стерео-попытки. Два случая:
//   — стерео отдало пустой диалог (как было до правки);
//   — стерео отбито по числу каналов: запись одноканальная.
// Если стерео упало по временной причине, моно не поможет — пусть видно будет ошибку.
function sttNeedsMonoFallback(subResult, requestedChannels) {
  var r = subResult || {};
  if ((requestedChannels || 2) === 1) return false;

  if (r.success === false) return sttChannelsMismatch(r.error) || r.channels_mismatch === true;

  var formatted = r.formatted_dialog ? String(r.formatted_dialog).trim() : '';
  return r.success === true && formatted === '';
}

// Меньше килобайта аудиозаписи не бывает: это либо заголовок без данных, либо страница
// ошибки Битрикса, отданная с кодом 200. Такой файл грузить в S3 бессмысленно — SpeechKit
// всё равно вернёт пустой результат, и звонок молча останется без текста.
var STT_MIN_AUDIO_BYTES = 1024;

// Проверка скачанной записи ДО загрузки в S3.
// Возвращает null, если файл годный, либо готовый ответ об ошибке.
// retryable: true везде — и битый ответ Битрикса, и обрыв на скачивании имеет смысл повторить.
function sttDownloadFailure(statusCode, byteLength, meta) {
  var status = Number(statusCode);
  var size = Number(byteLength) || 0;
  var m = meta || {};
  var why = null;

  if (!status || status !== 200) {
    why = 'Запись не скачана: HTTP ' + (status ? String(status) : 'без кода ответа');
  } else if (size === 0) {
    why = 'Запись скачана пустой (0 байт)';
  } else if (size < STT_MIN_AUDIO_BYTES) {
    why = 'Запись подозрительно малая: ' + size
      + ' байт при пороге ' + STT_MIN_AUDIO_BYTES;
  }

  if (!why) return null;
  return {
    success: false,
    retryable: true,
    download_failed: true,
    http_status: status || null,
    bytes: size,
    activity_id: m.activity_id,
    comm_index: m.comm_index,
    channel_count: m.channel_count || 2,
    error: why
  };
}

// Адрес записи звонка: и audio_files[0].url, и audio_url (SETTINGS.RECORD_URL).
// Фильтр звонков брал только первое, и запись из audio_url не распознавалась вовсе.
function sttPickAudioUrl(call) {
  var c = call || {};
  if (c.audio_files && c.audio_files.length) {
    for (var i = 0; i < c.audio_files.length; i++) {
      var u = c.audio_files[i] && c.audio_files[i].url;
      if (u && String(u).trim()) return String(u).trim();
    }
  }
  if (c.audio_url && String(c.audio_url).trim()) return String(c.audio_url).trim();
  return '';
}
