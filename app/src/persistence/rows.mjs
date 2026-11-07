// Поля и преобразования перенесены из «Подготовить SQL» (19.10.2026).
const VOICEMAIL_PATTERNS = [
  'абонент не отвечает', 'голосовой почтовый ящик', 'голосовую почту',
  'оставить сообщение после', 'оставить ему сообщение после', 'аппарат абонента выключен',
  'вне зоны обслуживания', 'номер не существует', 'набранный вами номер',
  'не может ответить на ваш звонок', 'запись разговоров активирована',
];

const emptyToNull = (value) => value == null || value === '' || value === 'null' || value === 'undefined' ? null : value;
const json = (value) => value == null ? null : JSON.stringify(value, (_, part) => typeof part === 'string' ? part.replace(/\0/g, '') : part);
const numeric = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function cleanHtml(text) {
  return String(text || '').replace(/\[img\][^\[]*\[\/img\]/gi, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/  +/g, ' ').trim();
}

function isVoicemail(text) {
  if (!text) return false;
  const stripped = String(text).replace(/^(Менеджер|Клиент|Говорящий):\s*/gm, '');
  if (!VOICEMAIL_PATTERNS.some((pattern) => stripped.toLowerCase().includes(pattern))) return false;
  return stripped.length < 300 || stripped.split('\n').filter((line) => line.trim().length > 30).length <= 1;
}

export function baseDealRow(deal) {
  return {
    deal_id: deal.deal_id, title: deal.title ?? null, opportunity: numeric(deal.opportunity),
    currency: deal.currency || 'RUB', category_id: emptyToNull(deal.category_id),
    assigned_by_id: emptyToNull(deal.assigned_by_id), date_create: emptyToNull(deal.date_create),
    date_modify: emptyToNull(deal.date_modify), stage_id: emptyToNull(deal.stage_id),
    stage_name: emptyToNull(deal.stage_name), previous_stage_id: emptyToNull(deal.previous_stage_id),
    previous_stage_name: emptyToNull(deal.previous_stage_name), stage_history_count: numeric(deal.stage_history_count),
    department: emptyToNull(deal.department), contact_id: emptyToNull(deal.contact_id),
    company_id: emptyToNull(deal.company_id), client_type: emptyToNull(deal.client_type),
    source: emptyToNull(deal.source), source_description: emptyToNull(deal.source_description),
    utm_source: emptyToNull(deal.utm_source), utm_medium: emptyToNull(deal.utm_medium),
    utm_campaign: emptyToNull(deal.utm_campaign), product_type: json(deal.product_type || []),
    lose_reason_id: emptyToNull(deal.lose_reason_id), lose_reason: deal.lose_reason || '',
    lose_date: emptyToNull(deal.lose_date), days_in_lost: deal.days_in_lost ?? null,
    lead_id: deal.lead_id ? Number(deal.lead_id) : null,
  };
}

export function processedRows(result, deal, comms) {
  const classification = result.classification || {};
  const analysis = result.audio_wait_expired === true
    ? { ...result.multi_agent_analysis, data_scope: 'not_collected', data_scope_reason: 'audio_wait_expired' }
    : result.multi_agent_analysis;
  const meta = result.llm_meta || {};
  const stats = result.comm_stats || {};
  const screenshots = result.screenshot_stats || {};
  const judgeUsage = analysis.judge_usage || {};
  const writerUsage = analysis.writer_usage || {};
  const calls = comms.filter((comm) => comm.type === 'call');
  const transcribed = calls.filter((comm) => comm.transcript && String(comm.transcript).length > 0).length;
  const failed = calls.filter((comm) => !comm.transcript && comm._needs_transcription).length;
  const correctness = analysis.verdict === 'правомерен' ? 'correct' : analysis.verdict === 'неправомерен' ? 'premature' : null;
  const recoverable = analysis.verdict === 'правомерен' ? 'no'
    : analysis.recoverable_level === 'высокий' ? 'yes_high' : analysis.recoverable_level === 'средний' ? 'yes_medium' : null;
  const probability = analysis.recoverable_level === 'высокий' ? 80 : analysis.recoverable_level === 'средний' ? 50 : 0;
  const fullPrompt = result.full_prompt_text || '';
  const journal = result.journal_text || '';
  const row = {
    ...baseDealRow(deal),
    pause_reason_id: emptyToNull(deal.pause_reason_id), pause_reason: deal.pause_reason || '',
    pause_date: emptyToNull(deal.pause_date), deferred_until: emptyToNull(deal.deferred_until),
    days_until_deferred: deal.days_until_deferred ?? null, pause_flag: emptyToNull(deal.pause_flag),
    comm_total_events: numeric(stats.total_events), comm_calls: numeric(stats.calls),
    comm_calls_with_audio: numeric(stats.calls_with_audio), comm_comments: numeric(stats.comments),
    comm_chat_messages: numeric(stats.chat_messages), comm_tasks: numeric(stats.tasks),
    comm_chats_count: numeric(stats.chats_count), trans_calls_transcribed: transcribed, trans_calls_failed: failed,
    last_ai_reason_class: emptyToNull(classification.reason_class), last_ai_maturity: emptyToNull(classification.maturity),
    last_ai_probability: numeric(classification.reactivation_probability), last_ai_route: emptyToNull(classification.reactivation_route),
    last_ai_misplaced: !!classification.misplaced_stage, last_ai_closure_correctness: correctness,
    last_ai_closure_reason_class: emptyToNull(analysis.closure_reason_class), last_ai_recoverable_now: recoverable,
    last_ai_recovery_probability: probability, last_ai_recovery_route: null,
    full_prompt_text: fullPrompt, journal_text: journal, comm_analytics: result.comm_analytics ? json(result.comm_analytics) : null,
    times_suspended: 1, analysis_count: 1,
  };
  const history = {
    deal_id: deal.deal_id, ai_summary: classification.summary || '', ai_exact_reason: classification.exact_reason || '',
    ai_reason_class: emptyToNull(classification.reason_class), ai_maturity: emptyToNull(classification.maturity),
    ai_contact_level: emptyToNull(classification.contact_level), ai_urgency: emptyToNull(classification.urgency),
    ai_probability: numeric(classification.reactivation_probability), ai_route: emptyToNull(classification.reactivation_route),
    ai_manager_script: classification.manager_script || '', ai_key_signals: json(classification.key_signals || []),
    ai_risk_factors: json(classification.risk_factors || []), ai_misplaced: !!classification.misplaced_stage,
    ai_correct_stage: emptyToNull(classification.correct_stage), llm_model: meta.model || '',
    llm_prompt_tokens: numeric(meta.prompt_tokens), llm_completion_tokens: numeric(meta.completion_tokens),
    llm_total_tokens: numeric(meta.total_tokens), llm_warnings: json(meta.warnings || []),
    comm_total_at_run: numeric(stats.total_events), full_prompt_text: fullPrompt, journal_text: journal,
    prompt_chars: fullPrompt.length, prompt_approx_tokens: Math.round(fullPrompt.length / 3.5),
    processing_time_sec: numeric(result.processing_time_sec), prompt_version: result.prompt_version || 'v2.8-sol',
    pipeline_error: null, trigger_type: 'batch', ai_verdict: analysis.verdict,
    ai_verdict_reason_short: emptyToNull(analysis.verdict_reason_short), ai_closure_correctness: correctness,
    ai_closure_reason_class: emptyToNull(analysis.closure_reason_class), ai_recoverable_now: recoverable,
    ai_recovery_probability: probability, ai_recovery_route: null, ai_manager_mistakes: json(analysis.manager_mistakes || []),
    ai_final_comment: analysis.final_comment || '', ai_recovery_script: '', ai_facts_json: json(analysis.facts_packet || {}),
    ai_judge_json: json(analysis), ai_proof_warnings: json(analysis.proof_warnings || []),
    ai_facts_count: analysis.facts_packet?.facts?.length || 0, judge_model: emptyToNull(analysis.judge_model),
    judge_prompt_tokens: numeric(judgeUsage.prompt_tokens), judge_completion_tokens: numeric(judgeUsage.completion_tokens),
    writer_model: emptyToNull(analysis.writer_model), writer_prompt_tokens: numeric(writerUsage.prompt_tokens),
    writer_completion_tokens: numeric(writerUsage.completion_tokens), screenshots_total: numeric(screenshots.screenshots_total),
    screenshots_extracted: numeric(screenshots.screenshots_extracted), screenshots_failed: numeric(screenshots.screenshots_failed),
  };
  if (result.audio_wait_expired === true) {
    // Ожидание истекло до сбора: нули означали бы подтверждённое отсутствие данных.
    for (const name of ['comm_total_events', 'comm_calls', 'comm_calls_with_audio', 'comm_comments',
      'comm_chat_messages', 'comm_tasks', 'comm_chats_count', 'trans_calls_transcribed', 'trans_calls_failed',
      'full_prompt_text', 'journal_text', 'comm_analytics', 'last_ai_probability', 'last_ai_misplaced',
      'last_ai_recovery_probability']) row[name] = null;
    for (const name of ['comm_total_at_run', 'calls_transcribed_at_run', 'full_prompt_text', 'journal_text',
      'prompt_chars', 'prompt_approx_tokens', 'ai_facts_json', 'ai_facts_count', 'screenshots_total',
      'screenshots_extracted', 'screenshots_failed', 'ai_probability', 'ai_misplaced', 'ai_recovery_probability',
      'ai_key_signals', 'ai_risk_factors', 'ai_manager_mistakes', 'ai_manager_script']) history[name] = null;
  }
  return { deal: row, analysis: history };
}

export function communicationRow(dealId, comm, index) {
  const eventType = comm.type || 'unknown';
  const eventId = comm.activity_id || comm.comment_id || comm.message_id || comm.task_id;
  if ((typeof eventId !== 'string' && typeof eventId !== 'number')
    || (typeof eventId === 'number' && (!Number.isSafeInteger(eventId) || eventId <= 0))
    || !/^[a-zA-Z0-9_:-]{1,50}$/.test(String(eventId))) {
    throw new TypeError('У коммуникации нет устойчивого идентификатора');
  }
  const start = Date.parse(comm.duration_start);
  const end = Date.parse(comm.duration_end);
  let duration = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : 0;
  if (eventType === 'call' && comm.date && comm.duration_start
    && Math.abs(Date.parse(comm.duration_start) - Date.parse(comm.date)) > 600000) duration = 0;
  const text = cleanHtml(comm.text || comm.description || '');
  const transcript = comm.transcript || '';
  // Модельная роль хранится в facts_packet как гипотеза; в плоской таблице
  // нет колонки её происхождения, поэтому не выдаём её за известного автора.
  const semanticTextRole = eventType === 'chat' && comm._role_source === 'semantic_inference'
    && comm._has_audio !== true && comm._has_files !== true && comm._has_audio_transcript !== true && !transcript;
  let transcriptStatus = transcript.length ? 'transcribed' : comm._transcription_empty ? 'empty_transcript' : comm._needs_transcription ? 'pending' : 'skipped';
  if (transcriptStatus === 'transcribed' && eventType === 'call' && isVoicemail(transcript)) transcriptStatus = 'voicemail';
  return {
    deal_id: dealId, event_type: eventType, event_id: String(eventId), event_date: emptyToNull(comm.date),
    direction: semanticTextRole ? 'unknown' : emptyToNull(comm.direction), author_id: emptyToNull(comm.author_id),
    author_name: semanticTextRole ? 'Участник чата' : emptyToNull(comm.author_name), responsible_id: emptyToNull(comm.responsible_id),
    text_content: text, full_content: eventType === 'call' && transcript ? transcript : text,
    call_subject: emptyToNull(comm.subject), call_duration_start: emptyToNull(comm.duration_start),
    call_duration_end: emptyToNull(comm.duration_end), call_duration_seconds: duration,
    call_provider: emptyToNull(comm.provider), call_audio_url: emptyToNull(comm.audio_url),
    call_has_audio: !!comm._needs_transcription, transcript_formatted: transcript,
    transcript_manager_text: comm.transcript_manager_text || '', transcript_client_text: comm.transcript_client_text || '',
    transcript_replicas: numeric(comm.transcript_replicas), transcript_status: transcriptStatus,
    transcript_engine: emptyToNull(comm.transcript_engine), chat_channel: emptyToNull(comm.channel),
    chat_connector_id: emptyToNull(comm.connector_id), chat_id: emptyToNull(comm.chat_id),
    chat_is_system: !!comm.is_system, task_title: emptyToNull(comm.title), task_status: emptyToNull(comm.status),
    task_closed_date: emptyToNull(comm.closed_date), task_created_by: emptyToNull(comm.created_by),
    comment_has_files: !!comm.has_files, screenshot_files: comm.screenshot_files ? json(comm.screenshot_files) : null,
    screenshot_turns: comm.screenshot_turns ? json(comm.screenshot_turns) : null, screenshot_text: emptyToNull(comm.screenshot_text),
    screenshot_extract_status: emptyToNull(comm.screenshot_extract_status),
  };
}
