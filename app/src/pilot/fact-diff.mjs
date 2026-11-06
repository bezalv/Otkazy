import { exactMillisTimestamp } from '../time-precision.mjs';

const CALL_SOURCES = new Set(['call_event', 'call_transcript']);
const DIRECTIONS = new Set(['incoming', 'outgoing']);
const ACTORS = new Set(['manager', 'client', 'unknown']);
const MODES = ['event', 'mono_unknown', 'stereo', 'ambiguous'];
const EVENT_REASONS = ['no_recording', 'unrecognized', 'no_conversation', 'other'];
const LEXICAL = ['same_normalized', 'high_overlap', 'medium_overlap', 'low_overlap', 'unavailable'];
const PROOF_SOURCES = ['call_event', 'call_transcript', 'chat', 'chat_voice_transcript', 'crm_comment', 'crm_task', 'screenshot_chat', 'metric', 'other'];
const PROOF_ACTORS = ['manager', 'client', 'system', 'unknown', 'other'];
const MAX_ITEMS = 100000;
const zeroes = values => Object.fromEntries(values.map(value => [value, 0]));

function normalizedKey(value, direction) {
  const date = exactMillisTimestamp(value);
  if (!date || typeof direction !== 'string' || !DIRECTIONS.has(direction.toLowerCase())) return null;
  return `${date.toISOString()}|${direction.toLowerCase()}`;
}

function validId(value) {
  return (typeof value === 'string' || typeof value === 'number') && /^[1-9]\d{0,29}$/.test(String(value))
    && (typeof value !== 'number' || Number.isSafeInteger(value)) ? String(value) : null;
}

function collectFacts(facts) {
  if (!Array.isArray(facts) || facts.length > MAX_ITEMS) throw new TypeError('Некорректный пакет фактов');
  const groups = new Map();
  let invalid = 0;
  for (const item of facts) {
    if (!item || typeof item !== 'object' || !CALL_SOURCES.has(item.source)) continue;
    const key = normalizedKey(item.ts, item.direction);
    if (!key) { invalid++; continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return { groups, invalid };
}

function collectActivities(comms) {
  if (!Array.isArray(comms) || comms.length > MAX_ITEMS) throw new TypeError('Некорректные коммуникации');
  const groups = new Map();
  let invalid = 0;
  for (const item of comms) {
    if (!item || typeof item !== 'object' || item.type !== 'call') continue;
    const key = normalizedKey(item.date, item.direction), id = validId(item.activity_id);
    if (!key || !id) { invalid++; continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  }
  return { groups, invalid };
}

function mode(facts) {
  const events = facts.filter(item => item.source === 'call_event');
  const transcripts = facts.filter(item => item.source === 'call_transcript');
  if (events.length === 1 && transcripts.length === 0 && facts.length === 1) return 'event';
  if (events.length || !transcripts.length || transcripts.length !== facts.length) return 'ambiguous';
  const actors = transcripts.map(item => item.actor);
  if (actors.some(actor => !ACTORS.has(actor)) || new Set(actors).size !== actors.length) return 'ambiguous';
  if (actors.length === 1 && actors[0] === 'unknown') return 'mono_unknown';
  if (actors.length <= 2 && actors.every(actor => actor === 'manager' || actor === 'client')) return 'stereo';
  return 'ambiguous';
}

function reason(fact) {
  const value = typeof fact?.content === 'string' ? fact.content.toLowerCase() : '';
  if (value.includes('запись есть, но не распознана')) return 'unrecognized';
  if (value.includes('записи нет') || /запис[^.]{0,60}отсутств/.test(value)) return 'no_recording';
  if (value.includes('разговор не состоялся') || value.includes('сработал автоответчик')
      || value.includes('сработал робот') || value.includes('сработал автоответчик оператора')) return 'no_conversation';
  return 'other';
}

function transcriptText(facts) {
  const prefix = 'Запись без разделения сторон (одна звуковая дорожка, кто именно говорит — неизвестно): ';
  const pieces = [];
  for (const item of facts) {
    if (item.source !== 'call_transcript' || typeof item.content !== 'string' || item.content.length > 500000) return null;
    const content = item.content.startsWith(prefix) ? item.content.slice(prefix.length) : item.content;
    pieces.push(content.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim());
  }
  return pieces.length && pieces.every(Boolean) ? pieces.join(' ') : null;
}

function lexical(previous, current) {
  const left = transcriptText(previous), right = transcriptText(current);
  if (!left || !right) return 'unavailable';
  if (left === right) return 'same_normalized';
  const tokenize = value => new Set(value.match(/[\p{L}\p{N}]+/gu) || []);
  const a = tokenize(left), b = tokenize(right);
  if (!a.size || !b.size) return 'unavailable';
  let overlap = 0;
  for (const word of a) if (b.has(word)) overlap++;
  const ratio = overlap / (a.size + b.size - overlap);
  return ratio >= 0.8 ? 'high_overlap' : ratio >= 0.4 ? 'medium_overlap' : 'low_overlap';
}

/**
 * Никакие факты, даты, идентификаторы и тексты не возвращаются. Даже при
 * единственном текущем activity совпадение старого времени и направления —
 * лишь кандидат, если старый пакет не сохранил точный activity_id.
 */
export function compareCallFacts({ previousFacts, currentFacts, currentCommunications }) {
  const previous = collectFacts(previousFacts), current = collectFacts(currentFacts);
  const activities = collectActivities(currentCommunications);
  const transitions = {};
  for (const from of MODES) for (const to of MODES) transitions[`${from}_to_${to}`] = 0;
  const result = {
    old_groups: previous.groups.size, new_groups: current.groups.size,
    invalid_old_facts: previous.invalid, invalid_new_facts: current.invalid, invalid_current_activities: activities.invalid,
    old_only_groups: 0, new_only_groups: 0, candidate_groups: 0, id_verified_groups: 0,
    ambiguous_groups: 0, id_mismatch_groups: 0, transitions,
    old_event_to_transcript_reasons: zeroes(EVENT_REASONS), lexical_overlap: zeroes(LEXICAL),
    limitations: ['time_direction_match_is_not_identity', 'historical_facts_may_lack_activity_id',
      'activity_id_does_not_prove_identical_audio_bytes', 'lexical_overlap_is_not_semantic_equivalence'],
  };
  for (const key of previous.groups.keys()) if (!current.groups.has(key)) result.old_only_groups++;
  for (const key of current.groups.keys()) if (!previous.groups.has(key)) result.new_only_groups++;
  for (const [key, oldFacts] of previous.groups) {
    const newFacts = current.groups.get(key);
    if (!newFacts) continue;
    const oldMode = mode(oldFacts), newMode = mode(newFacts);
    const newIds = activities.groups.get(key) || [];
    if (oldMode === 'ambiguous' || newMode === 'ambiguous' || newIds.length !== 1) { result.ambiguous_groups++; continue; }
    const oldIdValues = oldFacts.map(item => validId(item.activity_id));
    const oldIds = new Set(oldIdValues.filter(Boolean));
    if (oldIds.size > 1) { result.ambiguous_groups++; continue; }
    if (oldIds.size === 1 && !oldIds.has(newIds[0])) { result.id_mismatch_groups++; continue; }
    // Даже один старый факт без валидного ID не позволяет объявить всю
    // группу подтверждённой: он мог относиться к другому звонку в ту же секунду.
    if (oldIds.size === 1 && oldIdValues.every(Boolean)) result.id_verified_groups++;
    else result.candidate_groups++;
    result.transitions[`${oldMode}_to_${newMode}`]++;
    if (oldMode === 'event' && (newMode === 'stereo' || newMode === 'mono_unknown')) {
      result.old_event_to_transcript_reasons[reason(oldFacts[0])]++;
    }
    if (oldMode !== 'event' && newMode !== 'event') result.lexical_overlap[lexical(oldFacts, newFacts)]++;
  }
  return result;
}

/** Только категории доказательств: не возвращает ID, тексты или ответы модели. */
export function summarizeJudgeEvidence(judge, facts, metrics = null) {
  if (!judge || typeof judge !== 'object' || Array.isArray(judge) || !Array.isArray(facts)
      || facts.length > MAX_ITEMS) return { available: false };
  const groups = ['manager_mistakes', 'key_signals', 'risk_factors'];
  if (groups.some(name => !Array.isArray(judge[name]) || judge[name].length > MAX_ITEMS)) return { available: false };
  const byId = new Map();
  for (const fact of facts) {
    if (!fact || typeof fact !== 'object' || typeof fact.fact_id !== 'string' || !fact.fact_id || byId.has(fact.fact_id)) return { available: false };
    byId.set(fact.fact_id, fact);
  }
  const sections = {};
  for (const name of groups) {
    const counts = { items: judge[name].length, references: 0, missing: 0, unverified: 0,
      by_source: zeroes(PROOF_SOURCES), by_actor: zeroes(PROOF_ACTORS) };
    for (const item of judge[name]) {
      if (!item || typeof item !== 'object' || !Array.isArray(item.proof_fact_ids) || item.proof_fact_ids.length > MAX_ITEMS) return { available: false };
      for (const id of item.proof_fact_ids) {
        if (typeof id !== 'string' || !id || id.length > 256) return { available: false };
        counts.references++;
        if (id.startsWith('metric:')) {
          const metric = id.slice(7);
          if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) { counts.unverified++; continue; }
          if (!Object.hasOwn(metrics, metric) || metrics[metric] === undefined) { counts.missing++; continue; }
          counts.by_source.metric++; counts.by_actor.system++; continue;
        }
        const fact = byId.get(id);
        if (!fact) { counts.missing++; continue; }
        counts.by_source[PROOF_SOURCES.includes(fact.source) ? fact.source : 'other']++;
        counts.by_actor[PROOF_ACTORS.includes(fact.actor) ? fact.actor : 'other']++;
      }
    }
    sections[name] = counts;
  }
  return { available: true, sections };
}

/** Поиск слов в коротких основаниях — метки упоминаний, не интерпретация доказательств. */
export function categorizeReasons(judge) {
  if (!judge || typeof judge !== 'object' || Array.isArray(judge)) return { available: false };
  const parts = [judge.verdict_reason_short, judge.exact_reason].filter(value => typeof value === 'string');
  if (!parts.length || parts.some(value => value.length > 50000)) return { available: false };
  const text = parts.join(' ').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
  return { available: true,
    mentions_price: /цен|дорог|стоимост|бюджет/.test(text),
    mentions_competitor: /конкурент|друг(?:ой|ая|ую|им) компани|уже купил/.test(text),
    mentions_no_client_statement: /нет (?:слов|реплик|сообщени[яй]|ответа) клиента|клиент не (?:ответил|говорил|сказал)|без (?:реплик|слов|ответа) клиента/.test(text),
    mentions_missing_recording: /записи нет|нет записи|запис[^.]{0,60}отсутств|без записи|не распознан/.test(text),
    mentions_insufficient_data: /недостаточно|мало данных|данных нет|не хватает данных/.test(text),
    limitations: ['keyword_flags_are_not_proof_or_explanation'] };
}
