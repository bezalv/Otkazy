// Только обнаружение возможных совпадений в БД; не подтверждает идентичность
// сообщений и не используется для записи результата или доставки.
const decimal = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  return /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
};

/** Ограниченное чтение кандидатов одной сделки и одного чата. */
export async function auditChatAliasCandidates({ pool, dealId, chatId, messageIds }) {
  const deal = decimal(dealId), chat = decimal(chatId);
  if (!deal || Number(deal) > 2147483647 || !chat || !Array.isArray(messageIds)
      || messageIds.length < 1 || messageIds.length > 50) throw new TypeError('Некорректные параметры аудита');
  const ids = messageIds.map(decimal);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new TypeError('Некорректные ID сообщений');
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Нужен пул PostgreSQL');
  const connection = await pool.connect();
  let began = false, discard = false;
  try {
    await connection.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    began = true;
    const response = await connection.query({
      text: `SELECT event_id FROM public.lost_deal_communications
        WHERE deal_id=$1 AND event_type='chat' AND chat_id=$2
          AND event_id ~ '^([1-9][0-9]*|chat_[1-9][0-9]*)_[1-9][0-9]*$'
          AND (left(event_id,5) <> 'chat_' OR split_part(event_id,'_',2)=chat_id)
          AND substring(event_id from '[0-9]+$') = ANY($3::text[])
        ORDER BY event_id LIMIT 201`,
      values: [Number(deal), chat, ids],
    });
    if (!Array.isArray(response.rows) || response.rows.length > 200) throw new Error('Слишком много совпадений для ограниченного аудита');
    const groups = new Map(ids.map(id => [id, []]));
    const seen = new Set();
    for (const row of response.rows) {
      const event = row?.event_id;
      const match = typeof event === 'string' && /^(?:([1-9]\d*)|chat_([1-9]\d*))_([1-9]\d*)$/.exec(event);
      if (!match || (match[2] && match[2] !== chat) || !groups.has(match[3]) || seen.has(event)) {
        throw new Error('Некорректный ответ аудита сообщений');
      }
      seen.add(event);
      groups.get(match[3]).push(event);
    }
    await connection.query('COMMIT');
    began = false;
    return ids.map(messageId => ({ messageId, candidateEventIds: groups.get(messageId),
      status: groups.get(messageId).length === 0 ? 'none'
        : groups.get(messageId).length === 1 ? 'one_unverified_candidate' : 'multiple_candidates' }));
  } catch (error) {
    if (began) {
      try { await connection.query('ROLLBACK'); } catch { discard = true; }
    }
    throw error;
  } finally { connection.release(discard ? new Error('Состояние соединения неизвестно') : undefined); }
}
