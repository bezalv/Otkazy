// Перенос детерминированной ноды из выгрузки n8n от 19.10.2026.
export function buildJournal(input) {

var comms = input.communications || [];
function parseDate(dateStr) { if (!dateStr) return null; try { return new Date(dateStr).getTime(); } catch (e) { return null; } }
// В исторических журналах 141 событие на границе суток совпало с UTC.
// UTC здесь задан явно, чтобы дата не зависела от часового пояса контейнера.
function formatDate(dateStr) {
  if (!dateStr) return '?';
  try {
    var d = new Date(dateStr);
    return String(d.getUTCDate()).padStart(2, '0') + '.'
      + String(d.getUTCMonth() + 1).padStart(2, '0') + '.' + d.getUTCFullYear() + ' '
      + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  } catch (e) { return String(dateStr); }
}
function formatDateShort(dateStr) {
  if (!dateStr) return '?';
  try {
    var d = new Date(dateStr);
    return String(d.getUTCDate()).padStart(2, '0') + '.'
      + String(d.getUTCMonth() + 1).padStart(2, '0') + '.' + String(d.getUTCFullYear()).slice(2);
  } catch (e) { return String(dateStr); }
}
var events = [];
for (var i = 0; i < comms.length; i++) { var c = comms[i]; events.push({ index: i, type: c.type, date: c.date, timestamp: parseDate(c.date) || 0, data: c }); }
events.sort(function(a, b) { return a.timestamp - b.timestamp; });
var journalLines = [];
var eventsSummary = [];
for (var j = 0; j < events.length; j++) {
  var evt = events[j]; var d = evt.data; var dateStr = formatDate(d.date);
  var line = ''; var summary = { type: evt.type, date: d.date, formatted_date: dateStr };
  if (evt.type === 'call') {
    var dir = d.direction === 'outgoing' ? 'Исходящий звонок' : 'Входящий звонок';
    var dur = '';
    if (d.duration_start && d.duration_end) { var durSec = Math.round((new Date(d.duration_end).getTime() - new Date(d.duration_start).getTime()) / 1000); if (durSec > 0) { dur = ' (' + Math.floor(durSec/60) + ' мин ' + (durSec%60) + ' сек)'; } }
    line = '[' + dateStr + '] ЗВОНОК: ' + dir + dur;
    if (d._transcribed && d.transcript && d.transcript.length > 0) { line += '\n--- Транскрипт звонка ---\n' + d.transcript + '\n--- Конец транскрипта ---'; summary.has_transcript = true; summary.replicas = d.transcript_replicas || 0; }
    else if (!dur) { line += '\n(Без ответа / короткий звонок)'; summary.has_transcript = false; }
    else { line += '\n(Аудио без транскрипции)'; summary.has_transcript = false; }
  } else if (evt.type === 'comment') {
    // AI-разбор прошлого прогона в журнал не пускаем: журнал идёт в промпт судьи,
    // и судья читал свой же прошлый вердикт. За 60 дней так вышло в 74 разборах из 640.
    // В сборщике фактов такой фильтр был изначально, в журнале его не было.
    var zhCommentText = d.text || '';
    var zhIsAiComment = zhCommentText.indexOf('AI-анализ отказа') !== -1
      || zhCommentText.indexOf('[B]:f09f948d:') !== -1;
    if (zhIsAiComment) { continue; }
    line = '[' + dateStr + '] КОММЕНТАРИЙ МЕНЕДЖЕРА:';
    if (zhCommentText.length > 0) { line += '\n' + zhCommentText; }
    summary.text_length = zhCommentText.length;
  } else if (evt.type === 'chat') {
    var ch = d.channel || 'Мессенджер';
    var authorLabel = '';
    if (d.author_name && d.role && d.role !== 'unknown') { authorLabel = ', ' + d.role + ': ' + d.author_name; }
    else if (d.author_name) { authorLabel = ', ' + d.author_name; }
    if (d._role_source === 'semantic_inference' && d._has_audio !== true && d._has_files !== true
        && d._has_audio_transcript !== true && !d.transcript) { authorLabel += ', предположительно, по контексту'; }
    line = '[' + dateStr + '] СООБЩЕНИЕ (' + ch + authorLabel + ')';
    if (d.text && d.text.length > 0) {
      var chatText = d.text;
      if (chatText.indexOf('=== Исходящее сообщение') === 0) { var nlPos = chatText.indexOf('\n'); if (nlPos !== -1) { chatText = chatText.substring(nlPos + 1); } }
      else if (chatText.indexOf('=== Входящее сообщение') === 0) { var nlPos2 = chatText.indexOf('\n'); if (nlPos2 !== -1) { chatText = chatText.substring(nlPos2 + 1); } }
      // П.8: имя файла голосового в журнале не нужно — это внутренний идентификатор.
      chatText = chatText.replace(/^\s*[0-9a-f-]{8,}\.(ogg|oga|opus|mp3|mpga|m4a|wav)\s*\n+/i, '');
      if (chatText.trim().length > 0 && chatText.trim() !== '[Голосовое сообщение]') { line += '\n' + chatText.trim(); }
    }
    // Блок «--- Транскрипт голосового ---» убран: расшифровка уже внутри d.text,
    // пакет вклеивает её туда сам. До правки один и тот же текст стоял в журнале дважды.
    if (d.transcript && d.transcript.length > 0) { summary.has_voice_transcript = true; }
    summary.channel = ch;
  } else if (evt.type === 'task') {
    var taskStatus = d.status === '5' ? 'закрыта' : (d.status === '2' ? 'в работе' : 'статус ' + d.status);
    line = '[' + dateStr + '] ЗАДАЧА: ' + (d.title || 'Без названия') + ' (' + taskStatus + ')';
    if (d.closed_date) { line += ' — закрыта ' + formatDateShort(d.closed_date); }
    summary.title = d.title; summary.status = taskStatus;
  } else { line = '[' + dateStr + '] ' + evt.type + ': ' + JSON.stringify(d).substring(0, 200); }
  journalLines.push(line); eventsSummary.push(summary);
}
var journalText = journalLines.join('\n\n');
var dealSummary = '=== КАРТОЧКА СДЕЛКИ ===\n';
dealSummary += 'ID: ' + (input.deal_id || '?') + '\nНазвание: ' + (input.title || '?') + '\nСумма: ' + (input.opportunity || '?') + ' ' + (input.currency || '') + '\n';
dealSummary += 'Стадия ДО приостановки: ' + (input.previous_stage_name || '?') + '\nТекущая стадия: ' + (input.stage_name || '?') + '\n';
dealSummary += 'Причина отказа (Bitrix): ' + (input.lose_reason || 'не указана') + '\nДата перехода в отказ: ' + formatDateShort(input.lose_date) + '\n';
dealSummary += 'Дней в отказе: ' + (input.days_in_lost != null ? input.days_in_lost : '?') + '\n';
dealSummary += 'Дата создания сделки: ' + formatDateShort(input.date_create) + '\nИсточник: ' + (input.source || 'не указан') + '\nТип клиента: ' + (input.client_type || 'не указан') + '\n';
if (input.comm_stats) { var cs = input.comm_stats; dealSummary += '\n=== СТАТИСТИКА КОММУНИКАЦИЙ ===\n'; dealSummary += 'Всего событий: ' + (cs.total_events||0) + '\nЗвонки: ' + (cs.calls||0) + ' (с аудио: ' + (cs.calls_with_audio||0) + ')\n'; dealSummary += 'Комментарии: ' + (cs.comments||0) + '\nСообщения в чатах: ' + (cs.chat_messages||0) + '\n'; dealSummary += 'Голосовые в чатах: ' + (cs.chat_audio_transcribed||0) + ' из ' + (cs.chat_audio_files_found||0) + '\nЗадачи: ' + (cs.tasks||0) + '\n'; }
if (input.transcription_stats) { var ts2 = input.transcription_stats; dealSummary += '\n=== ТРАНСКРИПЦИЯ ЗВОНКОВ ===\nТранскрибировано: ' + ts2.calls_transcribed + ' из ' + ts2.calls_with_audio + '\n'; if (ts2.calls_failed > 0) { dealSummary += 'Ошибки: ' + ts2.calls_failed + '\n'; } }
var fullPromptText = dealSummary + '\n\n=== ХРОНОЛОГИЧЕСКИЙ ЖУРНАЛ СОБЫТИЙ ===\n\n' + journalText;
var output = {};
var passFields = ['deal_id','title','assigned_by_id','stage_id','stage_name','category_id','opportunity','currency','date_create','date_modify','pause_reason_id','pause_reason','deferred_until','days_until_deferred','pause_flag','department','product_type','client_type','source','source_description','contact_id','company_id','previous_stage_id','previous_stage_name','pause_date','days_from_pause_to_deferred','stage_history_count','comm_stats','communications','transcription_stats',
  'lose_reason_id','lose_reason','lose_date','days_in_lost','lead_id'];
for (var fi = 0; fi < passFields.length; fi++) { var fn = passFields[fi]; if (input[fn] !== undefined) output[fn] = input[fn]; }
output.deal_summary = dealSummary; output.journal_text = journalText; output.full_prompt_text = fullPromptText; output.journal_events = eventsSummary;
output.journal_stats = { total_events: events.length, events_by_type: { calls: events.filter(function(e){return e.type==='call';}).length, comments: events.filter(function(e){return e.type==='comment';}).length, chats: events.filter(function(e){return e.type==='chat';}).length, tasks: events.filter(function(e){return e.type==='task';}).length }, calls_with_transcript: events.filter(function(e){return e.type==='call'&&e.data._transcribed&&e.data.transcript;}).length, chats_with_voice_transcript: events.filter(function(e){return e.type==='chat'&&e.data.transcript&&e.data.transcript.length>0;}).length, full_prompt_chars: fullPromptText.length, full_prompt_approx_tokens: Math.round(fullPromptText.length/3.5) };
output._block = 'block4_complete'; output._ready_for = 'block5_ai_analysis';
return output;}
