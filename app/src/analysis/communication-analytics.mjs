import { detectNoConversation } from './no-conversation.mjs';
import { hasChatAttachments } from './chat-attachments.mjs';

// Перенос детерминированной ноды из выгрузки n8n от 19.10.2026.
export function buildCommunicationAnalytics(input, referenceTime = new Date()) {

// === МОНО-ЗАПИСЬ ЗВОНКА ===
// Источник: prototype/lib/mono-transcript.js. Править ТАМ, здесь — сборка.
// Здесь нужен только признак режима: текст моно-записи в факты собирает agent-facts-assembler.
var MONO_SPEAKER_RE = /(^|\n)[ \t]*Говорящий[ \t]*:/;
function monoByText(text) { return MONO_SPEAKER_RE.test(String(text || '')); }
function isMonoTranscript(comm) {
  if (!comm) return false;
  if (comm._transcript_mode === 'mono') return true;
  if (comm._transcript_mode === 'stereo') return false;
  return monoByText(comm.transcript) || monoByText(comm.transcript_manager_text) || monoByText(comm.transcript_client_text);
}
// === КОНЕЦ БЛОКА МОНО-ЗАПИСИ ===

var commsRaw = input.communications || [];
// === FILTER OUT SYSTEM CHAT MESSAGES (Bitrix/Wazzup auto-events) ===
// These are not real client messages — they're system notifications about
// dialog routing/start/end. Must not be counted in chats_client metric or
// passed as facts to judge/writer. Defense in depth: even if upstream fails.
var SYSTEM_CHAT_PATTERNS = ['Начат новый диалог','Сделка прикреплена к диалогу','Контактная информация сохранена','Переданы дополнительные данные','Обращение направлено на','Обращение перенаправлено на','работу с диалогом','отказался от диалога','отказалась от диалога','присоединился к диалогу','покинул диалог','Диалог переведен на','Оценка диалога','Сессия закрыта','Сессия завершена','Автоматическое завершение диалога','Создан новый лид','Создана новая сделка','Создан новый контакт','=== SYSTEM WZ ===','Сообщение изменено','Доп. объект','Wazzup App','app.wazzup24.ru','по правилам очереди','Диалог снят с оператора','Обращение возвращено в очередь','К чату присоединил'];
function isSystemChat(c) {
  if (!c || c.type !== 'chat') return false;
  if (hasChatAttachments(c)) return false;
  if (c.is_system === true || c.is_system === 'Y') return true;
  var text = c.text || '';
  if (!text) return true; // empty chat = system marker
  // strip Bitrix tags like [USER=12345 REPLACE] and [/USER]
  var cleanText = text.replace(/\[\/?\w[\w= ]*\]/g, '').trim();
  if (!cleanText) return true;
  for (var sp = 0; sp < SYSTEM_CHAT_PATTERNS.length; sp++) {
    if (cleanText.indexOf(SYSTEM_CHAT_PATTERNS[sp]) !== -1) return true;
  }
  return false;
}
// Наши собственные AI-разборы, записанные в карточку, — не контакт с клиентом и не событие сделки.
// Живой прогон их ещё не видит, перепрогон уже видит — без фильтра метрики расходятся.
// Маркер тот же, что в agent-facts-assembler: одно правило на оба места.
function isAiComment(c) {
  if (!c || c.type !== 'comment') return false;
  var t = (c.text || '').trim();
  return t.indexOf('AI-анализ отказа') !== -1 || t.indexOf('[B]:f09f948d:') !== -1;
}
var comms = commsRaw.filter(function(c) { return !isSystemChat(c) && !isAiComment(c); });
var now = new Date(referenceTime);
function parseDate(dateStr) { if (!dateStr) return null; try { var t = new Date(dateStr).getTime(); return isNaN(t) ? null : t; } catch (e) { return null; } }
function daysBetween(ts1, ts2) { return Math.round(Math.abs(ts2 - ts1) / 86400000); }
// === ТОЧКА ОТСЕЧКИ ===
// Метрики хода продажи считаем на момент закрытия сделки, а не от даты прогона:
// иначе те же факты назавтра дают другой вердикт.
var lastEventTs = null;
for (var lei = 0; lei < comms.length; lei++) { var evTs = parseDate(comms[lei].date); if (evTs !== null && (lastEventTs === null || evTs > lastEventTs)) lastEventTs = evTs; }
var cutoffSource = 'lose_date';
var cutoffTs = parseDate(input.lose_date);
if (cutoffTs === null) { cutoffTs = lastEventTs; cutoffSource = 'last_event'; }
if (cutoffTs === null) { cutoffTs = parseDate(input.date_modify); cutoffSource = 'date_modify'; }
if (cutoffTs === null) { cutoffTs = now.getTime(); cutoffSource = 'now'; }
var cutoffShiftedDays = 0;
if (lastEventTs !== null && cutoffTs < lastEventTs) { cutoffShiftedDays = daysBetween(cutoffTs, lastEventTs); cutoffTs = lastEventTs; }
var daysSinceLose = Math.max(0, Math.round((now.getTime() - cutoffTs) / 86400000));
// daysAgo теперь означает «за сколько дней до закрытия», а не «сколько дней назад от сегодня»
function daysAgo(ts) { return daysBetween(ts, cutoffTs); }
function formatDuration(sec) { if (!sec || sec <= 0) return '0s'; var m = Math.floor(sec / 60); var s = sec % 60; if (m > 0) return m + 'm' + (s > 0 ? String(s).padStart(2, '0') + 's' : ''); return s + 's'; }
// Как и в исторических журналах, текстовые даты формируются по UTC.
function formatDateRu(ts) {
  if (!ts) return '?';
  var d = new Date(ts);
  return String(d.getUTCDate()).padStart(2, '0') + '.'
    + String(d.getUTCMonth() + 1).padStart(2, '0') + '.' + d.getUTCFullYear();
}
var calls = [], chats = [], comments = [], tasks = [];
for (var i = 0; i < comms.length; i++) { var c = comms[i]; var ts = parseDate(c.date); if (!ts) continue; var item = { index: i, ts: ts, data: c }; if (c.type === 'call') calls.push(item); else if (c.type === 'chat') chats.push(item); else if (c.type === 'comment') comments.push(item); else if (c.type === 'task') tasks.push(item); }
calls.sort(function(a, b) { return a.ts - b.ts; });
chats.sort(function(a, b) { return a.ts - b.ts; });
// Звонки, где разговора с клиентом не было (автоответчик, помощник, чужой человек,
// одно приветствие, обрыв связи), не должны считаться успешными и сдвигать последний
// контакт: иначе «дни молчания» обнуляются о звонок автоответчику (дефект сделки 119215).
// Сам звонок из calls_total не выкидываем — попытка была, и РОП должен её видеть.
// Моно-запись с живым текстом — содержательный звонок: контакт был, длительность
// реальная, из meaningful и из «последнего контакта» его не выкидываем. Но сторон в записи
// нет, поэтому реплик по сторонам из него не делает сборщик фактов.
// В инициативе моно участвует наравне со стерео: направление звонка берётся из
// активности Битрикса и от режима транскрипции не зависит. monoIdx остался под метрику.
var noTalkIdx = {};
var monoIdx = {};
var callsNoConversation = 0;
var callsMono = 0;
for (var nci = 0; nci < calls.length; nci++) {
  var ncd = calls[nci].data;
  var ncMono = isMonoTranscript(ncd);
  if (detectNoConversation(ncd.transcript_client_text, ncd.transcript_manager_text, getCallDuration(calls[nci]), ncMono)) {
    calls[nci].noConversation = true;
    noTalkIdx[calls[nci].index] = true;
    callsNoConversation++;
  } else if (ncMono) {
    calls[nci].monoTranscript = true;
    monoIdx[calls[nci].index] = true;
    callsMono++;
  }
}
var callsOutgoing = calls.filter(function(c) { return c.data.direction === 'outgoing'; });
var callsIncoming = calls.filter(function(c) { return c.data.direction === 'incoming'; });
function getCallDuration(c) { if (c.data.duration_seconds && c.data.duration_seconds > 0) return c.data.duration_seconds; if (c.data.duration_start && c.data.duration_end) { var ds = new Date(c.data.duration_start).getTime(); var de = new Date(c.data.duration_end).getTime(); if (!isNaN(ds) && !isNaN(de) && de > ds) return Math.round((de - ds) / 1000); } return 0; }
var unansweredOutgoing = callsOutgoing.filter(function(c) { return getCallDuration(c) <= 5; });
var meaningfulCalls = calls.filter(function(c) { return !c.noConversation && getCallDuration(c) > 15; });
var meaningfulDurations = meaningfulCalls.map(function(c) { return getCallDuration(c); });
var avgMeaningfulDuration = meaningfulDurations.length > 0 ? Math.round(meaningfulDurations.reduce(function(a, b) { return a + b; }, 0) / meaningfulDurations.length) : 0;
var longestCall = null; var longestDuration = 0;
for (var li = 0; li < calls.length; li++) { var dur = getCallDuration(calls[li]); if (dur > longestDuration) { longestDuration = dur; longestCall = calls[li]; } }
var lastSuccessfulCall = meaningfulCalls.length > 0 ? meaningfulCalls[meaningfulCalls.length - 1] : null;
var callsWithAudio = calls.filter(function(c) { return c.data._needs_transcription === true || c.data._transcribed === true || (c.data.audio_files && c.data.audio_files.length > 0); });
var callsTranscribed = calls.filter(function(c) { return c.data._transcribed === true && c.data.transcript && c.data.transcript.length > 0; });
var callsPending = Math.max(0, callsWithAudio.length - callsTranscribed.length);
var maxUnansweredStreak = 0; var currentStreak = 0;
for (var ui = 0; ui < calls.length; ui++) { if (getCallDuration(calls[ui]) <= 5 && calls[ui].data.direction === 'outgoing') { currentStreak++; } else { if (currentStreak > maxUnansweredStreak) maxUnansweredStreak = currentStreak; currentStreak = 0; } }
if (currentStreak > maxUnansweredStreak) maxUnansweredStreak = currentStreak;
var missedIncoming = callsIncoming.filter(function(c) { return getCallDuration(c) <= 5; });
var maxMissedIncomingStreak = 0; var curMissed = 0;
for (var mi = 0; mi < callsIncoming.length; mi++) { if (getCallDuration(callsIncoming[mi]) <= 5) { curMissed++; } else { if (curMissed > maxMissedIncomingStreak) maxMissedIncomingStreak = curMissed; curMissed = 0; } }
if (curMissed > maxMissedIncomingStreak) maxMissedIncomingStreak = curMissed;
var chatManager = chats.filter(function(c) { return c.data.role === 'manager' || c.data.direction === 'outgoing'; });
var chatClient = chats.filter(function(c) { return c.data.role === 'client' || (c.data.direction === 'incoming' && c.data.role !== 'unknown'); });
var chatUnknown = chats.filter(function(c) { return c.data.role === 'unknown' || (c.data.direction === 'unknown' && !c.data.role); });
var lastClientChat = chatClient.length > 0 ? chatClient[chatClient.length - 1] : null;
var lastManagerChat = chatManager.length > 0 ? chatManager[chatManager.length - 1] : null;
var lastChat = chats.length > 0 ? chats[chats.length - 1] : null;
var unansweredByManager = false; var unansweredByClient = false;
if (lastChat) { if ((lastChat.data.role === 'client' || lastChat.data.direction === 'incoming') && lastChat.data.role !== 'unknown') unansweredByManager = true; else if ((lastChat.data.role === 'manager' || lastChat.data.direction === 'outgoing') && lastChat.data.role !== 'unknown') unansweredByClient = true; }
var preferredChannel = 'mixed';
if (chats.length === 0 && calls.length > 0) preferredChannel = 'phone_only';
else if (calls.length === 0 && chats.length > 0) preferredChannel = 'messenger_only';
var allEvents = [];
for (var ai = 0; ai < comms.length; ai++) { if (noTalkIdx[ai]) continue; var ats = parseDate(comms[ai].date); if (ats) allEvents.push({ ts: ats, data: comms[ai] }); }
allEvents.sort(function(a, b) { return a.ts - b.ts; });
var firstContact = allEvents.length > 0 ? allEvents[0].ts : null;
var lastContact = allEvents.length > 0 ? allEvents[allEvents.length - 1].ts : null;
var maxGapDays = 0; var maxGapWho = 'unknown'; var maxGapStart = null; var maxGapEnd = null;
for (var gi = 1; gi < allEvents.length; gi++) { var gap = daysBetween(allEvents[gi - 1].ts, allEvents[gi].ts); if (gap > maxGapDays) { maxGapDays = gap; maxGapStart = allEvents[gi - 1].ts; maxGapEnd = allEvents[gi].ts; var nextEvt = allEvents[gi].data; if (nextEvt.direction === 'incoming' || nextEvt.role === 'client') maxGapWho = 'manager'; else if (nextEvt.direction === 'outgoing' || nextEvt.role === 'manager' || nextEvt.type === 'comment') maxGapWho = 'client'; else maxGapWho = 'unknown'; } }
var initiativeManager = 0; var initiativeClient = 0;
for (var ii = 0; ii < comms.length; ii++) { var cm = comms[ii]; if (noTalkIdx[ii]) continue; if (cm.type === 'call') { if (cm.direction === 'outgoing') initiativeManager++; else if (cm.direction === 'incoming') initiativeClient++; } else if (cm.type === 'chat') { if (cm.role === 'unknown') continue; if (cm.direction === 'outgoing' || cm.role === 'manager') initiativeManager++; else if (cm.direction === 'incoming' || cm.role === 'client') initiativeClient++; } }
var initiativeTotal = initiativeManager + initiativeClient;
var initiativeManagerPct = initiativeTotal > 0 ? Math.round(initiativeManager / initiativeTotal * 100) : 0;
var initiativeClientPct = initiativeTotal > 0 ? Math.round(initiativeClient / initiativeTotal * 100) : 0;
var trend = 'unknown';
if (allEvents.length >= 4) { var mid = Math.floor(allEvents.length / 2); var firstHalf = allEvents.slice(0, mid); var secondHalf = allEvents.slice(mid); var firstHalfDays = Math.max(1, firstHalf.length > 1 ? daysBetween(firstHalf[0].ts, firstHalf[firstHalf.length - 1].ts) : 1); var secondHalfDays = Math.max(1, secondHalf.length > 1 ? daysBetween(secondHalf[0].ts, secondHalf[secondHalf.length - 1].ts) : 1); var rateFirst = firstHalf.length / firstHalfDays; var rateSecond = secondHalf.length / secondHalfDays; var ratio = rateSecond / rateFirst; var bigGaps = 0; var maxSingleGap = 0; var totalPeriod = Math.max(1, daysBetween(allEvents[0].ts, allEvents[allEvents.length - 1].ts)); for (var pi = 1; pi < allEvents.length; pi++) { var gapD = daysBetween(allEvents[pi - 1].ts, allEvents[pi].ts); if (gapD > 14) bigGaps++; if (gapD > maxSingleGap) maxSingleGap = gapD; } if (bigGaps >= 2 || (bigGaps >= 1 && maxSingleGap / totalPeriod > 0.4)) trend = 'pulsating'; else if (ratio > 1.5) trend = 'increasing'; else if (ratio < 0.5) trend = 'decreasing'; else trend = 'stable'; }
var pauseCycles = 0;
for (var ti = 0; ti < tasks.length; ti++) { var taskTitle = (tasks[ti].data.title || '').toLowerCase(); var tLow = taskTitle.replace(/["\u00ab\u00bb\u201c\u201d\u201e\u201f]/g, ''); if (tLow.indexOf('\u0432\u0435\u0440\u043d\u0443\u043b\u0430\u0441\u044c \u0438\u0437 \u043f\u0440\u0438\u043e\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u043d\u044b\u0445') !== -1 || tLow.indexOf('\u0432\u0435\u0440\u043d\u0443\u043b\u0441\u044f \u0438\u0437 \u043f\u0440\u0438\u043e\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u043d\u044b\u0445') !== -1) pauseCycles++; }
var dateCreate = parseDate(input.date_create);
var daysInFunnel = dateCreate ? daysAgo(dateCreate) : 0;
var dataWarnings = [];
if (cutoffSource !== 'lose_date') dataWarnings.push('Cutoff by ' + cutoffSource + ' (lose_date missing)');
var transcribedPct = callsWithAudio.length > 0 ? Math.round(callsTranscribed.length / callsWithAudio.length * 100) : 100;
if (transcribedPct < 50 && callsWithAudio.length > 0) dataWarnings.push('Low transcription: ' + transcribedPct + '%');
if (callsPending > 0) dataWarnings.push(callsPending + ' calls pending');
var unknownPct = chats.length > 0 ? Math.round(chatUnknown.length / chats.length * 100) : 0;
if (unknownPct > 50 && chats.length > 0) dataWarnings.push(chatUnknown.length + '/' + chats.length + ' unknown author');
var nonmaterialUnknownCount = chatUnknown.filter(function(c) { return c.data._unknown_role_nonmaterial === 'semantic_inference'; }).length;
if (nonmaterialUnknownCount > 0) dataWarnings.push('Автор ' + nonmaterialUnknownCount + ' сообщений неизвестен; модель предположила их несущественность, метрики сторон могут быть не определены');
// Роли, восстановленные моделью из смысла, — оценки, а не технически
// подтверждённые участники. Метрики ниже, которые используют сторону, тоже
// зависят от этих оценок. Обычные анализы не получают дополнительных полей.
var semanticRoleCount = chats.filter(function(c) { return c.data._role_source === 'semantic_inference'; }).length;
if (semanticRoleCount > 0) dataWarnings.push('Авторы ' + semanticRoleCount + ' сообщений оценены по контексту: метрики сторон являются предположительными');
var analytics = { cutoff_at: new Date(cutoffTs).toISOString(), cutoff_source: cutoffSource, calls_no_conversation: callsNoConversation, calls_mono_recorded: callsMono, days_in_funnel_until_lose: daysInFunnel, calls_total: calls.length, calls_outgoing: callsOutgoing.length, calls_incoming: callsIncoming.length, calls_unanswered_outgoing: unansweredOutgoing.length, calls_unanswered_outgoing_pct: callsOutgoing.length > 0 ? Math.round(unansweredOutgoing.length / callsOutgoing.length * 100) : 0, calls_missed_incoming: missedIncoming.length, calls_meaningful: meaningfulCalls.length, calls_avg_duration_sec: avgMeaningfulDuration, calls_longest_duration_sec: longestDuration, calls_longest_date: longestCall ? formatDateRu(longestCall.ts) : null, calls_last_successful: lastSuccessfulCall ? formatDateRu(lastSuccessfulCall.ts) : null, calls_last_successful_days_before_lose: lastSuccessfulCall ? daysAgo(lastSuccessfulCall.ts) : null, calls_pending: callsPending, calls_incoming_pct: calls.length > 0 ? Math.round(callsIncoming.length / calls.length * 100) : 0, calls_max_unanswered_streak: maxUnansweredStreak, calls_max_missed_incoming_streak: maxMissedIncomingStreak, chats_total: chats.length, chats_manager: chatManager.length, chats_client: chatClient.length, chats_unknown: chatUnknown.length, chats_last_client_msg: lastClientChat ? formatDateRu(lastClientChat.ts) : null, chats_last_client_days_before_lose: lastClientChat ? daysAgo(lastClientChat.ts) : null, chats_last_manager_msg: lastManagerChat ? formatDateRu(lastManagerChat.ts) : null, chats_last_manager_days_before_lose: lastManagerChat ? daysAgo(lastManagerChat.ts) : null, chats_unanswered_by_manager: unansweredByManager, chats_unanswered_by_client: unansweredByClient, preferred_channel: preferredChannel, first_contact: firstContact ? formatDateRu(firstContact) : null, last_contact: lastContact ? formatDateRu(lastContact) : null, last_contact_days_before_lose: lastContact ? daysAgo(lastContact) : null, initiative_manager_pct: initiativeManagerPct, initiative_client_pct: initiativeClientPct, max_gap_days: maxGapDays, max_gap_who: maxGapWho, max_gap_period: maxGapStart && maxGapEnd ? formatDateRu(maxGapStart) + ' - ' + formatDateRu(maxGapEnd) : null, trend: trend, pause_cycles: pauseCycles, comments_count: comments.length, tasks_count: tasks.length, data_quality_transcribed_pct: transcribedPct, data_quality_unknown_author_pct: unknownPct, data_quality_warnings: dataWarnings };
if (semanticRoleCount > 0) analytics.chat_role_inference = {
  source: 'semantic_inference', count: semanticRoleCount,
  affected_metrics: ['chats_manager', 'chats_client', 'chats_unknown', 'chats_last_client_msg',
    'chats_last_client_days_before_lose', 'chats_last_manager_msg', 'chats_last_manager_days_before_lose',
    'chats_unanswered_by_manager', 'chats_unanswered_by_client', 'initiative_manager_pct', 'initiative_client_pct',
    'max_gap_who', 'data_quality_unknown_author_pct']
};
if (nonmaterialUnknownCount > 0) {
  // Любое неизвестное авторство меняет возможные значения численности,
  // последнего сообщения и инициативы; ноль или false здесь были бы ложной
  // уверенностью. Общее число чатов и число unknown по-прежнему известны.
  var unknownAffectedMetrics = ['chats_manager', 'chats_client', 'chats_last_client_msg',
    'chats_last_client_days_before_lose', 'chats_last_manager_msg', 'chats_last_manager_days_before_lose',
    'initiative_manager_pct', 'initiative_client_pct', 'max_gap_who'];
  for (var uai = 0; uai < unknownAffectedMetrics.length; uai++) analytics[unknownAffectedMetrics[uai]] = null;
  if (lastChat && (lastChat.data.role === 'unknown' || lastChat.data.direction === 'unknown')) {
    analytics.chats_unanswered_by_manager = null;
    analytics.chats_unanswered_by_client = null;
    unknownAffectedMetrics.push('chats_unanswered_by_manager', 'chats_unanswered_by_client');
  }
  analytics.chat_unknown_nonmaterial = { source: 'semantic_inference', count: nonmaterialUnknownCount,
    affected_metrics: unknownAffectedMetrics };
}
var L = [];
L.push('--- COMM ANALYTICS ---');
var pS = firstContact ? formatDateRu(firstContact) : formatDateRu(dateCreate);
var pE = lastContact ? formatDateRu(lastContact) : formatDateRu(now.getTime());
L.push('Period: ' + pS + ' - ' + pE + ' (' + daysInFunnel + ' days in funnel, until lose)');
L.push('Cutoff (deal closed): ' + formatDateRu(cutoffTs) + ' [source: ' + cutoffSource + (cutoffShiftedDays > 0 ? ', shifted +' + cutoffShiftedDays + 'd to last event' : '') + ']');
L.push('Days since lose (as of today): ' + daysSinceLose);
L.push('Pause reason (Bitrix): ' + (input.pause_reason || '?'));
if (input.deferred_until) L.push('Deferred until: ' + formatDateRu(parseDate(input.deferred_until)) + (input.days_until_deferred !== undefined ? ' (in ' + input.days_until_deferred + ' days)' : ''));
L.push('Amount: ' + (input.opportunity || '?') + ' RUB');
L.push('');
L.push('Calls: ' + calls.length + ' (' + callsOutgoing.length + ' out, ' + callsIncoming.length + ' in)');
if (meaningfulCalls.length > 0) L.push('  Meaningful: ' + meaningfulCalls.length + ' (avg ' + formatDuration(avgMeaningfulDuration) + ')');
if (callsMono > 0) L.push('  Записей без разделения сторон: ' + callsMono + ' (разговор состоялся, кто что сказал — неизвестно)');
if (callsOutgoing.length > 0) L.push('  Unanswered out: ' + unansweredOutgoing.length + '/' + callsOutgoing.length + ' (' + analytics.calls_unanswered_outgoing_pct + '%)');
if (missedIncoming.length > 0) L.push('  Missed incoming: ' + missedIncoming.length);
if (longestCall) L.push('  Longest: ' + formatDuration(longestDuration) + ' (' + formatDateRu(longestCall.ts) + ')');
if (lastSuccessfulCall) L.push('  Last successful: ' + formatDateRu(lastSuccessfulCall.ts) + ' (' + daysAgo(lastSuccessfulCall.ts) + ' days before lose)');
if (callsIncoming.length > 0) L.push('  Client incoming: ' + callsIncoming.length + ' (' + analytics.calls_incoming_pct + '%)' + (analytics.calls_incoming_pct >= 50 ? ' <- client calls' : ''));
if (maxUnansweredStreak >= 3) L.push('  ! ' + maxUnansweredStreak + ' unanswered outgoing streak');
if (maxMissedIncomingStreak >= 3) L.push('  ! ' + maxMissedIncomingStreak + ' missed incoming streak');
if (callsPending > 0) L.push('  [i] Pending transcription: ' + callsPending);
L.push('');
if (chats.length > 0) { var cp = nonmaterialUnknownCount > 0 ? ['авторы сторон частично неизвестны'] : ['manager: ' + chatManager.length, 'client: ' + chatClient.length]; if (chatUnknown.length > 0) cp.push('unknown: ' + chatUnknown.length); L.push('Chats: ' + chats.length + ' (' + cp.join(', ') + ')'); if (lastClientChat && !nonmaterialUnknownCount) L.push('  Last client msg: ' + formatDateRu(lastClientChat.ts) + ' (' + daysAgo(lastClientChat.ts) + ' days before lose)'); if (lastManagerChat && !nonmaterialUnknownCount) L.push('  Last manager msg: ' + formatDateRu(lastManagerChat.ts) + ' (' + daysAgo(lastManagerChat.ts) + ' days before lose)'); if (analytics.chats_unanswered_by_manager === true) L.push('  ! Last msg from client - manager did not reply'); if (analytics.chats_unanswered_by_client === true) L.push('  [i] Last msg from manager - client did not reply'); if (unknownPct > 50) L.push('  ! ' + chatUnknown.length + ' msgs without author attribution'); L.push(''); }
L.push('Dynamics:');
if (firstContact) L.push('  First contact: ' + formatDateRu(firstContact));
if (lastContact) L.push('  Last contact: ' + formatDateRu(lastContact) + ' (' + daysAgo(lastContact) + ' days before lose)');
if (maxGapDays > 0 && maxGapStart) L.push('  Max gap: ' + maxGapDays + ' days (' + formatDateRu(maxGapStart) + ' - ' + formatDateRu(maxGapEnd) + ', ' + (!nonmaterialUnknownCount && maxGapWho === 'manager' ? 'manager silent' : !nonmaterialUnknownCount && maxGapWho === 'client' ? 'client silent' : '?') + ')');
L.push(nonmaterialUnknownCount ? '  Initiative: неизвестно (часть авторов сообщений не установлена)' : '  Initiative: manager ' + initiativeManagerPct + '% / client ' + initiativeClientPct + '%');
L.push('  Trend: ' + trend);
L.push('  Pause cycles: ' + pauseCycles);
if (preferredChannel !== 'mixed') L.push('  Channel: ' + preferredChannel);
L.push('');
if (dataWarnings.length > 0 || callsWithAudio.length > 0) { L.push('Data quality:'); if (callsWithAudio.length > 0) L.push('  Transcriptions: ' + callsTranscribed.length + '/' + callsWithAudio.length + ' (' + transcribedPct + '%)'); for (var wi = 0; wi < dataWarnings.length; wi++) L.push('  ! ' + dataWarnings[wi]); }
L.push('--- END ANALYTICS ---');
var analyticsText = L.join('\n');
var existingPrompt = input.full_prompt_text || '';
var newFullPrompt = '';
var journalMarker = '=== \u0425\u0420\u041e\u041d\u041e\u041b\u041e\u0413\u0418\u0427\u0415\u0421\u041a\u0418\u0419 \u0416\u0423\u0420\u041d\u0410\u041b \u0421\u041e\u0411\u042b\u0422\u0418\u0419 ===';
var mIdx = existingPrompt.indexOf(journalMarker);
if (mIdx !== -1) { newFullPrompt = existingPrompt.substring(0, mIdx) + '\n' + analyticsText + '\n\n' + existingPrompt.substring(mIdx); } else { newFullPrompt = analyticsText + '\n\n' + existingPrompt; }
var output = {};
var pf = ['deal_id', 'title', 'assigned_by_id', 'stage_id', 'stage_name', 'category_id', 'opportunity', 'currency', 'date_create', 'date_modify', 'pause_reason_id', 'pause_reason', 'deferred_until', 'days_until_deferred', 'pause_flag', 'department', 'product_type', 'client_type', 'source', 'source_description', 'contact_id', 'company_id', 'previous_stage_id', 'previous_stage_name', 'pause_date', 'days_from_pause_to_deferred', 'stage_history_count', 'comm_stats', 'communications', 'lose_reason_id', 'lose_reason', 'lose_date', 'days_in_lost', 'lead_id', 'transcription_stats', 'deal_summary', 'journal_text', 'journal_events', 'journal_stats'];
for (var fi = 0; fi < pf.length; fi++) { var fn = pf[fi]; if (input[fn] !== undefined) output[fn] = input[fn]; }
output.full_prompt_text = newFullPrompt;
output.comm_analytics = analytics;
output.analytics_text = analyticsText;
output._block = 'block4.5_complete';
output._ready_for = 'block5_ai_analysis';
return output;}
