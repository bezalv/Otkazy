// Ручная проверка одной fallback-сессии Wazzup. Не доказывает полноту истории.
import { createHash } from 'node:crypto';
import { historiesMatch } from './session-completeness.mjs';
import { exactMillisTimestamp } from '../time-precision.mjs';

const numeric = value => {
  const s = String(value ?? '');
  return /^[1-9]\d{0,15}$/.test(s) && Number.isSafeInteger(Number(s)) ? s : null;
};
const instant = value => {
  const date = exactMillisTimestamp(value);
  return date ? date.getTime() : null;
};
function snapshot(history) {
  try {
    const value = JSON.stringify(history);
    if (typeof value !== 'string' || value.length > 5_000_000) return null;
    return createHash('sha256').update(value).digest('hex');
  } catch { return null; }
}
function line(history, chat) {
  const value = history?.chat?.[chat]?.entityId;
  if (typeof value !== 'string' || value.length > 1024) return null;
  const parts = value.split('|');
  if (parts.length !== 4 || parts.some(x => !x || x.trim() !== x)) return null;
  const config = numeric(parts[1]);
  return config ? { config, entity: value } : null;
}
function expectedChat(result, chat, purpose, entity) {
  if (!Array.isArray(result)) return false;
  const matches = result.filter(item => numeric(item?.CHAT_ID) === chat);
  if (matches.length !== 1) return false;
  const connector = typeof matches[0].CONNECTOR_ID === 'string' ? matches[0].CONNECTOR_ID.trim() : '';
  const title = typeof matches[0].CONNECTOR_TITLE === 'string' ? matches[0].CONNECTOR_TITLE.trim() : '';
  // Совпадающее имя семейства интеграции не доказывает, что это тот же
  // коннектор, который указан в снимке истории. Сверяем точный код перед
  // обоими режимами и на каждом повторном чтении чата.
  const parts = typeof entity === 'string' ? entity.split('|') : [];
  const matchingCode = connector && connector.toLowerCase() !== 'unknown' && parts.length === 4 && parts[0] === connector;
  if (!matchingCode) return false;
  const wazzup = (/^wz_/i.test(connector) || /wazzup/i.test(connector)) && !/wappi/i.test(title);
  if (purpose === 'role_inference') return wazzup;
  // Identity отдельно от авторства: название Wappi и код в полном entityId
  // подтверждают тип текущего чата, но не направление сообщений или историю.
  const wappi = /wappi/i.test(title) && connector !== 'telegrambot' && !/^wz_/i.test(connector) && !/wazzup/i.test(connector);
  // Встроенный Telegram-коннектор подтверждает только идентичность сессии,
  // но не авторство сообщений.
  const telegram = connector === 'telegrambot' && !/wappi|wazzup/i.test(title);
  return wazzup || wappi || telegram;
}
function stageMatches(deal, rows, dealId, stageId, transitionId, cutoff) {
  if (numeric(deal?.result?.ID) !== dealId || deal?.result?.STAGE_ID !== stageId) return false;
  if (!Array.isArray(rows) || !rows.length || numeric(rows[0]?.ID) !== transitionId
      || rows[0]?.STAGE_ID !== stageId || instant(rows[0]?.CREATED_TIME) !== cutoff) return false;
  const ids = new Set(); let previous = Infinity;
  for (const [index, row] of rows.entries()) {
    const id = numeric(row?.ID), time = instant(row?.CREATED_TIME);
    if (!id || ids.has(id) || typeof row?.STAGE_ID !== 'string' || !row.STAGE_ID
        || time === null || time > previous || (index === 1 && time === cutoff)) return false;
    ids.add(id); previous = time;
  }
  return true;
}

/**
 * lookupSession — доверенный внутренний адаптер, ограниченный вызывающим по
 * сделке/линии/сессии, времени и лимиту запросов. Он должен вернуть сырую
 * запись сессии: {kind:'single_session_lookup_v1', status:'found', session}.
 * Булево подтверждение или вызываемая пользователем произвольная функция не
 * являются независимым доказательством. Адаптер обязан отклонять дубли,
 * неполную выдачу и ошибки. Здесь отдельно проверяются поля сырой записи.
 *
 * Допуск применяется ТОЛЬКО вызывающим ручным silent-экспериментом. Ни
 * доказательства полноты истории, ни включения обработки здесь нет.
 */
export function createGeneralSessionVerifier({ client, lookupSession, dealId, transitionId,
  stageId = 'C23:LOSE', purpose = 'role_inference' } = {}) {
  const boundDeal = numeric(dealId), boundTransition = numeric(transitionId);
  if (!client || typeof client.request !== 'function' || typeof lookupSession !== 'function'
      || !boundDeal || !boundTransition || typeof stageId !== 'string' || !/^C\d+:LOSE$/.test(stageId)
      || !['role_inference','session_identity'].includes(purpose)) {
    throw new TypeError('Неполные ограничения проверки сессии');
  }
  // Клиент не передаётся lookupSession: ему доступна только фиксированная
  // структура искомой записи. Отдельный lookup реализует свои пределы.
  async function read(method, body) {
    if (method === 'crm.deal.get' && Object.keys(body).join(',') === 'id' && numeric(body.id) === boundDeal)
      return client.request(method, body);
    if (method === 'crm.stagehistory.list' && body.entityTypeId === 2 && numeric(body.filter?.OWNER_ID) === boundDeal
        && Object.keys(body).sort().join(',') === 'entityTypeId,filter,order,select,start'
        && Number.isSafeInteger(body.start) && body.start >= 0 && body.start < 1000
        && Object.keys(body.filter).join(',') === 'OWNER_ID' && Object.keys(body.order).join(',') === 'CREATED_TIME'
        && body.order.CREATED_TIME === 'DESC' && JSON.stringify(body.select) === '["ID","STAGE_ID","CREATED_TIME"]')
      return client.request(method, body);
    if (method === 'imopenlines.crm.chat.get' && Object.keys(body).sort().join(',') === 'ACTIVE_ONLY,CRM_ENTITY,CRM_ENTITY_TYPE'
        && body.CRM_ENTITY_TYPE === 'deal' && numeric(body.CRM_ENTITY) === boundDeal && body.ACTIVE_ONLY === 'N')
      return client.request(method, body);
    throw new Error('Метод или параметры запрещены');
  }
  async function history(body, expectedKey, id) {
    if (Object.keys(body).length !== 1 || Object.keys(body)[0] !== expectedKey || numeric(body[expectedKey]) !== id)
      throw new Error('Границы истории не подтверждены');
    return client.request('imopenlines.session.history.get', body);
  }
  const dealBody = { id: Number(boundDeal) };
  const stageBody = { entityTypeId: 2, filter: { OWNER_ID: Number(boundDeal) }, order: { CREATED_TIME: 'DESC' },
    select: ['ID', 'STAGE_ID', 'CREATED_TIME'] };
  const chatBody = { CRM_ENTITY_TYPE: 'deal', CRM_ENTITY: Number(boundDeal), ACTIVE_ONLY: 'N' };
  async function stageHistory() {
    const rows = []; let start = 0, totalSeen = null;
    // Ограничение в 20 страниц не выдаёт разрешение при превышении.
    for (let pageNo = 0; pageNo < 20; pageNo++) {
      const response = await read('crm.stagehistory.list', { ...stageBody, start });
      const page = Array.isArray(response?.result) ? response.result : response?.result?.items;
      if (!Array.isArray(page) || page.length > 50) return null;
      const hasNext = response?.next !== undefined && response.next !== null && response.next !== false;
      if (response?.total !== undefined && response.total !== null) {
        const total = Number(response.total);
        if (!Number.isSafeInteger(total) || total < 0 || start + page.length > total
            || (totalSeen !== null && totalSeen !== total)
            || (!hasNext && start + page.length !== total)
            || (hasNext && start + page.length >= total)) return null;
        totalSeen = total;
      } else if (page.length === 50 && !hasNext) return null;
      if (!hasNext && totalSeen !== null && start + page.length !== totalSeen) return null;
      if (hasNext && (!page.length || !Number.isSafeInteger(Number(response.next))
          || Number(response.next) !== start + page.length)) return null;
      rows.push(...page);
      if (!hasNext) return rows;
      start = Number(response.next);
    }
    return null;
  }
  return async input => {
    try {
      const deal = numeric(input?.deal_id), chat = numeric(input?.chat_id), session = numeric(input?.session_id);
      const config = numeric(input?.line_id), cutoff = instant(input?.cutoff), hash = snapshot(input?.history);
      const originalLine = chat && line(input?.history, chat);
      if (deal !== boundDeal || !chat || !session || !config || cutoff === null || !hash
          || input.history_sha256 !== hash || originalLine?.config !== config
          || numeric(input.history?.chatId) !== chat || numeric(input.history?.sessionId) !== session) return null;

      const currentDeal = await read('crm.deal.get', dealBody);
      const stages = await stageHistory();
      if (!stageMatches(currentDeal, stages, boundDeal, stageId, boundTransition, cutoff)) return null;
      const chatList = await read('imopenlines.crm.chat.get', chatBody);
      if (!expectedChat(chatList?.result, chat, purpose, originalLine.entity)) return null;
      const current = (await history({ CHAT_ID: Number(chat) }, 'CHAT_ID', chat))?.result;
      if (line(current, chat)?.entity !== originalLine.entity || !historiesMatch(input.history, current, chat, session)) return null;

      const found = await lookupSession(Object.freeze({ deal_id: deal, chat_id: chat, session_id: session,
        line_id: config, cutoff: new Date(cutoff).toISOString() }));
      if (!found || found.kind !== 'single_session_lookup_v1' || found.status !== 'found'
          || !found.session || typeof found.session !== 'object' || Array.isArray(found.session)) return null;
      const record = found.session, created = instant(record.dateCreate);
      if (numeric(record.id) !== session || numeric(record.chatId) !== chat || numeric(record.configId) !== config
          || typeof record.crmEntityType !== 'string' || record.crmEntityType.toLowerCase() !== 'deal'
          || numeric(record.crmEntityId) !== boundDeal || created === null || created > cutoff) return null;
      if (record.dateClose != null && record.dateClose !== '') {
        const closed = instant(record.dateClose);
        if (closed === null || closed < created) return null;
      }

      const direct = (await history({ SESSION_ID: Number(session) }, 'SESSION_ID', session))?.result;
      const last = (await history({ CHAT_ID: Number(chat) }, 'CHAT_ID', chat))?.result;
      if (line(direct, chat)?.entity !== originalLine.entity || line(last, chat)?.entity !== originalLine.entity
          || !historiesMatch(input.history, direct, chat, session) || !historiesMatch(input.history, last, chat, session)) return null;
      const finalChats = await read('imopenlines.crm.chat.get', chatBody);
      const finalDeal = await read('crm.deal.get', dealBody);
      const finalStages = await stageHistory();
      if (!expectedChat(finalChats?.result, chat, purpose, originalLine.entity) || !stageMatches(finalDeal, finalStages, boundDeal, stageId, boundTransition, cutoff)
          || snapshot(input.history) !== hash) return null;

      return { kind: 'verified_fallback_session_v1', deal_id: deal, chat_id: chat, session_id: session,
        line_id: config, cutoff: new Date(cutoff).toISOString(), history_sha256: hash,
        session_created_at: record.dateCreate,
        checks: { chat_bound_to_deal: true, session_matches_chat: true, session_matches_line: true,
          session_crm_matches_deal: true, direct_session_history_matches: true, current_chat_history_matches: true } };
    } catch { return null; }
  };
}
