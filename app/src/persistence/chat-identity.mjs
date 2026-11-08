// Прототип сопоставления идентификаторов одного сообщения, не подключён к БД.
// Функции сами не подтверждают источник proof и не гарантируют атомарность:
// вызывающий обязан получить proof от доверенного проверяющего и выполнять
// поиск/выбор/запись в одной сериализованной транзакции.
import { createHash } from 'node:crypto';
import { exactMillisTimestamp } from '../time-precision.mjs';

const id = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  return /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
};
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const proofKeys = ['kind','deal_id','chat_id','session_id','line_id','cutoff','history_sha256','session_created_at','checks'];
const checkKeys = ['chat_bound_to_deal','session_matches_chat','session_matches_line','session_crm_matches_deal',
  'direct_session_history_matches','current_chat_history_matches'];
const ambiguous = reason => ({ status:'ambiguous', reason });

/**
 * Генерирует только точные legacy ID числового сообщения. Обязательны
 * структурированный proof доверенного проверяющего и тот же снимок истории,
 * а также отдельное подтверждение уникальности messageId во всём чате. Одна
 * текущая сессия не подтверждает это свойство остальных сессий. Достоверность
 * обоих proof обеспечивает вызывающий код, не эта функция.
 * Отдельные вложения вида file_<id> намеренно не сопоставляются.
 */
export function chatEventCandidates({ dealId, chatId, sessionId, messageId, currentEventId, sessionProof, messageIdentityProof, history } = {}) {
  const deal=id(dealId), chat=id(chatId), session=id(sessionId), message=id(messageId);
  if (!deal || !chat || !session || !message) return ambiguous('invalid_identity');
  const explicit=`${session}_${message}`, fallback=`chat_${chat}_${message}`;
  if (explicit.length > 50 || fallback.length > 50 || ![explicit,fallback].includes(currentEventId)) {
    return ambiguous('invalid_event_id');
  }
  if (!exact(sessionProof,proofKeys) || sessionProof.kind !== 'verified_fallback_session_v1'
      || id(sessionProof.deal_id)!==deal || id(sessionProof.chat_id)!==chat || id(sessionProof.session_id)!==session
      || !id(sessionProof.line_id) || !/^[a-f0-9]{64}$/.test(sessionProof.history_sha256 || '')
      || !exact(sessionProof.checks,checkKeys) || !checkKeys.every(key => sessionProof.checks[key]===true)) {
    return ambiguous('unverified_session');
  }
  const identityKeys=['kind','deal_id','chat_id','session_id','message_id','history_sha256','unique_in_chat'];
  if (!exact(messageIdentityProof,identityKeys) || messageIdentityProof.kind!=='verified_chat_message_identity_v1'
      || id(messageIdentityProof.deal_id)!==deal || id(messageIdentityProof.chat_id)!==chat
      || id(messageIdentityProof.session_id)!==session || id(messageIdentityProof.message_id)!==message
      || messageIdentityProof.history_sha256!==sessionProof.history_sha256 || messageIdentityProof.unique_in_chat!==true) {
    return ambiguous('unverified_message_identity');
  }
  const cutoff=exactMillisTimestamp(sessionProof.cutoff), created=exactMillisTimestamp(sessionProof.session_created_at);
  if (!cutoff || !created || created.getTime()>cutoff.getTime()) return ambiguous('unverified_session');
  if (!history || typeof history!=='object' || Array.isArray(history)
      || id(history.chatId)!==chat || id(history.sessionId)!==session
      || !history.message || typeof history.message!=='object') return ambiguous('unverified_history');
  const entity=history.chat?.[chat]?.entityId, parts=typeof entity==='string' ? entity.split('|') : [];
  if (parts.length!==4 || parts.some(part=>!part || part.trim()!==part) || id(parts[1])!==id(sessionProof.line_id)) {
    return ambiguous('unverified_history');
  }
  let serialized;
  try { serialized=JSON.stringify(history); } catch { return ambiguous('unverified_history'); }
  if (typeof serialized!=='string' || serialized.length>5_000_000
      || createHash('sha256').update(serialized).digest('hex')!==sessionProof.history_sha256) return ambiguous('unverified_history');
  const entries=Object.entries(history.message);
  if (entries.length>5000) return ambiguous('unverified_history');
  let hits=0;
  for (const [key, entry] of entries) {
    if (!entry || typeof entry!=='object' || Array.isArray(entry)) return ambiguous('unverified_history');
    const sourceId=entry.id ?? entry.ID ?? (Array.isArray(history.message) ? null : key);
    const valid=id(sourceId);
    if (!valid) return ambiguous('unverified_history');
    if (valid===message) hits++;
  }
  if (hits!==1) return ambiguous(hits>1?'duplicate_message':'message_not_found');
  return {status:'eligible', dealId:deal, chatId:chat, sessionId:session,
    messageId:message, currentEventId, candidates:[explicit,fallback]};
}

/**
 * rows — исчерпывающий набор строк, полученный точным запросом с блокировкой.
 * Возвращает только существующий event_id, не меняет строку и не делает UPSERT.
 */
export function selectExistingChatEvent(input, rows) {
  const identity=chatEventCandidates(input);
  if (identity.status!=='eligible') return identity;
  if (!Array.isArray(rows) || rows.length>2) return ambiguous('invalid_rows');
  const seen=new Set();
  for (const row of rows) {
    if (!row || typeof row!=='object' || Array.isArray(row)
        || id(row.deal_id)!==identity.dealId || row.event_type!=='chat' || id(row.chat_id)!==identity.chatId
        || typeof row.event_id!=='string' || !identity.candidates.includes(row.event_id)) return ambiguous('row_mismatch');
    if (seen.has(row.event_id)) return ambiguous('duplicate_rows');
    seen.add(row.event_id);
  }
  if (seen.size>1) return ambiguous('both_aliases_exist');
  if (seen.size===0) return {status:'new', eventId:identity.currentEventId};
  return {status:'existing', eventId:[...seen][0]};
}
