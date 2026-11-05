import { NIGHTLY_MAX_DEALS, nightlyIsFresh } from '../rules/nightly-retry.mjs';

/**
 * Готовит задания из уже полученного lost_pipeline_attention. Сам не пишет в БД.
 * Текущую дату получаем из истории Битрикса: карточка могла остаться от
 * предыдущего отказа. При отсутствующей дате в карточке сохраняем прежний
 * тихий режим; при устаревшей дате свежесть определяется текущим переходом.
 */
export async function planRetries({ rows, mode, runKey, nowMs = Date.now(), resolveCurrentLoss }) {
  if (!Array.isArray(rows) || !['nightly', 'manual'].includes(mode)) throw new TypeError('Некорректные параметры повтора');
  if (typeof runKey !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(runKey)) throw new TypeError('Не задан ключ запуска');
  if (!Number.isFinite(nowMs) || typeof resolveCurrentLoss !== 'function') throw new TypeError('Не заданы зависимости повтора');
  const chosen = mode === 'nightly' ? rows.filter(row => row?.retry_eligible === true).slice(0, NIGHTLY_MAX_DEALS) : rows;
  const actions = [], deferred = [], seen = new Set();
  for (const row of chosen) {
    const dealId = Number(row?.deal_id);
    if (!Number.isSafeInteger(dealId) || dealId <= 0 || seen.has(dealId)) continue;
    seen.add(dealId);
    let loseDate;
    try { loseDate = await resolveCurrentLoss(dealId); } catch { loseDate = null; }
    if (!loseDate || !Number.isFinite(new Date(loseDate).getTime())) {
      deferred.push({ dealId, reason: 'lose_date_unavailable' });
      continue;
    }
    const originalDateKnown = !!row.lose_date && Number.isFinite(new Date(row.lose_date).getTime());
    const silent = mode === 'nightly' ? (!originalDateKnown || !nightlyIsFresh(loseDate, nowMs)) : false;
    actions.push({
      requestKey: `${mode}:${runKey}:${dealId}`, dealId, loseDate: new Date(loseDate).toISOString(),
      triggerType: mode, silent, screenshots: true,
    });
  }
  return { actions, deferred };
}
