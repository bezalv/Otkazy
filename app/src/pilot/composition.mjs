// Отчёт допускает только эти имена. Неизвестные значения не возвращаются наружу.
export const PILOT_VERDICTS = Object.freeze(['правомерен', 'неправомерен', 'недостаточно_данных', 'other', 'unavailable']);
export const PILOT_REASON_CLASSES = Object.freeze(['price', 'competitor', 'no_need', 'no_money', 'timing', 'manager_dropped', 'customer_unreachable', 'regulatory', 'other', 'unavailable']);
export const PILOT_SOURCES = Object.freeze(['call_event', 'call_transcript', 'chat', 'chat_voice_transcript', 'crm_comment', 'screenshot_chat', 'crm_task', 'other']);
export const PILOT_ACTORS = Object.freeze(['client', 'manager', 'system', 'unknown', 'other']);
const MAX_FACTS_PER_RESULT = 100000;
const zeroes = names => Object.fromEntries(names.map(name => [name, 0]));

function safeEnum(value, names) {
  if (value == null) return 'unavailable';
  return typeof value === 'string' && names.includes(value) ? value : 'other';
}
function bucket(value, names) {
  return typeof value === 'string' && names.includes(value) ? value : 'other';
}
function factSummary(facts) {
  if (!Array.isArray(facts) || facts.length > MAX_FACTS_PER_RESULT) return null;
  const result = { total: facts.length, by_source: zeroes(PILOT_SOURCES), by_actor: zeroes(PILOT_ACTORS) };
  for (const fact of facts) {
    result.by_source[bucket(fact?.source, PILOT_SOURCES)]++;
    result.by_actor[bucket(fact?.actor, PILOT_ACTORS)]++;
  }
  return result;
}

/** Возвращает только enum и численные распределения, без содержимого фактов. */
export function describeComposition(result, baseline) {
  const current = result?.analysis?.multi_agent_analysis;
  return {
    previous_verdict: safeEnum(baseline?.ai_verdict, PILOT_VERDICTS),
    current_verdict: safeEnum(current?.verdict, PILOT_VERDICTS),
    previous_reason_class: safeEnum(baseline?.ai_reason_class, PILOT_REASON_CLASSES),
    current_reason_class: safeEnum(current?.closure_reason_class, PILOT_REASON_CLASSES),
    previous_facts: factSummary(baseline?.ai_facts_json?.facts),
    current_facts: factSummary(current?.facts_packet?.facts),
  };
}

function emptySide() { return { available: 0, total: 0, by_source: zeroes(PILOT_SOURCES), by_actor: zeroes(PILOT_ACTORS) }; }
export function emptyComposition() {
  return {
    verdicts: { previous: zeroes(PILOT_VERDICTS), current: zeroes(PILOT_VERDICTS) },
    reason_classes: { previous: zeroes(PILOT_REASON_CLASSES), current: zeroes(PILOT_REASON_CLASSES) },
    facts: { previous: emptySide(), current: emptySide() },
  };
}

function addFacts(side, facts) {
  if (!facts || !Number.isSafeInteger(facts.total) || facts.total < 0 || facts.total > MAX_FACTS_PER_RESULT) return;
  for (const [field, names] of [['by_source', PILOT_SOURCES], ['by_actor', PILOT_ACTORS]]) {
    if (!facts[field] || names.some(name => !Number.isSafeInteger(facts[field][name]) || facts[field][name] < 0)
        || names.reduce((sum, name) => sum + facts[field][name], 0) !== facts.total) return;
  }
  side.available++;
  side.total += facts.total;
  for (const name of PILOT_SOURCES) side.by_source[name] += facts.by_source[name];
  for (const name of PILOT_ACTORS) side.by_actor[name] += facts.by_actor[name];
}

/** Даже некорректные внедрённые адаптеры не могут добавить произвольные поля. */
export function addComposition(output, detail) {
  const d = detail || {};
  output.verdicts.previous[safeEnum(d.previous_verdict, PILOT_VERDICTS)]++;
  output.verdicts.current[safeEnum(d.current_verdict, PILOT_VERDICTS)]++;
  output.reason_classes.previous[safeEnum(d.previous_reason_class, PILOT_REASON_CLASSES)]++;
  output.reason_classes.current[safeEnum(d.current_reason_class, PILOT_REASON_CLASSES)]++;
  addFacts(output.facts.previous, d.previous_facts);
  addFacts(output.facts.current, d.current_facts);
}
