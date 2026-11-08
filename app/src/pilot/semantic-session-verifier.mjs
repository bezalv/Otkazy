// Проверка только для ручного текстового опыта одной сделки.
import { inspectSession, restrictedReader, historiesMatch } from './session-completeness.mjs';

const DEAL = '127114';
const numeric = value => /^[1-9]\d{0,15}$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) ? String(value) : null;
function line(history, chat) {
  const entity = history?.chat?.[chat]?.entityId;
  if (typeof entity !== 'string' || entity.length > 1024) return null;
  const parts = entity.split('|');
  return parts.length === 4 && parts.every(x => x && x.trim() === x) && numeric(parts[1])
    ? { config:numeric(parts[1]), entity } : null;
}

// Callback вызывается только после сбора и получает снимок той же истории.
// Проверка одной сессии не доказывает полноту всей истории сделки.
export function createSemanticSessionVerifier(client, { inspect = inspectSession } = {}) {
  return async input => {
    try {
      const chat = numeric(input?.chat_id), session = numeric(input?.session_id), config = numeric(input?.line_id);
      if (numeric(input?.deal_id) !== DEAL || !chat || !session || !config
          || typeof input.cutoff !== 'string' || !/^[a-f0-9]{64}$/.test(input.history_sha256 || '')
          || numeric(input.history?.chatId) !== chat || numeric(input.history?.sessionId) !== session
          || line(input.history, chat)?.config !== config) return null;
      let verified = null;
      const found = await inspect({ client, loseDate: input.cutoff, onVerified: value => { verified = value; } });
      if (found?.status !== 'verified' || found.stage !== 'session_link_verified'
          || found.deal_counts?.only_known_target_session !== true
          || numeric(verified?.session_id) !== session || numeric(verified?.chat_id) !== chat
          || numeric(verified?.line_id) !== config || typeof verified?.session_created_at !== 'string') return null;
      // После сканирования повторно связываем именно переданный нормализатором
      // снимок с текущим чатом и прямой историей конкретной сессии.
      const reader = restrictedReader(client, input.cutoff);
      const chats = (await reader.request('imopenlines.crm.chat.get', { CRM_ENTITY_TYPE:'deal', CRM_ENTITY:Number(DEAL), ACTIVE_ONLY:'N' }))?.result;
      if (!Array.isArray(chats) || chats.length !== 1 || numeric(chats[0]?.CHAT_ID) !== chat
          || !(/^wz_/i.test(String(chats[0]?.CONNECTOR_ID || '')) || /wazzup/i.test(String(chats[0]?.CONNECTOR_ID || '')))) return null;
      const current = (await reader.request('imopenlines.session.history.get', { CHAT_ID:Number(chat) }))?.result;
      const direct = (await reader.request('imopenlines.session.history.get', { SESSION_ID:Number(session) }))?.result;
      if (line(current, chat)?.entity !== line(input.history, chat)?.entity
          || line(direct, chat)?.entity !== line(input.history, chat)?.entity
          || !historiesMatch(input.history, current, chat, session)
          || !historiesMatch(input.history, direct, chat, session)) return null;
      return { kind:'verified_fallback_session_v1', deal_id:DEAL, chat_id:chat, session_id:session,
        line_id:config, cutoff:input.cutoff, history_sha256:input.history_sha256,
        session_created_at:verified.session_created_at,
        checks:{chat_bound_to_deal:true, session_matches_chat:true, session_matches_line:true,
          session_crm_matches_deal:true, direct_session_history_matches:true, current_chat_history_matches:true} };
    } catch { return null; }
  };
}
