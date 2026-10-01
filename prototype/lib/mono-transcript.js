// Моно-запись звонка: признак режима и подготовка текста для фактов.
//
// Зачем. Транскрипция идёт в два прохода: сначала стерео (channel_count=2, каналы
// «Менеджер»/«Клиент»), и если стерео-проход вернул пустой диалог — моно (channel_count=1,
// speaker_role='Говорящий'). Моно-проход отдаёт ОДИН поток речи без разделения сторон, и
// подворкфлоу складывает его целиком в manager_text. Из-за этого сборщик фактов делал факт
// actor=manager со словами обеих сторон, а судья цитировал клиента как менеджера и наоборот.
// В базе таких звонков 362, у всех 362 канал клиента пуст, у 269 текст живой.
//
// Правило: моно-запись даёт один факт actor=unknown. Это доказательство того, что разговор
// состоялся, и контекст — но не чьи-то конкретные слова.
//
// Источник правок — этот файл. Компактная сборка для вставки в ноды: mono-transcript.node.js
// Моки: tests/mono/run.js

// Префикс одной реплики моно-прохода: «Говорящий:» в начале текста или строки.
var MONO_SPEAKER_RE = /(^|\n)[ \t]*Говорящий[ \t]*:/;

// Тот же префикс для вырезания — глобально, по всем репликам.
var MONO_SPEAKER_STRIP_RE = /(^|\n)[ \t]*Говорящий[ \t]*:[ \t]*/g;

// Есть ли в тексте признак моно-прохода.
function monoByText(text) {
  return MONO_SPEAKER_RE.test(String(text || ''));
}

// Режим прохода по ответу подворкфлоу транскрипции.
// Нода «Транскрибировать все звонки» знает проход достоверно и ставит _transcript_mode.
// Если пометки нет (старый результат, иной путь) — определяем по «Говорящий:» в тексте.
function detectTranscriptMode(result) {
  if (!result) return null;
  var mode = result._transcript_mode || result.transcript_mode || null;
  if (mode === 'mono' || mode === 'stereo') return mode;
  if (result.channel_count === 1) return 'mono';
  if (result.channel_count === 2 && !monoByText(result.formatted_dialog)) return 'stereo';
  return monoByText(result.formatted_dialog) ? 'mono' : 'stereo';
}

// Моно ли эта запись звонка в потоке коммуникаций.
function isMonoTranscript(comm) {
  if (!comm) return false;
  if (comm._transcript_mode === 'mono') return true;
  if (comm._transcript_mode === 'stereo') return false;
  // Пометки нет — смотрим на текст: моно-проход всегда помечает реплики «Говорящий:».
  return monoByText(comm.transcript) || monoByText(comm.transcript_manager_text) || monoByText(comm.transcript_client_text);
}

// Текст без префиксов «Говорящий:». Пустые строки схлопываем, чтобы факт не разъезжался.
function stripMonoPrefix(text) {
  return String(text || '')
    .replace(MONO_SPEAKER_STRIP_RE, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// Вся речь моно-записи одним куском. Канал клиента у моно обычно пуст, но если подворкфлоу
// что-то в него положил — не теряем: сторон всё равно нет, порядок сохраняем.
function monoWholeText(comm) {
  var c = comm || {};
  var parts = [];
  var mgr = stripMonoPrefix(c.transcript_manager_text);
  var cli = stripMonoPrefix(c.transcript_client_text);
  if (mgr) parts.push(mgr);
  if (cli) parts.push(cli);
  if (!parts.length) {
    var whole = stripMonoPrefix(c.transcript);
    if (whole) parts.push(whole);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// Текст факта: речь плюс пометка, что сторон в записи нет. Пометка нужна в content, а не
// только в поле actor: судья читает факты как текст, и без неё он снова начнёт делить
// реплики «на слух».
function monoFactContent(comm) {
  var text = monoWholeText(comm);
  if (!text) return '';
  return 'Запись без разделения сторон (одна звуковая дорожка, кто именно говорит — неизвестно): ' + text;
}
