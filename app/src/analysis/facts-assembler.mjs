import { detectNoConversation } from './no-conversation.mjs';
import { hasChatAttachments } from './chat-attachments.mjs';
import { isMissedCallSystemMessage } from '../system-chat.mjs';

// Перенос детерминированной ноды из выгрузки n8n от 19.10.2026.
export function assembleFacts(input, judgeSystemPrompt) {
// ═════════════════════════════════════════════════════════════════════════
// agent-facts-assembler v2.0 — с voicemail/robot detector
// ═════════════════════════════════════════════════════════════════════════

var VM_HIGH_CONFIDENCE = [
  'абонент недоступен', 'абонент не доступен', 'абонент временно недоступен',
  'абонент сейчас не на связи', 'абонент занят',
  'тот кому вы звоните не отвечает', 'номер абонента занят',
  'переведен на автоответчик', 'переведён на автоответчик',
  'оставьте сообщение после сигнала', 'оставьте сообщение после звукового сигнала',
  'оставьте ваше сообщение', 'после звукового сигнала', 'после сигнала',
  'в тоновом режиме', 'в тональном режиме', 'для соединения нажмите',
  'я помощник', 'я помошник', 'секретарь ева',
  'передам сообщение', 'передам ему сообщение', 'передам ваше сообщение',
  'я записала и отправила', 'записала и отправила',
  'сообщение улетело', 'сообщение отправлено',
  'я записал для него ваш ответ', 'я записала для него ваш ответ',
  'оставьте для него ваше сообщение'
];

var VM_ROBOT = [
  'расскажите вкратце',
  'так откуда вы звоните', 'откуда вы звоните',
  'пройдитесь по условиям',
  'а вы робот или человек', 'а вы вообще робот или человек',
  'вы реально человек или компьютер', 'погодите вы точно человек',
  'так вы живой человек', 'а вы случайно не робот',
  'детали предложения расскажите', 'давайте я его отрегулирую',
  'бонусы у вас есть', 'а тариф какой',
  'жду подробностей', 'я жду подробностей',
  'зафиксировала', 'информацию для себя зафиксировала',
  'как долго будет действовать предложение', 'как долго будет действовать акция',
  'долго еще эти условия для меня будут работать',
  'а сроки оформления какие',
  'звучит довольно интересно', 'предложение конечно неплохое',
  'расскажите подробнее что за условия',
  'а расскажите чуть больше по условиям', 'давайте еще про условия',
  'извините а я могу услышать все все условия',
  'рюки крюки', 'руки крюки',
  'вы мне пару дней назад не звонили случайно', 'может быть были все таки вы',
  'у меня сейчас появилось небольшое неотложное дело',
  'мне нужно чтобы вы подождали меня я отвлекусь'
];

function vmNormalize(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,!?;:()"«»\-–—'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectVoicemail(clientText, managerText, durationSec) {
  var joined = vmNormalize((clientText || '') + ' ' + (managerText || ''));
  if (!joined || joined.length < 5) {
    return { isVoicemail: false, matches: [], category: null };
  }
  var highHits = [];
  for (var i = 0; i < VM_HIGH_CONFIDENCE.length; i++) {
    if (joined.indexOf(VM_HIGH_CONFIDENCE[i]) !== -1) highHits.push(VM_HIGH_CONFIDENCE[i]);
  }
  var robotHits = [];
  for (var j = 0; j < VM_ROBOT.length; j++) {
    if (joined.indexOf(VM_ROBOT[j]) !== -1) robotHits.push(VM_ROBOT[j]);
  }
  if (highHits.length >= 1) {
    return { isVoicemail: true, matches: highHits.slice(0, 3), category: 'operator_or_ai_secretary' };
  }
  if (robotHits.length >= 2) {
    return { isVoicemail: true, matches: robotHits.slice(0, 3), category: 'robot_impersonator' };
  }
  if (robotHits.length >= 1 && (typeof durationSec !== 'number' || durationSec <= 30)) {
    return { isVoicemail: true, matches: robotHits.slice(0, 3), category: 'robot_impersonator_short_call' };
  }
  return { isVoicemail: false, matches: [], category: null };
}

// Служебные сообщения Открытых линий — тот же список, что в сборщике (подстрока после вырезания BB-кодов)
var SYSTEM_CHAT_PATTERNS = ['Начат новый диалог','Сделка прикреплена к диалогу','Контактная информация сохранена','Переданы дополнительные данные','Обращение направлено на','Обращение перенаправлено на','работу с диалогом','отказался от диалога','отказалась от диалога','присоединился к диалогу','покинул диалог','Диалог переведен на','Оценка диалога','Сессия закрыта','Сессия завершена','Автоматическое завершение диалога','Создан новый лид','Создана новая сделка','Создан новый контакт','=== SYSTEM WZ ===','Сообщение изменено','Доп. объект','Wazzup App','app.wazzup24.ru','по правилам очереди','Диалог снят с оператора','Обращение возвращено в очередь','К чату присоединил'];
function isSystemChatText(t) { var clean = String(t || '').replace(/\[\/?\w[\w= ]*\]/g, '').trim(); if (!clean) return false; if (isMissedCallSystemMessage(clean)) return true; for (var sp = 0; sp < SYSTEM_CHAT_PATTERNS.length; sp++) { if (clean.indexOf(SYSTEM_CHAT_PATTERNS[sp]) !== -1) return true; } return false; }

// === МОНО-ЗАПИСЬ ЗВОНКА ===
// Источник с пояснениями: prototype/lib/mono-transcript.js. Править ТАМ, здесь — сборка.
// Тот же блок в нодах «Собрать итог» (урезанный) и b4.5 Comm Analytics.
// Зачем: моно-проход (channel_count=1, speaker_role='Говорящий') отдаёт одну дорожку
// речи без разделения сторон, и подворкфлоу кладёт её целиком в manager_text. Сборщик делал
// из неё факт actor=manager, и судья цитировал клиента как менеджера. Таких звонков в базе 362.
var MONO_SPEAKER_RE = /(^|\n)[ \t]*Говорящий[ \t]*:/;
var MONO_SPEAKER_STRIP_RE = /(^|\n)[ \t]*Говорящий[ \t]*:[ \t]*/g;
function monoByText(text) { return MONO_SPEAKER_RE.test(String(text || '')); }
function isMonoTranscript(comm) {
  if (!comm) return false;
  if (comm._transcript_mode === 'mono') return true;
  if (comm._transcript_mode === 'stereo') return false;
  return monoByText(comm.transcript) || monoByText(comm.transcript_manager_text) || monoByText(comm.transcript_client_text);
}
function stripMonoPrefix(text) {
  return String(text || '').replace(MONO_SPEAKER_STRIP_RE, '$1').replace(/[ \t]+\n/g, '\n').trim();
}
function monoWholeText(comm) {
  var c = comm || {};
  var parts = [];
  var mgr = stripMonoPrefix(c.transcript_manager_text);
  var cli = stripMonoPrefix(c.transcript_client_text);
  if (mgr) parts.push(mgr);
  if (cli) parts.push(cli);
  if (!parts.length) { var whole = stripMonoPrefix(c.transcript); if (whole) parts.push(whole); }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
function monoFactContent(comm) {
  var text = monoWholeText(comm);
  if (!text) return '';
  return 'Запись без разделения сторон (одна звуковая дорожка, кто именно говорит — неизвестно): ' + text;
}
// === КОНЕЦ БЛОКА МОНО-ЗАПИСИ ===


var comms = input.communications || [];
var analytics = input.comm_analytics || {};

function parseDate(d) { if (!d) return 0; var t = new Date(d).getTime(); return isNaN(t) ? 0 : t; }
comms = comms.slice().sort(function(a, b) { return parseDate(a.date) - parseDate(b.date); });

var facts = [];
var idx = 0;
function nextId() { idx++; return 'f' + String(idx).padStart(3, '0'); }

var vmStats = { calls_total: 0, calls_voicemail: 0, voicemail_details: [] };

for (var i = 0; i < comms.length; i++) {
  var c = comms[i];
  var ts = c.date;

  if (c.type === 'call') {
    vmStats.calls_total++;
    var hasMgr = c.transcript_manager_text && c.transcript_manager_text.trim().length > 0;
    var hasCli = c.transcript_client_text && c.transcript_client_text.trim().length > 0;
    // Нода «Обработать 1 сделку» складывает звонок с duration_start и duration_end, поля
    // duration_seconds в потоке нет вообще. Из-за этого все факты звонков получали «0 сек»,
    // судья видел неверную длительность, а детекторы работали в режиме «нулевая длительность».
    // Расчёт тот же, что getCallDuration в b4.5 Comm Analytics.
    var dur = 0;
    if (c.duration_seconds && c.duration_seconds > 0) {
      dur = c.duration_seconds;
    } else if (c.duration_start && c.duration_end) {
      var durS = new Date(c.duration_start).getTime();
      var durE = new Date(c.duration_end).getTime();
      if (!isNaN(durS) && !isNaN(durE) && durE > durS) dur = Math.round((durE - durS) / 1000);
    }

    var vmResult = detectVoicemail(c.transcript_client_text, c.transcript_manager_text, dur);

    if (vmResult.isVoicemail) {
      vmStats.calls_voicemail++;
      vmStats.voicemail_details.push({
        ts: ts, direction: c.direction, duration: dur,
        category: vmResult.category, matches: vmResult.matches
      });
      var matchList = vmResult.matches.join('", "');
      var catLabel = (vmResult.category === 'operator_or_ai_secretary')
        ? 'автоответчик оператора или ИИ-секретарь'
        : 'робот-имитатор';
      facts.push({
        fact_id: nextId(),
        source: 'call_event',
        actor: 'system',
        ts: ts,
        direction: c.direction || null,
        content: 'Звонок ' + (c.direction || '?') + ', ' + dur + ' сек. Сработал ' + catLabel + ', содержательного разговора с клиентом нет. Сработавшие паттерны: "' + matchList + '".'
      });
      continue;
    }

    // Разговора с клиентом не было: ответил автоответчик, помощник, чужой человек,
    // прозвучало только приветствие или не установилась связь. Такой звонок даёт один факт
    // с actor=system: иначе голос автоответчика уходит в факты репликой клиента и судья
    // считает его контактом (дефект сделки 119215).
    var ncMono = isMonoTranscript(c);
    var noTalk = detectNoConversation(c.transcript_client_text, c.transcript_manager_text, dur, ncMono);
    if (noTalk) {
      vmStats.calls_no_conversation = (vmStats.calls_no_conversation || 0) + 1;
      var ntWhy = noTalk.reason === 'machine' ? 'ответил автоответчик или голосовой помощник'
        : noTalk.reason === 'not_client' ? 'трубку снял не клиент'
        : noTalk.reason === 'bad_line' ? 'связь не установилась, предложение до клиента не дошло'
        : 'прозвучало только приветствие, цель звонка не названа';
      var ntParts = [];
      if (c.transcript_client_text && c.transcript_client_text.trim()) ntParts.push('та сторона: «' + c.transcript_client_text.trim() + '»');
      if (c.transcript_manager_text && c.transcript_manager_text.trim()) ntParts.push('менеджер: «' + c.transcript_manager_text.trim() + '»');
      facts.push({
        fact_id: nextId(), source: 'call_event', actor: 'system',
        ts: ts, direction: c.direction || null,
        content: 'Звонок ' + (c.direction || '?') + ', ' + dur + ' сек: разговор не состоялся — ' + ntWhy
          + '. Не считать это контактом с клиентом и не приписывать ему слова с той стороны'
          + (ntParts.length ? '. Записано — ' + ntParts.join('; ') : '')
      });
      continue;
    }

    // Моно-запись: одна звуковая дорожка, сторон в ней нет. Один факт actor=unknown:
    // доказательство того, что разговор состоялся, и контекст — но не чьи-то слова.
    // Детектор «разговора не было» отработал выше, так что роботы сюда не доходят.
    if (ncMono) {
      var monoContent = monoFactContent(c);
      if (monoContent) {
        facts.push({
          fact_id: nextId(), source: 'call_transcript', actor: 'unknown',
          ts: ts, direction: c.direction || null, transcript_mode: 'mono',
          content: monoContent
        });
      } else {
        facts.push({
          fact_id: nextId(), source: 'call_event', actor: 'system',
          ts: ts, direction: c.direction || null,
          content: 'Звонок ' + (c.direction || '?') + ', ' + dur + ' сек, без транскрипта'
        });
      }
      continue;
    }

    if (hasMgr) {
      facts.push({
        fact_id: nextId(), source: 'call_transcript', actor: 'manager',
        ts: ts, direction: c.direction || null,
        content: c.transcript_manager_text.trim()
      });
    }
    if (hasCli) {
      facts.push({
        fact_id: nextId(), source: 'call_transcript', actor: 'client',
        ts: ts, direction: c.direction || null,
        content: c.transcript_client_text.trim()
      });
    }
    if (!hasMgr && !hasCli) {
      // Шаг Б п.4: различаем «записи нет» и «запись есть, но не распознана». Раньше оба
      // случая давали один текст «без транскрипта», и судья читал его как отсутствие разговора.
      // Источник: prototype/lib/pipeline-gate.js. Моки: tests/pipeline-gate/run.js
      var hadRecording = (c._needs_transcription === true) || !!c.audio_url
        || !!(c.audio_files && c.audio_files.length) || c._transcription_attempted === true;
      var noTextContent = hadRecording
        ? ('Звонок ' + (c.direction || '?') + ', ' + dur + ' сек: запись есть, но не распознана — содержание неизвестно')
        : ('Звонок ' + (c.direction || '?') + ', ' + dur + ' сек, записи нет');
      facts.push({
        fact_id: nextId(), source: 'call_event', actor: 'system',
        ts: ts, direction: c.direction || null,
        recording_unrecognized: hadRecording ? true : undefined,
        content: noTextContent
      });
    }
  } else if (c.type === 'chat') {
    // П.8: один факт на сообщение. Пакет вклеивает расшифровку голосового в текст
    // сообщения, а здесь из того же сообщения делался ЕЩЁ один факт chat_voice_transcript
    // с тем же текстом. За 60 дней все 28 голосовых фактов оказались дублями, и судья
    // видел одну фразу клиента дважды. Источник: prototype/lib/chat-voice.js
    var chatVoiceFileRe = /^\s*[0-9a-f-]{8,}\.(ogg|oga|opus|mp3|mpga|m4a|wav)\s*\n+/i;
    var txt = String(c.text || '').replace(chatVoiceFileRe, '').trim();
    if (!txt) continue;
    if (!hasChatAttachments(c) && isSystemChatText(txt)) continue;
    var actor = 'unknown';
    if (c.role !== 'unknown' && !c._wazzup_author_ambiguous && !c._wappi_author_ambiguous) {
      if (c.role === 'client' || (c.direction === 'incoming' && c.author_name === 'Клиент')) actor = 'client';
      else if (c.role === 'manager' || c.direction === 'outgoing') actor = 'manager';
    }
    var chatHasVoice = (c._has_audio_transcript === true)
      || !!(c.transcript && String(c.transcript).trim().length > 0);
    facts.push({
      fact_id: nextId(),
      source: chatHasVoice ? 'chat_voice_transcript' : 'chat',
      actor: actor,
      ...(c._role_source === 'semantic_inference' ? { role_source: 'semantic_inference' } : {}),
      ...(c._unknown_role_nonmaterial === 'semantic_inference' && actor === 'unknown'
        ? { unknown_role_nonmaterial: 'semantic_inference' } : {}),
      ts: ts, channel: c.channel || null, author_name: c.author_name || null,
      content: txt
    });
  } else if (c.type === 'comment') {
    var commentText = (c.text || '').trim();
    // фильтр AI-комментов от самого бота (self-feedback loop)
    var isAiComment = commentText.indexOf('AI-анализ отказа') !== -1 || commentText.indexOf('[B]:f09f948d:') !== -1;
    if (!isAiComment) {
      if (commentText) {
        facts.push({
          fact_id: nextId(), source: 'crm_comment', actor: 'manager',
          ts: ts, content: commentText
        });
      }
      // Реплики со скриншотов переписки, приложенных к комментарию
      var shotTurns = c.screenshot_turns || [];
      for (var sti = 0; sti < shotTurns.length; sti++) {
        var stn = shotTurns[sti] || {};
        var stActor = (stn.speaker === 'manager' || stn.speaker === 'client') ? stn.speaker : 'unknown';
        var stContent = String(stn.text || '').trim();
        if (stn.attachment) stContent = (stContent ? stContent + ' ' : '') + '[вложение: ' + stn.attachment + ']';
        if (!stContent) continue;
        // Реплика выше первой плашки: точная дата неизвестна, в факте говорим об этом прямо
        if (stn.date_note) stContent = stContent + ' ' + stn.date_note;
        facts.push({
          fact_id: nextId(), source: 'screenshot_chat', actor: stActor,
          ts: stn.ts || ts, ts_precision: stn.ts_precision || null,
          comment_id: c.comment_id || null, content: stContent
        });
      }
    }
  } else if (c.type === 'task') {
    if (!c.title) continue;
    facts.push({
      fact_id: nextId(), source: 'crm_task', actor: 'manager',
      ts: ts, task_status: c.status || null, content: c.title
    });
  }
}

var deal_card = {
  deal_id: input.deal_id,
  title: input.title,
  opportunity: input.opportunity,
  currency: input.currency,
  lose_reason: input.lose_reason,
  lose_date: input.lose_date,
  days_in_lost: input.days_in_lost,
  stage_id: input.stage_id,
  stage_name: input.stage_name,
  date_create: input.date_create,
  assigned_by_id: input.assigned_by_id,
  source: input.source
};

var facts_packet = {
  deal_card: deal_card,
  metrics: analytics,
  facts: facts
};

var JUDGE_MODEL = 'openai/gpt-6-sol';
var JUDGE_SYSTEM_PROMPT = judgeSystemPrompt;

// Строгая схема ответа судьи: с ней Sol отвечает разборчивым JSON с первого раза,
// regex-фолбэк в разборе не понадобился ни разу на стенде (60 прогонов).
// В strict-схеме каждое поле обязательное, additionalProperties: false, необязательное — тип с null.
// Источник: bench/schema.judge.json — при правке обновить и там.
var PROOF_TYPES = ['client_statement', 'manager_statement', 'crm_comment', 'metric', 'absence'];
function proofItem(textField) {
  var props = {};
  props[textField] = { type: 'string' };
  props.proof_fact_ids = { type: 'array', items: { type: 'string' } };
  props.proof_type = { type: 'string', enum: PROOF_TYPES };
  return { type: 'object', additionalProperties: false, required: [textField, 'proof_fact_ids', 'proof_type'], properties: props };
}
var JUDGE_SCHEMA = {
  name: 'otkaz_judge_verdict',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'verdict_reason_short', 'recoverable_level', 'closure_reason_class', 'misplaced', 'correct_stage', 'exact_reason', 'manager_mistakes', 'key_signals', 'risk_factors', 'questions_for_manager'],
    properties: {
      verdict: { type: 'string', enum: ['правомерен', 'неправомерен', 'недостаточно_данных'] },
      verdict_reason_short: { type: 'string' },
      recoverable_level: { type: ['string', 'null'], enum: ['высокий', 'средний', 'низкий', null] },
      closure_reason_class: { type: 'string', enum: ['price', 'competitor', 'no_need', 'no_money', 'timing', 'manager_dropped', 'customer_unreachable', 'regulatory', 'other'] },
      misplaced: { type: 'boolean' },
      correct_stage: { type: ['string', 'null'] },
      exact_reason: { type: 'string' },
      manager_mistakes: { type: 'array', items: proofItem('mistake') },
      key_signals: { type: 'array', items: proofItem('signal') },
      risk_factors: { type: 'array', items: proofItem('factor') },
      questions_for_manager: { type: 'array', items: { type: 'string' } }
    }
  }
};

// Параметры Sol — по документу «Переход Отказов на GPT-6 Sol — опыт СПИН»:
// flex первым — иначе Polza шлёт обычному openai или azure, в 2,1–2,5 раза дороже;
// запасной оставлен, чтобы разбор не падал при отказе flex;
// reasoning верхнего уровня Polza игнорирует, нужен именно такой вид;
// max_tokens 16000 — рассуждения съедают часть лимита, а обрезанный JSON не разберётся.
var judge_request_body = {
  model: JUDGE_MODEL,
  messages: [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(facts_packet, null, 2) }
  ],
  provider: { order: ['openai/flex', 'openai'], allow_fallbacks: true },
  reasoning: { effort: 'low' },
  max_tokens: 16000,
  temperature: 0,
  response_format: { type: 'json_schema', json_schema: JUDGE_SCHEMA }
};

return {
    deal_id: input.deal_id,
    facts_packet: facts_packet,
    facts_count: facts.length,
    voicemail_stats: vmStats,
    judge_request_body: judge_request_body,
    deal_card: deal_card,
    communications: comms,
    journal_text: input.journal_text,
    analytics_text: input.analytics_text,
    transcription_stats: input.transcription_stats,
    _block: 'agent_facts_assembled'
};
}
