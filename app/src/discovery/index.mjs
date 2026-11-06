import { exactMillisTimestamp } from '../time-precision.mjs';

const HISTORY_METHOD = 'crm.stagehistory.list';
const HISTORY_FIELDS = ['ID', 'OWNER_ID', 'STAGE_ID', 'CREATED_TIME', 'CATEGORY_ID'];
const HANDLED = new Set(['processed', 'skipped_by_reason']);
const KNOWN = new Set([...HANDLED, 'waiting_audio', 'pipeline_error', 'not_found', 'unknown']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function timestamp(value, field) {
  const date = exactMillisTimestamp(value);
  if (!date) throw new Error(`Некорректная дата ${field}`);
  return date.getTime();
}

function id(value, field, requireSafe = false) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d{1,30}$/.test(String(value))) {
    throw new Error(`Некорректный ${field}`);
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`Некорректный ${field}`);
  const parsed = BigInt(value);
  if (parsed <= 0n || (requireSafe && parsed > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error(`Некорректный ${field}`);
  }
  return parsed.toString();
}

function offset(value, field) {
  if ((typeof value !== 'number' && typeof value !== 'string')
      || !/^\d+$/.test(String(value))) throw new Error(`Некорректный ${field}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Некорректный ${field}`);
  return number;
}

function historyItem(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.STAGE_ID !== 'string' || !row.STAGE_ID) {
    throw new Error('Некорректная запись истории стадий');
  }
  const historyId = id(row.ID, 'ID истории');
  const dealId = id(row.OWNER_ID, 'ID сделки', true);
  const when = timestamp(row.CREATED_TIME, 'перехода');
  return { historyId, dealId: Number(dealId), stageId: row.STAGE_ID, when, createdAt: row.CREATED_TIME };
}

function classify(event, outcome) {
  if (!outcome || typeof outcome !== 'object' || !KNOWN.has(outcome.status)) return 'unverified';
  if (outcome.status === 'unknown') return 'unverified';
  if (outcome.status === 'not_found') return outcome.complete === true ? 'unprocessed' : 'unverified';
  const evidence = outcome.evidence || {};
  const eventMatch = evidence.event_key === event.event_key;
  let dateMatch = false;
  if (evidence.deal_id != null && evidence.lose_date != null) {
    try {
      dateMatch = id(evidence.deal_id, 'ID сделки', true) === String(event.deal_id)
        && timestamp(evidence.lose_date, 'отказа') === timestamp(event.occurred_at, 'отказа');
    } catch { dateMatch = false; }
  }
  if (!eventMatch && !dateMatch) return 'unverified';
  if (HANDLED.has(outcome.status)) return 'already_handled';
  if (outcome.status === 'waiting_audio') return 'already_waiting';
  return 'retry_needed';
}

async function requestPage(client, start, wait, pageDelayMs) {
  let error;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt === 1 && start > 0 && pageDelayMs) await wait(pageDelayMs);
    try {
      const response = await client.request(HISTORY_METHOD, {
        entityTypeId: 2, order: { ID: 'ASC' }, filter: {}, select: HISTORY_FIELDS, start,
      });
      if (response?.error) {
        const failure = new Error('Битрикс вернул ошибку истории стадий');
        failure.retryable = ['QUERY_LIMIT_EXCEEDED', 'INTERNAL_SERVER_ERROR'].includes(String(response.error));
        throw failure;
      }
      return response;
    } catch (caught) {
      error = caught;
      if (caught?.retryable !== true || attempt === 3) break;
      await wait(attempt * 2000);
    }
  }
  const safe = new Error('Не удалось получить страницу истории стадий');
  safe.retryable = error?.retryable === true;
  throw safe;
}

/** Читает ограниченную часть истории и сравнивает переходы с подтверждёнными исходами. */
export async function discoverTransitions({
  client, compareOutcomes, from, to, cursor = null, maxPages = 10,
  pageDelayMs = 1000, wait = delay,
}) {
  if (!client || typeof client.request !== 'function') throw new TypeError('Не задан клиент Битрикса');
  if (typeof compareOutcomes !== 'function') throw new TypeError('Не задана сверка исходов');
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new TypeError('Некорректный лимит страниц');
  if (!Number.isSafeInteger(pageDelayMs) || pageDelayMs < 0) throw new TypeError('Некорректная задержка');
  if (typeof wait !== 'function') throw new TypeError('Не задана функция задержки');
  const fromMs = timestamp(from, 'начала');
  const toMs = timestamp(to, 'окончания');
  if (toMs <= fromMs) throw new Error('Пустое или обратное окно');
  const window = { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
  let start = 0;
  let lastId = null;
  if (cursor !== null) {
    if (!cursor || typeof cursor !== 'object' || cursor.from !== window.from || cursor.to !== window.to) {
      throw new Error('Курсор относится к другому окну');
    }
    start = offset(cursor.start, 'курсор');
    if (!start) throw new Error('Некорректный курсор продолжения');
    lastId = id(cursor.last_id, 'ID предыдущей страницы');
  }
  const events = [];
  let pagesRead = 0;
  let nextCursor = null;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const response = await requestPage(client, start, wait, pageDelayMs);
    const rows = Array.isArray(response?.result) ? response.result : response?.result?.items;
    if (!response || typeof response !== 'object' || !Array.isArray(rows)) {
      throw new Error('Некорректная страница истории стадий');
    }
    if (rows.length > 50) throw new Error('Неожиданный размер страницы истории стадий');
    for (const row of rows) {
      const item = historyItem(row);
      if (lastId !== null && BigInt(item.historyId) <= BigInt(lastId)) {
        throw new Error('Порядок истории стадий нарушен или содержит повтор');
      }
      lastId = item.historyId;
      if (item.stageId === 'C23:LOSE' && item.when >= fromMs && item.when < toMs) {
        events.push({
          event_key: `bitrix24:deal-stage-history:${item.historyId}`,
          history_id: item.historyId,
          deal_id: item.dealId,
          stage_id: item.stageId,
          occurred_at: new Date(item.when).toISOString(),
        });
      }
    }
    pagesRead++;
    const hasNext = response.next !== undefined && response.next !== null;
    let total = null;
    if (response.total !== undefined && response.total !== null) total = offset(response.total, 'total');
    if (total !== null && start + rows.length > total) throw new Error('Размер истории стадий изменился');
    if (!hasNext) {
      if (total !== null && start + rows.length < total) throw new Error('Следующая страница истории отсутствует');
      if (total === null && rows.length === 50) throw new Error('Полнота последней страницы не подтверждена');
      nextCursor = null;
      break;
    }
    const next = offset(response.next, 'next');
    if (!rows.length || next !== start + rows.length) throw new Error('Некорректный переход между страницами');
    if (total !== null && next >= total) throw new Error('Пагинация противоречит total');
    nextCursor = { ...window, start: next, last_id: lastId };
    start = next;
  }

  let outcomes = [];
  if (events.length) {
    try { outcomes = await compareOutcomes(events.map(event => ({ ...event }))); }
    catch { throw new Error('Не удалось сверить сохранённые исходы'); }
    if (!Array.isArray(outcomes) || outcomes.length !== events.length) throw new Error('Сверка исходов неполная');
  }
  const byKey = new Map();
  for (const outcome of outcomes) {
    if (!outcome || typeof outcome.event_key !== 'string' || byKey.has(outcome.event_key)) {
      throw new Error('Некорректный результат сверки исходов');
    }
    byKey.set(outcome.event_key, outcome);
  }
  if (events.some(event => !byKey.has(event.event_key))) throw new Error('Не все переходы сверены');
  const decisions = events.map(event => ({ ...event, disposition: classify(event, byKey.get(event.event_key)) }));
  return {
    window, events: decisions, pages_read: pagesRead, next_cursor: nextCursor,
    scan_complete: nextCursor === null,
    coverage_guaranteed: false,
    coverage_note: 'Документация не гарантирует снимок при изменении истории между страницами',
  };
}
