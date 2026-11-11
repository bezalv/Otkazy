// Формат ответа соответствует ноде «final-output» от 19.10.2026.
export function buildFinalOutput(input, analytics, screenshotStats) {
  const judge = input.judge;
  // Сводка попадает в ai_judge_json вместе с фактами, чтобы неполное
  // распознавание не исчезало при штатном сохранении готового разбора.
  const coverageFields = ['calls_with_unrecognized_fragments', 'unrecognized_fragments',
    'calls_without_selected_fragments', 'calls_with_unknown_coverage'];
  const stats = input.transcription_stats;
  const coverage = stats && coverageFields.every(key => Number.isSafeInteger(stats[key]) && stats[key] >= 0)
    ? Object.fromEntries(coverageFields.map(key => [key, stats[key]])) : null;
  const probability = { высокий: 80, средний: 50, низкий: 20 }[judge.recoverable_level] || 0;
  const classification = {
    reason_class: judge.closure_reason_class || null,
    maturity: null,
    reactivation_probability: probability,
    reactivation_route: null,
    misplaced_stage: judge.misplaced || false,
    summary: judge.verdict_reason_short || '',
    exact_reason: judge.exact_reason || '',
    contact_level: null,
    urgency: null,
    manager_script: input.final_comment || '',
    key_signals: judge.key_signals || [],
    risk_factors: judge.risk_factors || [],
    correct_stage: judge.correct_stage || null,
  };
  const judgeUsage = input.judge_usage || {};
  const writerUsage = input.writer_usage || {};
  const llmMeta = {
    model: input.judge_model || 'openai/gpt-6-sol',
    prompt_tokens: (judgeUsage.prompt_tokens || 0) + (writerUsage.prompt_tokens || 0),
    completion_tokens: (judgeUsage.completion_tokens || 0) + (writerUsage.completion_tokens || 0),
    total_tokens: (judgeUsage.total_tokens || 0) + (writerUsage.total_tokens || 0),
    warnings: input.proof_warnings || [],
    writer_model: input.writer_model || null,
  };
  const multiAgentAnalysis = {
    verdict: judge.verdict,
    verdict_reason_short: judge.verdict_reason_short,
    recoverable_level: judge.recoverable_level,
    closure_reason_class: judge.closure_reason_class,
    misplaced: judge.misplaced,
    correct_stage: judge.correct_stage,
    exact_reason: judge.exact_reason,
    manager_mistakes: judge.manager_mistakes,
    key_signals: judge.key_signals,
    risk_factors: judge.risk_factors,
    questions_for_manager: judge.questions_for_manager,
    final_comment: input.final_comment,
    judge_model: input.judge_model,
    judge_usage: input.judge_usage,
    writer_model: input.writer_model,
    writer_usage: input.writer_usage,
    proof_warnings: input.proof_warnings,
    proof_errors_count: input.proof_errors_count,
    data_sufficiency: judge.data_sufficiency || input._data_sufficiency || null,
    facts_packet: input.facts_packet,
    ...(coverage ? { transcription_coverage: coverage } : {}),
  };
  return {
    classification,
    llm_meta: llmMeta,
    multi_agent_analysis: multiAgentAnalysis,
    communications: input.communications || [],
    screenshot_stats: screenshotStats || null,
    transcription_stats: input.transcription_stats || {},
    journal_text: input.journal_text || '',
    full_prompt_text: analytics.full_prompt_text || '',
    journal_stats: analytics.journal_stats || {},
    comm_analytics: analytics.comm_analytics || null,
    analytics_text: input.analytics_text || '',
    deal_card: input.deal_card || {},
    _block: 'multi_agent_complete',
    _ready_for: 'supabase',
  };
}
