// Собрано из локальной выгрузки ноды screenshots-parse от 19.10.2026.
export function mergeScreenshotResults(base, taskItems, runItems) {
var tasks = taskItems.map(function (item) { return { json: item }; });
var runs = runItems.map(function (item) { return { json: item }; });
// Выгрузка ноды «screenshots-parse» из воркфлоу GLQ2iuzRaCQZM7QU («Отказ: Анализ сделки»)
// Снято 2026-10-19T03:27:01.967Z через n8n API, не руками.
// Это точка отката: код можно вернуть патчем или сравнить с текущим состоянием.

// Разбор ответов модели по скриншотам переписки.
// Наружу идут только реплики и метаданные файлов: ни base64, ни DOWNLOAD_URL дальше не уходят.
var NSK_OFFSET_MS = 7 * 3600000;
var NSK_SUFFIX = '+07:00';

var MONTHS = [
  [/январ/, 1], [/феврал/, 2], [/март/, 3], [/апрел/, 4], [/ма[йя]/, 5], [/июн/, 6],
  [/июл/, 7], [/август/, 8], [/сентябр/, 9], [/октябр/, 10], [/ноябр/, 11], [/декабр/, 12]
];
var WEEKDAYS = [
  [/воскресен/, 0], [/понедельник/, 1], [/вторник/, 2], [/сред[аы]/, 3],
  [/четверг/, 4], [/пятниц/, 5], [/суббот/, 6]
];
var SPEAKER_RU = { manager: 'Менеджер', client: 'Клиент', unknown: 'Не понятно' };

// Плашки интерфейса, которые модель иногда отдаёт как реплики. Страховка к правилу 11 промпта.
var UI_NOTICES = [
  'пропущенный вызов', 'пропущенный видеозвонок', 'пропущенный звонок',
  'входящий звонок', 'исходящий звонок', 'входящий вызов', 'исходящий вызов',
  'новые сообщения', 'непрочитанные сообщения',
  'сообщение удалено', 'сообщение закреплено', 'сообщение изменено',
  'звонок отменен', 'вызов завершен', 'звонок завершен'
];
// \b в JS не работает с кириллицей, поэтому служебные слова выкидываем токенами.
var NOTICE_FILLER = { 'аудио': 1, 'видео': 1, 'audio': 1, 'video': 1 };

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// Дата файла приходит из Битрикса в MSK. Сдвигаем на Новосибирск и читаем через getUTC*,
// чтобы результат не зависел от часового пояса сервера n8n.
function toNskParts(iso) {
  var t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  var d = new Date(t + NSK_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() };
}
function dayNumber(y, m, d) { return Date.UTC(y, m - 1, d); }
function fromDayNumber(num) {
  var d = new Date(num);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() };
}

function resolveDate(label, upload) {
  var uploadNum = dayNumber(upload.y, upload.m, upload.d);
  var norm = String(label || '').toLowerCase().replace(/ё/g, 'е').trim();
  if (!norm) return { date: upload, rule: 'без плашки' };
  if (norm.indexOf('позавчера') !== -1) return { date: fromDayNumber(uploadNum - 2 * 86400000), rule: 'позавчера' };
  if (norm.indexOf('сегодня') !== -1) return { date: upload, rule: 'сегодня' };
  if (norm.indexOf('вчера') !== -1) return { date: fromDayNumber(uploadNum - 86400000), rule: 'вчера' };
  var dotted = norm.match(/(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?/);
  if (dotted) {
    var dd = parseInt(dotted[1], 10), mm = parseInt(dotted[2], 10);
    var yy = dotted[3] ? parseInt(dotted[3], 10) : null;
    if (yy !== null && yy < 100) yy += 2000;
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      if (yy === null) { yy = upload.y; if (dayNumber(yy, mm, dd) > uploadNum) yy -= 1; }
      return { date: fromDayNumber(dayNumber(yy, mm, dd)), rule: 'дата' };
    }
  }
  var md = norm.match(/(\d{1,2})\s+([а-я]+)(?:\s+(\d{4}))?/);
  if (md) {
    var day = parseInt(md[1], 10);
    var month = null;
    for (var i = 0; i < MONTHS.length; i++) { if (MONTHS[i][0].test(md[2])) { month = MONTHS[i][1]; break; } }
    if (month) {
      var year = md[3] ? parseInt(md[3], 10) : upload.y;
      if (!md[3] && dayNumber(year, month, day) > uploadNum) year -= 1;
      return { date: fromDayNumber(dayNumber(year, month, day)), rule: md[3] ? 'дата с годом' : 'дата без года' };
    }
  }
  for (var w = 0; w < WEEKDAYS.length; w++) {
    if (WEEKDAYS[w][0].test(norm)) {
      var back = (upload.dow - WEEKDAYS[w][1] + 7) % 7;
      return { date: fromDayNumber(uploadNum - back * 86400000), rule: 'день недели' };
    }
  }
  return { date: upload, rule: 'плашка не распознана' };
}

// kind: 'normal' — дата известна; 'before' — реплика выше первой плашки, дата не позже D.
function buildStamp(dateParts, timeLabel, kind) {
  var tm = String(timeLabel || '').match(/(\d{1,2}):(\d{2})/);
  var hh = 0, mi = 0, hasTime = false;
  if (tm) {
    var h = parseInt(tm[1], 10), m = parseInt(tm[2], 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) { hh = h; mi = m; hasTime = true; }
  }
  var d = dateParts;
  var dayLabel = pad2(d.d) + '.' + pad2(d.m);
  return {
    ts: d.y + '-' + pad2(d.m) + '-' + pad2(d.d) + 'T' + pad2(hh) + ':' + pad2(mi) + ':00' + NSK_SUFFIX,
    ts_precision: kind === 'before' ? 'before' : (hasTime ? 'exact' : 'day'),
    day_label: dayLabel,
    time_label: hasTime ? pad2(hh) + ':' + pad2(mi) : '',
    date_note: kind === 'before' ? '(дата на скрине не видна, не позже ' + dayLabel + ')' : ''
  };
}

function resolveTs(dateLabel, timeLabel, upload) {
  var r = resolveDate(dateLabel, upload);
  var stamp = buildStamp(r.date, timeLabel, 'normal');
  stamp.date_rule = r.rule;
  return stamp;
}

function parseModelContent(content) {
  var raw = String(content || '').trim();
  if (!raw) return { ok: false, error: 'пустой ответ модели' };
  var fence = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) raw = fence[1].trim();
  try { return { ok: true, data: JSON.parse(raw) }; } catch (e1) {}
  var braced = raw.match(/\{[\s\S]*\}/);
  if (braced) { try { return { ok: true, data: JSON.parse(braced[0]) }; } catch (e2) {} }
  return { ok: false, error: 'ответ модели не распарсился как JSON' };
}

function isUiNotice(text) {
  var t = String(text || '').toLowerCase().replace(/ё/g, 'е');
  t = t.replace(/\d{1,2}:\d{2}/g, ' ');
  t = t.replace(/[.,!?:;()"«»\-–—\/\\]/g, ' ');
  var words = t.split(/\s+/).filter(function (w) { return w && !NOTICE_FILLER[w]; });
  t = words.join(' ').trim();
  if (!t) return false;
  for (var i = 0; i < UI_NOTICES.length; i++) {
    if (t === UI_NOTICES[i]) return true;
  }
  return false;
}

function buildTurns(parsed, files) {
  var shots = (parsed && parsed.screenshots) || [];
  var rawTurns = (parsed && parsed.turns) || [];
  var chatFlags = {};
  for (var s = 0; s < shots.length; s++) {
    var fi = Number(shots[s].file_id);
    if (!isNaN(fi)) chatFlags[fi] = shots[s].is_chat_screenshot === true;
  }
  var anyChat = false;
  for (var k in chatFlags) { if (chatFlags[k]) { anyChat = true; break; } }

  function fileIndexOf(t) {
    var idx = Number(t && t.file_id);
    if (isNaN(idx) || idx < 0 || idx >= files.length) idx = 0;
    return idx;
  }

  // Для реплики без своей плашки: сначала ближайшая плашка ВЫШЕ по тому же скрину (её дата точна),
  // если выше ничего нет — ближайшая плашка НИЖЕ, и тогда дата известна только как верхний предел.
  var labelAbove = [], labelBelow = [];
  var seenAbove = {};
  for (var a = 0; a < rawTurns.length; a++) {
    var at = rawTurns[a] || {};
    var aIdx = fileIndexOf(at);
    var aLabel = String(at.date_label || '').trim();
    labelAbove[a] = aLabel ? '' : (seenAbove[aIdx] || '');
    if (aLabel) seenAbove[aIdx] = aLabel;
  }
  var seenBelow = {};
  for (var b = rawTurns.length - 1; b >= 0; b--) {
    var rt = rawTurns[b] || {};
    var bIdx = fileIndexOf(rt);
    var bLabel = String(rt.date_label || '').trim();
    labelBelow[b] = bLabel ? '' : (seenBelow[bIdx] || '');
    if (bLabel) seenBelow[bIdx] = bLabel;
  }

  var turns = [], lines = [], noticesDropped = 0;
  for (var t = 0; t < rawTurns.length; t++) {
    var tn = rawTurns[t] || {};
    var text = String(tn.text || '').trim();
    var attachment = String(tn.attachment || '').trim();
    if (!text && !attachment) continue;
    if (!attachment && isUiNotice(text)) { noticesDropped++; continue; }
    var idx = fileIndexOf(tn);
    if (chatFlags[idx] === false) continue;
    var file = files[idx] || {};
    var upload = toNskParts(file.date) || toNskParts(new Date().toISOString());
    var speaker = (tn.speaker === 'manager' || tn.speaker === 'client') ? tn.speaker : 'unknown';

    var ownLabel = String(tn.date_label || '').trim();
    var stamp, rule;
    if (ownLabel) {
      var own = resolveDate(ownLabel, upload);
      stamp = buildStamp(own.date, tn.time, 'normal');
      rule = own.rule;
    } else if (labelAbove[t]) {
      var above = resolveDate(labelAbove[t], upload);
      stamp = buildStamp(above.date, tn.time, 'normal');
      rule = 'плашка выше: ' + above.rule;
    } else if (labelBelow[t]) {
      var below = resolveDate(labelBelow[t], upload);
      stamp = buildStamp(below.date, tn.time, 'before');
      rule = 'не позже плашки ниже';
    } else {
      var none = resolveDate('', upload);
      stamp = buildStamp(none.date, tn.time, 'normal');
      rule = none.rule;
    }

    turns.push({
      speaker: speaker, text: text, attachment: attachment,
      date_label: String(tn.date_label || ''), time: String(tn.time || ''),
      ts: stamp.ts, ts_precision: stamp.ts_precision, date_rule: rule,
      date_note: stamp.date_note,
      file_index: idx,
      file_id: file.file_id !== undefined ? file.file_id : null,
      file_name: file.name || ''
    });
    var body = text;
    if (attachment) body = (body ? body + ' ' : '') + '[вложение: ' + attachment + ']';
    if (stamp.date_note) body = body + ' ' + stamp.date_note;
    lines.push(stamp.day_label + (stamp.time_label ? ' ' + stamp.time_label : '') + ' ' + SPEAKER_RU[speaker] + ': ' + body);
  }

  var status;
  if (!shots.length && !turns.length) status = 'empty';
  else if (!anyChat) status = 'not_chat';
  else if (!turns.length) status = 'empty';
  else status = 'ok';

  var chatCount = 0;
  for (var c2 in chatFlags) { if (chatFlags[c2]) chatCount++; }
  return {
    turns: turns, text: lines.join('\n'), status: status,
    screenshots_chat: chatCount, ui_notices_dropped: noticesDropped
  };
}



var firstTask = tasks.length ? (tasks[0].json || {}) : {};
var stats = firstTask.stats || { screenshots_total: 0, comments_with_screenshots: 0, screenshots_downloaded: 0, screenshots_download_failed: 0 };
var failedComments = firstTask.failed_comments || [];

var results = {};
var warnings = [];
var usageTotals = { prompt_tokens: 0, completion_tokens: 0, cost_rub: 0, calls: 0 };
var modelUsed = null;

for (var fc = 0; fc < failedComments.length; fc++) {
  results[String(failedComments[fc].comment_id)] = {
    status: 'failed', turns: [], text: '', screenshots_chat: 0,
    error: 'ни один файл не скачался'
  };
  warnings.push({ comment_id: failedComments[fc].comment_id, step: 'download', errors: failedComments[fc].errors || [] });
}

if (firstTask._has_images === true) {
  for (var r = 0; r < runs.length; r++) {
    var task = tasks[r] ? (tasks[r].json || {}) : null;
    if (!task || task._has_images !== true) continue;
    var resp = runs[r] ? (runs[r].json || {}) : {};
    var files = task.files || [];
    var entry;

    var choice = resp.choices && resp.choices[0];
    if (resp.error || !choice) {
      var errText = resp.error ? (resp.error.message || JSON.stringify(resp.error)) : 'нет choices в ответе';
      entry = { status: 'failed', turns: [], text: '', screenshots_chat: 0, error: String(errText).substring(0, 300) };
      warnings.push({ comment_id: task.comment_id, step: 'polza', error: entry.error });
    } else {
      var content = choice.message ? choice.message.content : '';
      if (Array.isArray(content)) {
        var joined = '';
        for (var p = 0; p < content.length; p++) { if (content[p] && content[p].text) joined += content[p].text; }
        content = joined;
      }
      var parsed = parseModelContent(content);
      if (!parsed.ok) {
        entry = { status: 'failed', turns: [], text: '', screenshots_chat: 0, error: parsed.error };
        warnings.push({ comment_id: task.comment_id, step: 'parse', error: parsed.error });
      } else {
        entry = buildTurns(parsed.data, files);
      }
      var usage = resp.usage || {};
      usageTotals.prompt_tokens += usage.prompt_tokens || 0;
      usageTotals.completion_tokens += usage.completion_tokens || 0;
      usageTotals.cost_rub += usage.cost_rub || 0;
      usageTotals.calls++;
      if (!modelUsed) modelUsed = resp.model || null;
    }
    entry.files = files;
    results[String(task.comment_id)] = entry;
  }
}

var comms = (base.communications || []).slice();
var extracted = 0, failedShots = 0, commentsOk = 0, commentsNotChat = 0, commentsFailed = 0, noticesTotal = 0;

for (var i = 0; i < comms.length; i++) {
  var c = comms[i];
  if (!c || c.type !== 'comment') continue;
  var res = results[String(c.comment_id)];
  if (!res) continue;

  var shotMeta = [];
  var srcShots = c.screenshots || [];
  for (var sm = 0; sm < srcShots.length; sm++) {
    shotMeta.push({
      file_id: srcShots[sm].file_id, name: srcShots[sm].name, date: srcShots[sm].date,
      width: srcShots[sm].width, height: srcShots[sm].height, size: srcShots[sm].size
    });
  }

  var copy = {};
  for (var key in c) copy[key] = c[key];
  copy.screenshot_files = shotMeta;
  copy.screenshot_turns = res.turns || [];
  copy.screenshot_text = res.text || '';
  copy.screenshot_extract_status = res.status;
  if (res.error) copy.screenshot_error = res.error;
  comms[i] = copy;

  noticesTotal += res.ui_notices_dropped || 0;
  if (res.status === 'ok') { commentsOk++; extracted += res.screenshots_chat || 0; }
  else if (res.status === 'not_chat') commentsNotChat++;
  else if (res.status === 'failed') { commentsFailed++; failedShots += srcShots.length; }
}

var screenshot_stats = {
  screenshots_total: stats.screenshots_total || 0,
  screenshots_extracted: extracted,
  screenshots_failed: failedShots,
  screenshots_downloaded: stats.screenshots_downloaded || 0,
  comments_with_screenshots: stats.comments_with_screenshots || 0,
  comments_ok: commentsOk,
  comments_not_chat: commentsNotChat,
  comments_failed: commentsFailed,
  ui_notices_dropped: noticesTotal,
  model: modelUsed,
  llm_calls: usageTotals.calls,
  prompt_tokens: usageTotals.prompt_tokens,
  completion_tokens: usageTotals.completion_tokens,
  cost_rub: Math.round(usageTotals.cost_rub * 10000) / 10000,
  warnings: warnings
};

var out = {};
for (var bk in base) out[bk] = base[bk];
out.communications = comms;
out.screenshot_stats = screenshot_stats;
out._block = 'screenshots_extracted';

return out;
}
