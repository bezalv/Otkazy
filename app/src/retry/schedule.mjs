import { planRetries } from './plan.mjs';

// Для сделок без карточки читаем дату из истории, не меняя правило silent.
export async function currentLossDate(client, dealId) {
  const deal = await client.request('crm.deal.get', { id: dealId });
  if (deal?.result?.STAGE_ID !== 'C23:LOSE') return null;
  let start = 0;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    if (seen.has(start)) throw new Error('Повтор страницы истории');
    seen.add(start);
    const response = await client.request('crm.stagehistory.list', {
      entityTypeId: 2, filter: { OWNER_ID: dealId }, order: { CREATED_TIME: 'DESC' },
      select: ['ID', 'STAGE_ID', 'CREATED_TIME'], start,
    });
    const items = Array.isArray(response?.result) ? response.result : response?.result?.items;
    if (!Array.isArray(items)) throw new Error('Неполная история стадий');
    if (page === 0 && (!items.length || items[0]?.STAGE_ID !== 'C23:LOSE')) {
      throw new Error('История стадий ещё не подтверждает текущий отказ');
    }
    const event = items.find(item => item?.STAGE_ID === 'C23:LOSE');
    if (event) {
      const value = event.CREATED_TIME;
      return value && Number.isFinite(new Date(value).getTime()) ? value : null;
    }
    if (response.next == null) return null;
    const next = Number(response.next);
    if (!Number.isSafeInteger(next) || next <= start || !items.length) throw new Error('Некорректная пагинация истории');
    start = next;
  }
  throw new Error('Превышен лимит страниц истории');
}

/** Только читает список зависших и подготавливает план, не создавая заданий. */
export async function prepareRetryPlan({ pool, bitrix, mode, runKey, nowMs = Date.now() }) {
  if (!pool || typeof pool.query !== 'function'
      || !bitrix || typeof bitrix.request !== 'function' || !['nightly', 'manual'].includes(mode)) {
    throw new TypeError('Не заданы зависимости повтора');
  }
  // Не повышаем нагрузку на Битрикс: по-прежнему проверяем максимум 20 сделок.
  // Учитываем и отложенные, и выбранные в прошлых сохранённых планах: при
  // недоступной истории или зависшем задании старейшие 20 не блокируют остальных.
  const sql = mode === 'nightly'
    ? `WITH last_selected AS (
        SELECT (item->>'dealId')::bigint AS deal_id, max(r.run_date) AS last_selected_on
        FROM public.lost_nightly_retry_runs r
        CROSS JOIN LATERAL jsonb_array_elements(r.actions || r.deferred) AS item
        WHERE r.run_date < $1::date AND item->>'dealId' ~ '^[1-9][0-9]{0,15}$'
        GROUP BY (item->>'dealId')::bigint
      ), candidates AS (
        SELECT DISTINCT ON (a.deal_id) a.deal_id, a.lose_date, a.retry_eligible, a.last_attempt_at
        FROM public.lost_pipeline_attention a
        WHERE a.retry_eligible=true
          AND NOT EXISTS (
            SELECT 1 FROM public.lost_nightly_retry_runs pending
            CROSS JOIN LATERAL jsonb_array_elements(pending.actions) AS item
            WHERE pending.status='planned' AND pending.run_date < $1::date
              AND item->>'dealId' = a.deal_id::text
              AND NOT EXISTS (
                SELECT 1 FROM public.lost_processing_jobs placed
                WHERE placed.request_key=item->>'requestKey'
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.lost_processing_jobs j
            WHERE j.deal_id=a.deal_id AND j.status IN ('pending','processing','needs_review')
          )
        ORDER BY a.deal_id, a.last_attempt_at ASC
      )
      SELECT c.deal_id, c.lose_date, c.retry_eligible FROM candidates c
      LEFT JOIN last_selected s ON s.deal_id=c.deal_id
      ORDER BY s.last_selected_on ASC NULLS FIRST, c.last_attempt_at ASC, c.deal_id ASC LIMIT 20`
    : 'SELECT deal_id, lose_date, retry_eligible FROM public.lost_pipeline_attention ORDER BY last_attempt_at ASC, deal_id ASC';
  if (mode === 'nightly') {
    const parsed = typeof runKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(runKey)
      ? Date.parse(`${runKey}T00:00:00.000Z`) : NaN;
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== runKey) {
      throw new TypeError('Некорректная дата ночного повтора');
    }
  }
  const response = await pool.query(sql, mode === 'nightly' ? [runKey] : []);
  return planRetries({ rows: response.rows, mode, runKey, nowMs, resolveCurrentLoss: id => currentLossDate(bitrix, id) });
}

/** Выборка и безопасная постановка повторов; метод не запускает обработчик. */
export async function scheduleRetries({ pool, queue, bitrix, mode, runKey, nowMs = Date.now() }) {
  if (mode !== 'manual') throw new TypeError('Ночной повтор запускается только через сохранённый план');
  if (!queue || typeof queue.enqueue !== 'function') throw new TypeError('Не задана очередь');
  const plan = await prepareRetryPlan({ pool, bitrix, mode, runKey, nowMs });
  const enqueued = [], failed = [];
  for (const action of plan.actions) {
    try { enqueued.push(await queue.enqueue(action)); }
    catch { failed.push({ dealId: action.dealId, reason: 'enqueue_failed' }); }
  }
  return { enqueued, deferred: plan.deferred, failed };
}
