// Закрытый адаптер read-only проверки одной сессии. Создание контекста не
// запускает обработку и не делает запросов; подключение к worker намеренно
// остаётся отдельным этапом до подтверждения всех гарантий транспорта/учёта.
import { createGeneralSessionVerifier } from '../pilot/general-session-verifier.mjs';
import { createSessionLookup } from '../pilot/general-session-lookup.mjs';
import { exactMillisTimestamp } from '../time-precision.mjs';

const WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const contextScopes = new WeakMap();
export function getRoleSessionContextScope(context) { return contextScopes.get(context) || null; }
const numeric = value => {
  const s = String(value ?? '');
  return /^[1-9]\d{0,15}$/.test(s) && Number.isSafeInteger(Number(s)) ? s : null;
};
const instant = value => exactMillisTimestamp(value)?.getTime() ?? null;

/**
 * Контекст привязан к одному переходу и отрезку времени. Проверка возвращает
 * доказательство конкретной текущей сессии либо null; полнота всей истории и
 * правильность семантического определения авторов этим не доказываются.
 */
export function createRoleSessionContext({ client, dealId, transitionId, cutoff, from,
  maxPages = 20, maxReads = 600, signal } = {}) {
  const deal = numeric(dealId), transition = numeric(transitionId);
  const startMs = instant(from), cutoffMs = instant(cutoff);
  if (!client || typeof client.request !== 'function' || !deal || !transition
      || startMs === null || cutoffMs === null || startMs > cutoffMs || cutoffMs - startMs > WINDOW_MS
      || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20
      || !Number.isSafeInteger(maxReads) || maxReads < 1 || maxReads > 600
      || (signal != null && typeof signal.throwIfAborted !== 'function')) {
    throw new TypeError('Неполные ограничения проверки сессии');
  }
  const start = new Date(startMs).toISOString(), end = new Date(cutoffMs).toISOString();
  const chats = new Set(), sessions = new Set(), lines = new Set();
  let reads = 0, active = false, budgetExhausted = false;

  // Допускаются только методы, используемые verifier и lookup. Чаты и линии
  // открываются лишь по ответам текущего привязанного запроса к Битриксу.
  const reader = Object.freeze({ async request(method, body = {}, options = {}) {
    signal?.throwIfAborted();
    const keys = Object.keys(body).sort().join(',');
    let allowed = false;
    if (method === 'crm.deal.get') allowed = keys === 'id' && numeric(body.id) === deal;
    else if (method === 'crm.stagehistory.list') {
      allowed = keys === 'entityTypeId,filter,order,select,start' && body.entityTypeId === 2
        && Object.keys(body.filter || {}).join(',') === 'OWNER_ID' && numeric(body.filter.OWNER_ID) === deal
        && Object.keys(body.order || {}).join(',') === 'CREATED_TIME' && body.order.CREATED_TIME === 'DESC'
        && JSON.stringify(body.select) === '["ID","STAGE_ID","CREATED_TIME"]'
        && Number.isSafeInteger(body.start) && body.start >= 0 && body.start < 1000;
    } else if (method === 'imopenlines.crm.chat.get') {
      allowed = keys === 'ACTIVE_ONLY,CRM_ENTITY,CRM_ENTITY_TYPE' && body.CRM_ENTITY_TYPE === 'deal'
        && numeric(body.CRM_ENTITY) === deal && body.ACTIVE_ONLY === 'N';
    } else if (method === 'imopenlines.session.history.get') {
      const chat = numeric(body.CHAT_ID), session = numeric(body.SESSION_ID);
      allowed = (keys === 'CHAT_ID' && !!chat && chats.has(chat))
        || (keys === 'SESSION_ID' && !!session && sessions.has(session));
    } else if (method === 'imopenlines.v2.Session.list') {
      const line = numeric(body.configId);
      allowed = keys === 'configId,dateCreateFrom,dateCreateTo,limit,offset,order,orderDirection'
        && !!line && lines.has(line) && body.dateCreateFrom === start && body.dateCreateTo === end
        && body.limit === 200 && Number.isSafeInteger(body.offset) && body.offset >= 0
        && body.offset % 200 === 0 && body.offset < maxPages * 200
        && body.order === 'dateCreate' && body.orderDirection === 'desc';
    }
    if (!allowed) throw new Error('Метод чтения вне границ сессии запрещён');
    if (reads >= maxReads) { budgetExhausted = true; throw new Error('Превышен предел чтения'); }
    reads++;
    const combined = signal && options.signal ? AbortSignal.any([signal, options.signal]) : signal || options.signal;
    const response = await client.request(method, body, combined ? { signal: combined } : {});
    signal?.throwIfAborted();
    if (method === 'imopenlines.crm.chat.get' && Array.isArray(response?.result)) {
      for (const item of response.result) { const id = numeric(item?.CHAT_ID); if (id) chats.add(id); }
    }
    if (method === 'imopenlines.session.history.get') {
      const h = response?.result, requestedChat = numeric(body.CHAT_ID);
      const chat = numeric(h?.chatId), session = numeric(h?.sessionId);
      if (requestedChat && requestedChat === chat && session) sessions.add(session);
      if (chat && chats.has(chat) && session && sessions.has(session)) {
        const entity = h?.chat?.[chat]?.entityId, parts = typeof entity === 'string' ? entity.split('|') : [];
        if (parts.length === 4 && parts.every(x => x && x.trim() === x)) {
          const line = numeric(parts[1]); if (line) lines.add(line);
        }
      }
    }
    return response;
  }});
  const lookup = createSessionLookup({ client: reader, from: start, maxPages, signal });
  const verifier = createGeneralSessionVerifier({ client: reader, lookupSession: lookup,
    dealId: deal, transitionId: transition, purpose: 'session_identity' });
  const context = Object.freeze({
    async verify(input) {
      // Границы задаёт только доверенный вызывающий код, а не снимок истории.
      if (active || signal?.aborted || numeric(input?.deal_id) !== deal || instant(input?.cutoff) !== cutoffMs) return null;
      active = true;
      try {
        // Пока идут сетевые чтения, вызывающий не может подменить идентификаторы
        // или историю, для которой выдано возвращаемое доказательство.
        const snapshot = structuredClone(input);
        return await verifier(snapshot);
      } catch { return null; } finally { active = false; }
    },
    stats() { return Object.freeze({ reads, budget_exhausted: budgetExhausted }); },
  });
  contextScopes.set(context, Object.freeze({dealId:deal,stageHistoryId:transition,cutoff:end}));
  return context;
}
