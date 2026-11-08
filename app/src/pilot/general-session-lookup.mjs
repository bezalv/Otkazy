// Ограниченный ручной поиск одной текущей записи сессии открытой линии.
// Полная выборка одной линии и окна не доказывает полноту истории сделки.
import { exactMillisTimestamp } from '../time-precision.mjs';

const PAGE_SIZE = 200;
const MAX_PAGES = 20;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

function id(value) {
  const text = String(value ?? '');
  return /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
}

function time(value) {
  return exactMillisTimestamp(value)?.getTime() ?? null;
}

const failure = reason => ({ status: 'unverified', reason });

/**
 * Ищет текущую запись конкретной сессии, не выдавая данных посторонних сессий.
 * Вызывающий отдельно проверяет текущую сделку, исходную привязку чата и
 * идентичность истории; переданный идентификатор линии сам по себе не доказан.
 * Даже исчерпанная пагинация не доказывает полноту исторических переписок:
 * окно и линия ограничены, права могут скрывать строки, offset может смещаться.
 * Вводимые значения должны быть получены доверенным внутренним вызывающим.
 */
export async function lookupSession({ client, dealId, chatId, sessionId, lineId, cutoff, from, maxPages = MAX_PAGES, signal } = {}) {
  const deal = id(dealId), chat = id(chatId), session = id(sessionId), line = id(lineId);
  const startTime = time(from), endTime = time(cutoff);
  if (!client || typeof client.request !== 'function' || !deal || !chat || !session || !line
      || startTime === null || endTime === null || startTime > endTime || endTime - startTime > MAX_WINDOW_MS
      || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES
      || (signal != null && typeof signal.throwIfAborted !== 'function')) return failure('invalid_input');

  const start = new Date(startTime).toISOString(), end = new Date(endTime).toISOString();
  const seen = new Set(); let found = null, previousTime = null;
  try {
    for (let page = 0; page < maxPages; page++) {
      signal?.throwIfAborted();
      const response = await client.request('imopenlines.v2.Session.list', {
        configId: Number(line), dateCreateFrom: start, dateCreateTo: end,
        limit: PAGE_SIZE, offset: page * PAGE_SIZE, order: 'dateCreate', orderDirection: 'desc',
      }, signal ? { signal } : undefined);
      signal?.throwIfAborted();
      const rows = response?.result?.sessions, hasNext = response?.result?.hasNextPage;
      if (!Array.isArray(rows) || rows.length > PAGE_SIZE || typeof hasNext !== 'boolean'
          || (hasNext && rows.length !== PAGE_SIZE)) return failure('invalid_page');
      for (const [index, row] of rows.entries()) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return failure('invalid_row');
        const rowId = id(row.id), rowLine = id(row.configId), created = time(row.dateCreate);
        if (!rowId || !rowLine || rowLine !== line || created === null || created < startTime || created > endTime
            || (previousTime !== null && created > previousTime)) return failure('invalid_row');
        if (seen.has(rowId)) return failure('duplicate_session');
        // Для совпадающей даты порядок между страницами не гарантирован API.
        // Мы не можем доказать, что смещение не пропустило соседнюю запись.
        if (page > 0 && index === 0 && created === previousTime) return failure('unstable_page_boundary');
        seen.add(rowId); previousTime = created;
        if (rowId !== session) continue;
        const rowChat = id(row.chatId), rowCrmId = id(row.crmEntityId);
        const entity = typeof row.crmEntityType === 'string' ? row.crmEntityType : '';
        const closed = row.dateClose == null || row.dateClose === '' ? null : time(row.dateClose);
        if (rowChat !== chat || rowCrmId !== deal || entity.toLowerCase() !== 'deal'
            || (row.dateClose != null && row.dateClose !== '' && (closed === null || closed < created))) {
          return failure('target_mismatch');
        }
        found = { kind: 'single_session_lookup_v1', status: 'found', session: {
          id: rowId, chatId: rowChat, configId: rowLine, crmEntityType: entity,
          crmEntityId: rowCrmId, dateCreate: row.dateCreate, dateClose: row.dateClose ?? null,
        } };
      }
      if (!hasNext) return found || failure('not_found');
    }
    return failure('pagination_incomplete');
  } catch {
    return failure(signal?.aborted ? 'cancelled' : 'request_unavailable');
  }
}

/** Ограничения источника задаёт только доверенный код ручного пилота. */
export function createSessionLookup({ client, from, maxPages = MAX_PAGES, signal } = {}) {
  return input => lookupSession({ client, from, maxPages, signal, dealId: input?.deal_id,
    chatId: input?.chat_id, sessionId: input?.session_id, lineId: input?.line_id, cutoff: input?.cutoff });
}
