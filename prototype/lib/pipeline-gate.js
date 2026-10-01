// Полнота данных: отметки по источникам и решение, можно ли выносить вердикт.
//
// Пункты 1 и 2 шага Б (документ otkazy-reshennoe-v-spin.md, п. 1). Что было:
// ошибка загрузки сессии чата, файла или голосового попадала только во внутренний список
// _warnings, который никуда не уходил — ни в анализ, ни в базу. Звонок, который не
// распознался, становился «звонком без транскрипта». Судья выносил вердикт по неполному
// материалу, и могло получиться «клиент не отвечал → неправомерен, менеджер бросил»
// с уведомлением РОПам. За 60 дней таких разборов 20 из 556, из них 3 с «неправомерен».
//
// Главное правило (решение Сани 01.10): блокирует ТОЛЬКО технический сбой — то, что помечено
// retryable. Пустой результат распознавания без ошибки — это тишина в записи, а не сбой;
// такой звонок вердикт не блокирует. Иначе каждая тихая запись стопорила бы разбор.
//
// Источник правок — этот файл. Моки: tests/pipeline-gate/run.js

// Источники данных из API Битрикса, которые читает «Обработать 1 сделку». Ключ → как писать
// в pipeline_error. Скриншотов тут нет: их метаданные приходят внутри комментариев, а сбой
// распознавания скриншота — это вторая ось, recognition.screenshots.
var PG_SOURCES = {
  calls: 'звонки',
  openlines: 'открытые линии',
  comments: 'комментарии',
  tasks: 'задачи'
};

// Голосовые этих форматов SpeechKit v2 не поддерживает. Это известное ограничение, а не сбой:
// такое голосовое остаётся в журнале текстом «[голосовое сообщение, не распознано]».
var PG_VOICE_UNSUPPORTED = ['m4a', 'wav'];

// Сколько попыток даём сделке, прежде чем перестать её держать.
var PG_MAX_ATTEMPTS = 3;

// Длина записи, выше которой пустой результат распознавания уже нельзя списать на тишину.
// Короткий звонок (сброс, недозвон) законно даёт пустой транскрипт. А в разговоре длиннее
// этого порога речь есть наверняка, и пустота означает, что расшифровать её не удалось.
// Повод: сделка 124041, входящий на 863 секунды. Стерео-проход вернул пусто, моно отбился
// по числу каналов, ошибка считалась неповторяемой — и судья вынес «неправомерен, менеджер
// бросил», хотя клиент именно в этом звонке сказал, что договор с конкурентом уже подписан.
// Перепрогон распознал запись (11 974 символа) и вердикт сменился на «правомерен».
var PG_SILENCE_MAX_SEC = 30;

// Отказ SpeechKit из-за числа каналов: «Audio has 2 channels, but 1 requested in specification».
// Тот же текст проверяет sttChannelsMismatch в prototype/lib/stt-reliability.js — списки
// держим одинаковыми, правим в обоих местах.
function pgChannelsMismatch(message) {
  var m = String(message || '');
  return /channels?/i.test(m) && /requested/i.test(m);
}

// Длительность звонка так же, как её считают сборщик фактов и b4.5: поля duration_seconds
// у событий нет, есть duration_start и duration_end.
function pgCallDuration(comm) {
  var c = comm || {};
  if (c.duration_seconds && c.duration_seconds > 0) return Number(c.duration_seconds);
  if (c.duration_start && c.duration_end) {
    var s = new Date(c.duration_start).getTime();
    var e = new Date(c.duration_end).getTime();
    if (!isNaN(s) && !isNaN(e) && e > s) return Math.round((e - s) / 1000);
  }
  return 0;
}

function pgSourceLabel(key) {
  return PG_SOURCES[key] || String(key || '');
}

// Пустая карта отметок: все источники считаются непрочитанными, пока не отметят обратное.
function pgInitMarks() {
  var marks = {};
  for (var k in PG_SOURCES) if (Object.prototype.hasOwnProperty.call(PG_SOURCES, k)) {
    marks[k] = { complete: false, error: null, attempts: 0 };
  }
  return marks;
}

function pgMarkComplete(marks, key, attempts) {
  if (!marks[key]) marks[key] = { complete: false, error: null, attempts: 0 };
  marks[key].complete = true;
  marks[key].error = null;
  marks[key].attempts = Number(attempts) || 1;
  return marks;
}

function pgMarkFailed(marks, key, error, attempts) {
  if (!marks[key]) marks[key] = { complete: false, error: null, attempts: 0 };
  marks[key].complete = false;
  marks[key].error = String(error && (error.message || error) || 'неизвестная ошибка');
  marks[key].attempts = Number(attempts) || PG_MAX_ATTEMPTS;
  return marks;
}

// Какие источники так и не прочитались. Источник, которого в карте нет вовсе, считается
// непрочитанным: молчание не доказательство полноты.
function pgIncompleteSources(marks) {
  var out = [];
  var m = marks || {};
  for (var k in PG_SOURCES) {
    if (!Object.prototype.hasOwnProperty.call(PG_SOURCES, k)) continue;
    if (!m[k] || m[k].complete !== true) out.push(k);
  }
  return out;
}

// Формат голосового, который заведомо не распознается.
function pgVoiceUnsupported(fileName) {
  var ext = String(fileName || '').split('.').pop().toLowerCase();
  return PG_VOICE_UNSUPPORTED.indexOf(ext) !== -1;
}

// Технический сбой распознавания — только то, что помечено retryable.
// Не сбой: неподдерживаемый формат, отсутствие записи, пустой результат без ошибки,
// моно-запись после моно-прохода (у неё есть текст и свой режим).
function pgIsRecognitionFailure(item) {
  var it = item || {};
  if (it.unsupported === true) return false;
  if (pgVoiceUnsupported(it.file_name)) return false;
  if (it.retryable === true) return true;

  // Отказ по числу каналов на записи длиннее PG_SILENCE_MAX_SEC: подворкфлоу помечает его
  // неповторяемым (файл какой есть, такой и останется), и для короткого звонка это верно.
  // Но в разговоре на несколько минут речь была — значит мы её потеряли, и сделку надо
  // держать до повтора, а не выносить вердикт по неполному материалу.
  if (pgChannelsMismatch(it.error) && Number(it.duration_sec) > PG_SILENCE_MAX_SEC) return true;

  return false;
}

// Собирает блокирующие сбои распознавания из трёх мест конвейера.
function pgRecognitionFailures(recognition) {
  var r = recognition || {};
  var out = [];
  var kinds = [
    { list: r.calls, kind: 'звонок' },
    { list: r.voices, kind: 'голосовое' },
    { list: r.screenshots, kind: 'скриншот' }
  ];
  for (var i = 0; i < kinds.length; i++) {
    var list = kinds[i].list || [];
    for (var j = 0; j < list.length; j++) {
      if (pgIsRecognitionFailure(list[j])) {
        out.push({
          kind: kinds[i].kind,
          id: list[j].activity_id || list[j].file_id || list[j].id || null,
          error: String(list[j].error || '')
        });
      }
    }
  }
  return out;
}

// Главное решение: пускать ли сделку к судье.
//
// state.sources     — карта отметок полноты
// state.recognition — { calls: [], voices: [], screenshots: [] } с полями retryable/error
// state.last_attempt — третья попытка: сбой распознавания больше не держит сделку
//
// Сбор неполный по API блокирует ВСЕГДА, в том числе на последней попытке: без данных
// вердикт выносить нельзя, такую сделку показываем в отчёте.
function pgDecide(state) {
  var s = state || {};
  var incomplete = pgIncompleteSources(s.sources);
  if (incomplete.length) {
    var labels = incomplete.map(pgSourceLabel).join(', ');
    return {
      block: true,
      kind: 'collect',
      pipeline_error: 'сбор неполный: ' + labels,
      sources: incomplete,
      final: true
    };
  }

  var failures = pgRecognitionFailures(s.recognition);
  if (failures.length && s.last_attempt !== true) {
    var what = failures.map(function (f) { return f.kind + (f.id ? ' ' + f.id : ''); }).join(', ');
    return {
      block: true,
      kind: 'recognition',
      pipeline_error: 'технический сбой распознавания: ' + what,
      failures: failures,
      final: false
    };
  }

  // Третья попытка со сбоем распознавания: разбор идём, но в фактах будет честно сказано,
  // что запись есть и она не распознана.
  return {
    block: false,
    kind: failures.length ? 'recognition_accepted' : 'ok',
    failures: failures
  };
}

// Текст факта для звонка, у которого запись есть, а текста нет.
// Раньше такой звонок давал «Звонок outgoing, N сек, без транскрипта» — судья читал это
// как отсутствие разговора. Теперь прямо сказано, что содержание неизвестно.
function pgUnrecognizedCallFact(direction, durationSec, hasRecording) {
  var dir = direction || '?';
  var dur = Number(durationSec) || 0;
  if (!hasRecording) {
    return 'Звонок ' + dir + ', ' + dur + ' сек, записи нет';
  }
  return 'Звонок ' + dir + ', ' + dur
    + ' сек: запись есть, но не распознана — содержание неизвестно';
}
