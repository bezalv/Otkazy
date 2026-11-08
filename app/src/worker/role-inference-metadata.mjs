// Только преобразование в ограниченную метаинформацию; запись, восстановление
// и подтверждение расходов выполняются отдельно. Исходный текст не сохраняем.
const MODELS = new Set(['openai/gpt-6-sol', 'gpt-6-sol', 'openai/gpt-6.1-sol', 'gpt-6.1-sol']);
const ROLES = new Set(['client', 'manager', 'unknown']);
const SOURCES = new Set(['observed', 'semantic_inference', 'unknown']);
const IMPACTS = new Set(['not_applicable', 'material_or_unclear', 'not_material']);
const COUNTS = ['candidate_sessions', 'resolved', 'unresolved', 'skipped_sessions', 'failed_sessions',
  'excluded_after_cutoff', 'budget_exhausted_sessions', 'nonmaterial_unknown'];
const USAGE = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
const count = (value, max = 1_000_000) => Number.isSafeInteger(value) && value >= 0 && value <= max;

/** Никаких сообщений, ошибок провайдера, внешних ID, дат или денежных оценок. */
export function sanitizeRoleInferenceMetadata(stats, transport, evidence) {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)
      || !transport || typeof transport !== 'object' || Array.isArray(transport)
      || !count(stats.model_calls, 3) || !COUNTS.every(key => count(stats[key]))
      || !count(transport.physical_requests_started, 3) || !count(transport.responses_received, 3)
      || transport.responses_received > transport.physical_requests_started
      || typeof transport.in_flight !== 'boolean' || typeof transport.uncertain_outcome !== 'boolean') return null;
  const provenCalls = stats.model_calls > 0 && stats.model_calls === transport.physical_requests_started
    && transport.physical_requests_started === transport.responses_received
    && !transport.in_flight && !transport.uncertain_outcome;
  const complete = stats.usage_complete === true && provenCalls
    && stats.usage && typeof stats.usage === 'object' && !Array.isArray(stats.usage)
    && USAGE.every(key => count(stats.usage[key], 1_000_000_000));
  const usage = complete ? Object.fromEntries(USAGE.map(key => [key, stats.usage[key]])) : null;
  const inputModels = Array.isArray(stats.actual_models) ? stats.actual_models : [];
  const models = [...new Set(inputModels.filter(model => typeof model === 'string' && MODELS.has(model)))];
  let safeEvidence = [], evidenceValid = Array.isArray(evidence) && evidence.length <= 3
    && evidence.length <= stats.model_calls && evidence.length <= transport.responses_received;
  if (evidenceValid) for (const [i, session] of evidence.entries()) {
    if (!session || typeof session !== 'object' || Array.isArray(session) || session.session !== `session_${i + 1}`
        || !Array.isArray(session.messages) || session.messages.length > 100) { evidenceValid = false; break; }
    const messages = [];
    for (const [j, item] of session.messages.entries()) {
      const local = `m${String(j + 1).padStart(3, '0')}`;
      if (!item || typeof item !== 'object' || Array.isArray(item) || item.id !== local
          || !ROLES.has(item.predicted_role) || !ROLES.has(item.effective_role)
          || !SOURCES.has(item.source) || !IMPACTS.has(item.impact)
          || typeof item.nonmaterial_unknown !== 'boolean') { evidenceValid = false; break; }
      messages.push({ id:local, predicted_role:item.predicted_role, effective_role:item.effective_role,
        source:item.source, impact:item.impact, nonmaterial_unknown:item.nonmaterial_unknown });
    }
    if (!evidenceValid) break;
    safeEvidence.push({session:`session_${i + 1}`,messages});
  }
  if (!evidenceValid) safeEvidence = [];
  const evidenceComplete = evidenceValid && provenCalls && stats.failed_sessions === 0
    && evidence.length === stats.model_calls;
  return {
    ...Object.fromEntries(COUNTS.map(key => [key, stats[key]])),
    model_calls:stats.model_calls,
    physical_requests_started:transport.physical_requests_started,
    responses_received:transport.responses_received,
    uncertain_outcome:transport.uncertain_outcome || transport.in_flight
      || transport.physical_requests_started !== transport.responses_received,
    usage_complete:!!complete, usage, cost_rub:null,
    models, models_complete:provenCalls && models.length > 0
      && inputModels.length === models.length && count(stats.model_unavailable_calls)
      && stats.model_unavailable_calls === 0,
    // Полнота относится только к сделанным вызовам, а не к числу найденных
    // сессий: часть могла быть пропущена ещё до обращения к модели.
    evidence_for_model_calls_complete:evidenceComplete, evidence:safeEvidence,
  };
}
