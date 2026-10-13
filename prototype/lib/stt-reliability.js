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

// ─────────────────────────────────────────────────────────────────────────────
// РЕЗЕРВНОЕ РАСПОЗНАВАНИЕ (13.10.2026, задание 2026-10-12-rezervnoe-raspoznavanie.md)
//
// С 11.10 у Yandex Cloud авария: SpeechKit не отвечает. Резерв — сервис stt-reserve
// на сервере n8n (договор в репозитории СПИН: scripts/server/stt-reserve/README.md).
// Он делит стерео на каналы, распознаёт каждый через Polza (сейчас ai-sage/gigaam-v3)
// и отдаёт отрезки с номером канала и временем. Ролей сервис не знает — их назначаем мы.
//
// Главные решения:
//   - Резерв включается на КАЖДЫЙ звонок: SpeechKit не ответил — этот звонок сразу идёт
//     в резерв; SpeechKit ожил — поток сам вернулся к нему.
//   - Пустой результат без ошибки остаётся тишиной и в резерв НЕ уходит (правило из
//     раздела «Надёжность транскрипции» CLAUDE.md не меняется).
//   - Сбой скачивания записи из Битрикса в резерв не уходит: файл тот же, резерв не поможет (Д3).
//   - Предохранитель (Д2): после повторяемого сбоя SpeechKit все звонки 15 минут идут
//     сразу в резерв. Иначе сделка с 20+ звонками тратит на мёртвый SpeechKit по три
//     попытки создания задания на каждый звонок и упирается в таймаут анализа.
// ─────────────────────────────────────────────────────────────────────────────

// Режимы переключателя. Константа STT_MODE живёт в ноде маршрутизации подворкфлоу
// транскрипции (Д6): это настройка инфраструктуры, по цепочке запуска не протаскивается.
var STT_MODE_AUTO = 'auto';           // SpeechKit, при сбое — резерв
var STT_MODE_SPEECHKIT = 'speechkit'; // только SpeechKit, резерв не трогаем
var STT_MODE_RESERVE = 'reserve';     // только резерв, SpeechKit не зовём

// Неизвестное значение трактуем как 'auto': опечатка в настройке не должна останавливать
// распознавание совсем.
function sttMode(raw) {
  var m = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
  if (m === STT_MODE_SPEECHKIT) return STT_MODE_SPEECHKIT;
  if (m === STT_MODE_RESERVE) return STT_MODE_RESERVE;
  return STT_MODE_AUTO;
}

// Окно предохранителя: 15 минут по заданию (Д2).
var STT_BREAKER_MS = 15 * 60 * 1000;

// Открыт ли предохранитель — то есть идём ли сразу в резерв, не трогая SpeechKit.
// until хранится как ISO-строка или миллисекунды; мусор и пустое значение = закрыт.
function sttBreakerOpen(until, nowMs) {
  if (until === null || until === undefined || until === '') return false;
  var t = typeof until === 'number' ? until : Date.parse(String(until));
  if (!t || isNaN(t)) return false;
  return t > (Number(nowMs) || Date.now());
}

// Новая отметка «SpeechKit лежит до …» после повторяемого сбоя.
function sttBreakerUntil(nowMs) {
  return new Date((Number(nowMs) || Date.now()) + STT_BREAKER_MS).toISOString();
}

// Идти ли в резерв СРАЗУ, не пробуя SpeechKit.
function sttUseReserveFirst(mode, breakerUntil, nowMs) {
  var m = sttMode(mode);
  if (m === STT_MODE_RESERVE) return true;
  // Режим «только SpeechKit» предохранитель не трогает (Д2).
  if (m === STT_MODE_SPEECHKIT) return false;
  return sttBreakerOpen(breakerUntil, nowMs);
}

// Идти ли в резерв ПОСЛЕ попытки SpeechKit.
// Отказ по числу каналов сюда не относится: это не сбой сервиса, а моно-запись, и её
// забирает штатный моно-проход вызывающей ноды.
function sttReserveAfterFailure(mode, result) {
  if (sttMode(mode) === STT_MODE_SPEECHKIT) return false;
  var r = result || {};
  if (r.success !== false) return false;
  if (r.channels_mismatch === true) return false;
  if (r.download_failed === true) return false;
  return r.retryable === true;
}

// Параметр channels сервиса из числа каналов, которое просил вызывающий.
// Просим именно stereo, а не auto: на моно-файле сервис ответит 422, и это станет тем же
// признаком «нужен моно-проход», что ошибка каналов у SpeechKit. Так пометка режима
// ('stereo' / 'mono') остаётся достоверной, и ловушка СПИН (моно принят за стерео
// с пустыми ролями) закрыта устройством потока, а не проверкой.
function sttReserveChannels(channelCount) {
  return (Number(channelCount) || 2) === 1 ? 'mono' : 'stereo';
}

// Разбор ответа сервиса. Возвращает null, если ответ можно превращать в транскрипт,
// либо готовый ответ об ошибке в том же виде, в каком его отдают ветки SpeechKit.
function sttReserveFailure(httpStatus, body, meta) {
  var status = Number(httpStatus) || 0;
  var b = body || {};
  var m = meta || {};
  var asked = sttReserveChannels(m.channel_count);

  if (status === 200 && b.ok === true) return null;

  var code = (b.error && b.error.code) ? String(b.error.code) : '';
  var text = (b.error && b.error.message) ? String(b.error.message) : '';
  var retryable;
  if (b.error && typeof b.error.retryable === 'boolean') {
    retryable = b.error.retryable;
  } else {
    // Тела нет (обрыв, прокси): повторяем то, что обычно временно.
    retryable = status === 0 || status >= 500 || status === 408 || status === 429;
  }

  // Стерео попросили, а файл одноканальный: пусть вызывающая нода идёт в моно-проход.
  var channelsMismatch = code === 'bad_audio' && asked === 'stereo';
  if (channelsMismatch) retryable = false;

  return {
    success: false,
    retryable: retryable,
    channels_mismatch: channelsMismatch,
    reserve_failed: true,
    activity_id: m.activity_id,
    comm_index: m.comm_index,
    channel_count: Number(m.channel_count) || 2,
    error: 'Резерв распознавания: ' + (code ? code : 'HTTP ' + (status || 'без кода'))
      + (text ? ' — ' + text : '')
  };
}

// Пометка «кто распознал» для lost_deal_communications.transcript_engine (varchar(32)).
// Суффикс берём из поля model ответа сервиса, а не из своей константы: переключение
// сервиса на Aiesa тогда подхватится само (Д5).
var STT_ENGINE_SPEECHKIT = 'speechkit';
function sttEngineLabel(model) {
  var m = String(model === null || model === undefined ? '' : model).toLowerCase();
  if (m.indexOf('gigaam') !== -1) return 'reserve:gigaam';
  if (m.indexOf('aiesa') !== -1) return 'reserve:aiesa';
  var tail = m.indexOf('/') === -1 ? m : m.slice(m.lastIndexOf('/') + 1);
  tail = tail.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!tail) return 'reserve:unknown';
  return ('reserve:' + tail).slice(0, 32);
}

// Роль по номеру канала файла. Нумерация сервиса идёт с нуля, у SpeechKit та же дорожка
// помечена channelTag=1 — то есть канал 0 файла соответствует «Менеджеру» (проверено
// в СПИН на звонке 1531729, для Отказов проверяется на своём звонке, Д8).
var STT_RESERVE_ROLE_BY_CHANNEL = { '0': 'Менеджер', '1': 'Клиент' };
function sttReserveRole(channel) {
  var key = String(Number(channel) || 0);
  return STT_RESERVE_ROLE_BY_CHANNEL[key] || 'Клиент';
}

// Сборка транскрипта из отрезков сервиса — в тот же формат, что отдаёт «Парсинг транскрипта».
// Дальше по конвейеру (сборщик фактов, детектор автоответчиков, судья) ничего не меняется.
function sttReserveToTranscript(body, meta) {
  var b = body || {};
  var m = meta || {};
  var channelCount = Number(m.channel_count) || 2;
  var speakerRole = m.speaker_role || '';
  var segments = (b.segments || []).slice().sort(function (x, y) {
    return (Number(x.start) || 0) - (Number(y.start) || 0);
  });

  var conv = [], mgrText = [], cliText = [];
  // Моно считаем и по запросу, и по факту ответа: если файл оказался одноканальным,
  // сервис вернёт channels=1, и разделять стороны нельзя.
  var isMono = channelCount === 1 || Number(b.channels) === 1;

  if (isMono) {
    var allText = [];
    for (var i = 0; i < segments.length; i++) {
      var t0 = segments[i] && segments[i].text ? String(segments[i].text).trim() : '';
      if (t0) allText.push(t0);
    }
    var fullText = allText.join(' ').trim();
    if (fullText) {
      var label = speakerRole || 'Говорящий';
      conv.push({ id: 1, speaker: label, text: fullText });
      // Та же раскладка, что в моно-ветке SpeechKit: роль «Говорящий» кладётся
      // в manager_text, а сторон у записи нет — их потом снимает mono-transcript.js.
      if (speakerRole === 'Менеджер') mgrText.push(fullText);
      else if (speakerRole === 'Клиент') cliText.push(fullText);
      else mgrText.push(fullText);
    }
  } else {
    var lastSpk = null, lastTxt = '', rid = 0;
    for (var j = 0; j < segments.length; j++) {
      var txt = segments[j] && segments[j].text ? String(segments[j].text).trim() : '';
      if (!txt) continue;
      var spk = sttReserveRole(segments[j].channel);
      if (spk === lastSpk) { lastTxt += ' ' + txt; continue; }
      if (lastSpk !== null && lastTxt.trim()) {
        rid++;
        conv.push({ id: rid, speaker: lastSpk, text: lastTxt.trim() });
        if (lastSpk === 'Менеджер') mgrText.push(lastTxt.trim());
        else cliText.push(lastTxt.trim());
      }
      lastSpk = spk; lastTxt = txt;
    }
    if (lastSpk !== null && lastTxt.trim()) {
      rid++;
      conv.push({ id: rid, speaker: lastSpk, text: lastTxt.trim() });
      if (lastSpk === 'Менеджер') mgrText.push(lastTxt.trim());
      else cliText.push(lastTxt.trim());
    }
  }

  var dialog = '';
  for (var d = 0; d < conv.length; d++) dialog += conv[d].speaker + ': ' + conv[d].text + '\n';

  return {
    activity_id: m.activity_id,
    comm_index: m.comm_index,
    date: m.call_date,
    direction: m.call_direction,
    channel_count: channelCount,
    speaker_role: speakerRole,
    total_replicas: conv.length,
    conversation: conv,
    formatted_dialog: dialog.trim(),
    manager_text: mgrText.join(' '),
    client_text: cliText.join(' '),
    operation_id: b.request_id || null,
    s3_file: null,
    transcript_engine: sttEngineLabel(b.model),
    reserve_duration_sec: b.duration_sec === undefined ? null : b.duration_sec,
    reserve_speech_sec: b.speech_sec === undefined ? null : b.speech_sec,
    success: true
  };
}
