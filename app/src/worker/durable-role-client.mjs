// Отдельный opt-in протокол. Не создаёт ledger, не открывает соединение и не
// подключён к рабочей очереди. Очередь должна передать проверенный scope.
import { verifiedInferenceGroupForVerifier, verifiedInferenceVoice } from '../collect/normalize.mjs';
import { chatMillisTimestamp } from '../time-precision.mjs';
import { isCanonicalRoleInferenceRequest, isValidRoleInferenceResponse } from '../analysis/chat-role-inference.mjs';
import { getRoleSessionContextScope } from './role-session-context.mjs';
import { getRoleInferenceLedgerScope } from './role-inference-ledger.mjs';

const instant = value => chatMillisTimestamp(value)?.getTime() ?? null;
const validDeal = value => /^[1-9]\d{0,15}$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value));
const hasAttachment = item => item._has_audio === true || item._has_files === true || item._has_audio_transcript === true
  || item.transcript != null || item.attachments != null || item.files != null || item.file_id != null;

export function createDurableRoleClient({ ledger, sessionContext, transport, checkLease } = {}) {
  const ledgerScope = getRoleInferenceLedgerScope(ledger), sessionScope = getRoleSessionContextScope(sessionContext);
  const cutoffMs = instant(sessionScope?.cutoff);
  if (!ledger || typeof ledger.reserve !== 'function' || typeof ledger.preSend !== 'function' || typeof ledger.finish !== 'function'
      || !transport || typeof transport.complete !== 'function' || typeof transport.failClosed !== 'function'
      || !sessionScope || !ledgerScope || !validDeal(sessionScope.dealId) || cutoffMs === null
      || ledgerScope.dealId !== sessionScope.dealId || ledgerScope.stageHistoryId !== sessionScope.stageHistoryId
      || ledgerScope.cutoff !== sessionScope.cutoff || typeof sessionContext.verify !== 'function'
      || typeof checkLease !== 'function') {
    throw new TypeError('Не заданы зависимости защиты запросов');
  }
  const scope = { dealId:sessionScope.dealId, cutoff:new Date(cutoffMs).toISOString() };
  let closed = false, busy = false, pending = null, validation = null;

  function entriesForVerifiedGroup(body, group) {
    if (!Array.isArray(group) || !group.length || !verifiedInferenceGroupForVerifier(group, scope, sessionContext.verify)
        || !body || !Array.isArray(body.messages) || body.messages.length !== 2
        || body.messages[1]?.role !== 'user' || typeof body.messages[1]?.content !== 'string') return null;
    const dated = group.map((item, index) => ({item,index,time:instant(item?.date)}));
    if (dated.some(({item,time}) => time === null || typeof item?.text !== 'string' || !item.text.trim()
        || item._chat_connector_unknown === true || item._session_unreferenced_files === true
        || item._session_context_ambiguous === true
        || (hasAttachment(item) && !verifiedInferenceVoice(item, scope)))) return null;
    const eligible = dated.filter(({time}) => time <= cutoffMs).sort((a,b) => a.time - b.time || a.index - b.index);
    if (!eligible.length || eligible.length > 100 || eligible.some((x,i) => i && x.time === eligible[i-1].time)) return null;
    const ids = new Set(), entries=[];let chars=0;
    for(const [i,{item}] of eligible.entries()) {
      const id=String(item.message_id ?? ''), role=item.role==='Клиент'||item.role==='client'?'client'
        :item.role==='Менеджер'||item.role==='manager'?'manager':null;
      const direction=item.direction==='incoming'?'client':item.direction==='outgoing'?'manager':null;
      if(item.type!=='chat' || !/^[A-Za-z0-9_-]{1,120}$/.test(id) || ids.has(id)
          || (role && direction && role !== direction) || item.text.length>5000) return null;
      ids.add(id);chars+=item.text.length;entries.push({localId:`m${String(i+1).padStart(3,'0')}`,text:item.text,observed:role||direction});
    }
    return chars <= 60_000 && isCanonicalRoleInferenceRequest(body,entries) ? entries : null;
  }

  async function markUnknown() {
    if (pending === null) return;
    const attempt = pending; pending = null;
    // Потеря lease/ошибка записи не освобождает резерв в базе.
    try { await ledger.finish(attempt, 'unknown'); } catch { /* резерв остаётся неопределённым */ }
  }
  function closeTransport() { try { transport.failClosed(); } catch { /* дальнейшие POST запрещены адаптером */ } }
  return Object.freeze({
    // Этот ограниченный клиент допускается только к независимо проверенной
    // сессии. Анализатор проверяет in-memory proof до и после запроса.
    requireVerifiedSession:true,
    async complete(body, options = {}) {
      if (options?.role !== 'chat-role-inference' || closed || busy || pending !== null) {
        throw new Error('Вызов определения авторов запрещён');
      }
      busy = true;
      try {
        const request = structuredClone(body), group = Array.isArray(options.verifiedGroup) ? options.verifiedGroup.slice() : null;
        if (!entriesForVerifiedGroup(request, group)) throw new Error('Сессия не подтверждена');
        // Потерянное подтверждение COMMIT не даёт разрешения на POST.
        const reservation = await ledger.reserve();
        if (reservation?.status !== 'reserved' || !Number.isSafeInteger(reservation.attempt_no)
            || reservation.attempt_no < 1 || reservation.attempt_no > 3) throw new Error('Резерв не подтверждён');
        pending = reservation.attempt_no;
        if (closed) throw new Error('Транспорт закрыт');
        const fence = await ledger.preSend(pending);
        if (fence?.status !== 'allowed' || closed) throw new Error('Право на отправку не подтверждено');
        // Внутренний worker возвращает undefined при успехе и бросает при
        // потере аренды. Альтернативный callback может вернуть только true.
        const lease = await checkLease();
        if (lease !== undefined && lease !== true) throw new Error('Аренда не подтверждена');
        if (closed || !entriesForVerifiedGroup(request, group)) throw new Error('Контекст или аренда изменились');
        const result = await transport.complete(request, {role:'chat-role-inference'});
        if (closed) throw new Error('Транспорт закрыт');
        validation = {request,group,response:structuredClone(result)};
        // Пока бизнес-валидация не закончена, резерв остаётся открытым.
        return result;
      } catch {
        closed = true; closeTransport(); await markUnknown();
        throw new Error('Результат определения авторов не подтверждён');
      } finally { busy = false; }
    },
    async confirmValidated() {
      if (closed || busy || pending === null) throw new Error('Нет проверенного ответа');
      busy = true;
      try {
        const entries = validation && entriesForVerifiedGroup(validation.request,validation.group);
        if (!entries || !isValidRoleInferenceResponse(validation.response,entries)) throw new Error('Ответ не прошёл проверку');
        // settled обозначает полученный и проверенный на исходном снимке ответ,
        // но не доказывает применение роли, неизменность контекста после этого
        // момента или известную сумму списания.
        const result = await ledger.finish(pending, 'settled');
        if (result?.status !== 'settled') throw new Error('Запись не подтверждена');
        pending = null;
        if (closed || !entriesForVerifiedGroup(validation.request,validation.group)) throw new Error('Контекст изменился');
        validation = null;
      } catch {
        closed = true; closeTransport(); await markUnknown();
        throw new Error('Подтверждение ответа не сохранено');
      } finally { busy = false; }
    },
    async failClosed() {
      closed = true; closeTransport();
      // При параллельной операции её собственный catch/finally зафиксирует
      // неизвестный результат или сохранит резерв для последующей сверки.
      if (!busy) await markUnknown();
    },
    snapshot() {
      return Object.freeze({ closed, in_flight:busy, pending_confirmation:pending !== null,
        ...(typeof transport.snapshot === 'function' ? { transport:transport.snapshot() } : {}) });
    },
  });
}
