import { NIGHTLY_MAX_DEALS } from '../rules/nightly-retry.mjs';

// В Новосибирске UTC+7, без перехода на летнее время. До 04:00 новый план не создаём.
export function nightlyDayIfDue(nowMs) {
  if (!Number.isFinite(nowMs)) throw new TypeError('Некорректное время');
  const local = new Date(nowMs + 7 * 3600000);
  if (!Number.isFinite(local.getTime())) throw new TypeError('Некорректное время');
  return local.getUTCHours() < 4 ? null : local.toISOString().slice(0, 10);
}

function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError('Некорректная дата запуска');
  const time = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== day) throw new TypeError('Некорректная дата запуска');
  return day;
}

function canonicalPlan(day, plan) {
  if (!plan || !Array.isArray(plan.actions) || !Array.isArray(plan.deferred)
      || plan.actions.length + plan.deferred.length > NIGHTLY_MAX_DEALS) {
    throw new TypeError('Некорректный план ночного повтора');
  }
  const seen = new Set();
  const takeId = item => {
    const id = Number(item?.dealId);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) throw new TypeError('Некорректная сделка плана');
    seen.add(id);
    return id;
  };
  const actions = plan.actions.map(item => {
    const dealId = takeId(item);
    const date = new Date(item.loseDate);
    if (typeof item.loseDate !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(item.loseDate)
        || !Number.isFinite(date.getTime()) || item.triggerType !== 'nightly'
        || typeof item.silent !== 'boolean' || item.screenshots !== true
        || item.requestKey !== `nightly:${day}:${dealId}`) throw new TypeError('Некорректное задание плана');
    return { requestKey: item.requestKey, dealId, loseDate: date.toISOString(), triggerType: 'nightly', silent: item.silent, screenshots: true };
  });
  const deferred = plan.deferred.map(item => {
    const dealId = takeId(item);
    if (item.reason !== 'lose_date_unavailable') throw new TypeError('Некорректное состояние отложенной сделки');
    return { dealId, reason: item.reason };
  });
  return { actions, deferred };
}

async function readRun(pool, day) {
  const result = await pool.query(`SELECT run_date::text AS run_date, actions, deferred, status
    FROM public.lost_nightly_retry_runs WHERE run_date=$1`, [day]);
  return result.rows[0] || null;
}

// INSERT — отдельная транзакция БД. Если её результат неизвестен, исключение
// передаётся вызывающему; enqueue не вызывается. Следующий запуск читает снимок.
async function freezePlan(pool, day, preparePlan, nowMs) {
  let run = await readRun(pool, day);
  if (run) return run;
  const plan = canonicalPlan(day, await preparePlan({ mode: 'nightly', runKey: day, nowMs }));
  await pool.query(`INSERT INTO public.lost_nightly_retry_runs (run_date, actions, deferred)
    VALUES ($1, $2::jsonb, $3::jsonb) ON CONFLICT (run_date) DO NOTHING`,
  [day, JSON.stringify(plan.actions), JSON.stringify(plan.deferred)]);
  run = await readRun(pool, day);
  if (!run) throw new Error('Не удалось прочитать сохранённый ночной план');
  return run;
}

async function enqueueFrozen(pool, queue, run) {
  const day = validDay(run.run_date);
  const plan = canonicalPlan(day, run);
  if (run.status === 'enqueued') return { status: 'enqueued', day, ...plan, failed: [] };
  if (run.status !== 'planned') throw new Error('Неизвестное состояние ночного плана');
  const failed = [];
  for (const action of plan.actions) {
    try {
      const result = await queue.enqueueNightlyBudgeted(action);
      if (result?.budgetExhausted) return { status: 'planned', day, ...plan, failed, budgetExhausted: true };
    } catch { failed.push({ dealId: action.dealId, reason: 'enqueue_failed' }); }
  }
  if (failed.length) return { status: 'planned', day, ...plan, failed };
  // При потере ответа UPDATE повторное исполнение безопасно: очередь сравнивает requestKey.
  await pool.query(`UPDATE public.lost_nightly_retry_runs SET status='enqueued', updated_at=now()
    WHERE run_date=$1 AND status='planned'`, [day]);
  return { status: 'enqueued', day, ...plan, failed: [] };
}

/** Явный вызов после 04:00; сам модуль не включает таймер и не читает Битрикс. */
export async function runDueNightly({ pool, queue, preparePlan, nowMs = Date.now() }) {
  if (!pool || typeof pool.query !== 'function' || !queue || typeof queue.enqueueNightlyBudgeted !== 'function'
      || typeof preparePlan !== 'function') throw new TypeError('Не заданы зависимости ночного повтора');
  const day = nightlyDayIfDue(nowMs);
  if (!day) return { status: 'not_due' };
  return enqueueFrozen(pool, queue, await freezePlan(pool, day, preparePlan, nowMs));
}

/** Продолжает только ранее сохранённый план; задним числом новые планы не создаёт. */
export async function resumeNightly({ pool, queue, runDate }) {
  if (!pool || typeof pool.query !== 'function' || !queue || typeof queue.enqueueNightlyBudgeted !== 'function') {
    throw new TypeError('Не заданы зависимости ночного повтора');
  }
  const day = validDay(runDate);
  const run = await readRun(pool, day);
  if (!run) return { status: 'not_found', day };
  return enqueueFrozen(pool, queue, run);
}

/** Даёт планировщику список незавершённых дат для вызова resumeNightly. */
export async function listPendingNightlies(pool, { limit = 30 } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('Не задан пул базы');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Некорректный лимит');
  const response = await pool.query(`SELECT run_date::text AS run_date FROM public.lost_nightly_retry_runs
    WHERE status='planned' ORDER BY run_date ASC LIMIT $1`, [limit]);
  return response.rows.map(row => validDay(row.run_date));
}
