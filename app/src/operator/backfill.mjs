import { readCurrentTransition } from '../live/index.mjs';
import { exactMillisTimestamp } from '../time-precision.mjs';

const KEY_PREFIX = 'bitrix24:deal-stage-history:';
const LIMIT = 50;
const VALID_DISPOSITIONS = new Set(['already_handled', 'already_waiting', 'retry_needed', 'unprocessed', 'unverified']);

function historyId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,29}$/.test(value)) throw new Error('Некорректный идентификатор перехода');
  return value;
}
function eventDate(value) {
  const date = exactMillisTimestamp(value);
  if (!date) throw new Error('Некорректная дата перехода');
  return date.toISOString();
}
function reportIndex(report) {
  if (!report || !Array.isArray(report.events) || report.events.length > 5000
      || typeof report.scan_complete !== 'boolean' || report.coverage_guaranteed !== false
      || !Number.isSafeInteger(report.pages_read) || report.pages_read < 0) throw new Error('Некорректный отчёт поиска');
  const index = new Map();
  for (const row of report.events) {
    const id = historyId(row?.history_id);
    if (index.has(id) || row.event_key !== KEY_PREFIX + id || row.stage_id !== 'C23:LOSE'
        || !Number.isSafeInteger(row.deal_id) || row.deal_id < 1 || row.deal_id > 2147483647
        || !VALID_DISPOSITIONS.has(row.disposition)) throw new Error('Некорректный отчёт поиска');
    index.set(id, { history_id: id, event_key: row.event_key, deal_id: row.deal_id,
      occurred_at: eventDate(row.occurred_at), disposition: row.disposition });
  }
  return index;
}

/** Список только технических ID для явного выбора; клиента и детали сделки не выводим. */
export function listUnprocessedHistoryIds(report) {
  return [...reportIndex(report).values()].filter(row => row.disposition === 'unprocessed').map(row => row.history_id);
}

/**
 * Сверка явно выбранных ID. Это НЕ постановка задач: результаты источников не
 * атомарны, а отчёт не привязан к порталу и не доказывает полноту истории.
 * Функция намеренно не принимает очередь или другие зависимости записи.
 */
export async function reviewSelectedBackfill({ report, selectedHistoryIds, client, compareOutcomes }) {
  const index = reportIndex(report);
  if (!Array.isArray(selectedHistoryIds) || !selectedHistoryIds.length || selectedHistoryIds.length > LIMIT
      || !client || typeof client.request !== 'function' || typeof compareOutcomes !== 'function') {
    throw new Error('Некорректные параметры сверки');
  }
  const seen = new Set(), deals = new Set(), selected = [];
  for (const value of selectedHistoryIds) {
    const id = historyId(value);
    const event = index.get(id);
    if (seen.has(id) || !event || event.disposition !== 'unprocessed' || deals.has(event.deal_id)) {
      throw new Error('Выбор содержит недопустимый или повторный переход');
    }
    seen.add(id);
    deals.add(event.deal_id);
    selected.push(event);
  }
  let outcomes;
  try { outcomes = await compareOutcomes(selected.map(({ event_key, deal_id, occurred_at }) => ({ event_key, deal_id, occurred_at }))); }
  catch { throw new Error('Не удалось повторно сверить исходы'); }
  if (!Array.isArray(outcomes) || outcomes.length !== selected.length) throw new Error('Неполная сверка исходов');
  const byKey = new Map();
  for (const outcome of outcomes) {
    if (!outcome || typeof outcome.event_key !== 'string' || byKey.has(outcome.event_key)
        || !selected.some(event => event.event_key === outcome.event_key)) throw new Error('Некорректная сверка исходов');
    byKey.set(outcome.event_key, outcome);
  }
  const events = [];
  for (const event of selected) {
    const outcome = byKey.get(event.event_key);
    if (!outcome || outcome.status !== 'not_found' || outcome.complete !== true) {
      events.push({ history_id: event.history_id, status: 'outcome_requires_review' });
      continue;
    }
    let current;
    try { current = await readCurrentTransition(client, event.deal_id); }
    catch { events.push({ history_id: event.history_id, status: 'current_transition_unknown' }); continue; }
    if (!current || current.historyId !== event.history_id || current.loseDate !== event.occurred_at) {
      events.push({ history_id: event.history_id, status: 'current_transition_changed' });
      continue;
    }
    // readCurrentTransition использует первую строку CREATED_TIME DESC;
    // при одинаковом времени порядок Битриксом не подтверждён.
    events.push({ history_id: event.history_id, status: 'first_history_row_matches' });
  }
  return { events, scan_complete: report.scan_complete, coverage_guaranteed: false,
    portal_binding_verified: false, can_enqueue: false,
    blocked_by: ['source_portal_not_bound', 'history_timestamp_ties_not_resolved', 'non_atomic_outcome_check', 'external_consumers_not_fenced'] };
}
