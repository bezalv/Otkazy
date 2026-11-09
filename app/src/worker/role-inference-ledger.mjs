import { randomUUID } from 'node:crypto';
import { exactMillisTimestamp } from '../time-precision.mjs';

// Прототип, намеренно не подключён к очереди/Polza и не применяет миграции.
// Требуются две отдельные приватные таблицы (RLS + revoke для anon/authenticated):
// scopes(deal_id bigint, stage_history_id text, PRIMARY KEY(deal_id,stage_history_id));
// attempts(job_id uuid FK lost_processing_jobs(id), attempt_no smallint 1..3,
// deal_id bigint, stage_history_id text, FK(deal_id,stage_history_id) REFERENCES scopes,
// lease_token uuid, run_id uuid, state reserved|settled|unknown,
// created_at timestamptz, finished_at timestamptz nullable,
// PRIMARY KEY(job_id,attempt_no); reserved => finished_at IS NULL,
// settled/unknown => finished_at IS NOT NULL). Текста и ключей в таблицах нет.
// `settled` означает только полученный и на момент вызова finish проверенный
// ответ модели. Он не подтверждает применение роли, правильность вывода,
// неизменность контекста после этой проверки, сумму или срок списания.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set(['reserved', 'settled', 'unknown']);
const validUuid = value => typeof value === 'string' && UUID.test(value);
// Область подтверждается только для объекта, созданного этой фабрикой;
// одноимённый метод произвольного объекта не является доказательством связи.
const ledgerScopes = new WeakMap();
const ledgerBindings = new WeakMap();
export function getRoleInferenceLedgerScope(ledger) {
  return ledger && (typeof ledger === 'object' || typeof ledger === 'function')
    ? ledgerScopes.get(ledger) ?? null : null;
}
// Секрет аренды никогда не возвращается вызывающему и не сериализуется.
export function matchesRoleInferenceLedgerBinding(ledger, expected) {
  const binding = ledger && (typeof ledger === 'object' || typeof ledger === 'function')
    ? ledgerBindings.get(ledger) : null;
  if (!binding || !expected || typeof expected !== 'object') return false;
  const cutoffDate = exactMillisTimestamp(expected.cutoff);
  return validUuid(expected.jobId) && validUuid(expected.leaseToken)
    && expected.jobId.toLowerCase() === binding.jobId && expected.leaseToken.toLowerCase() === binding.leaseToken
    && String(expected.dealId ?? '') === binding.dealId && String(expected.stageHistoryId ?? '') === binding.stageHistoryId
    && cutoffDate?.toISOString() === binding.cutoff;
}
const positiveId = value => {
  const s=String(value ?? '');
  return /^[1-9]\d{0,15}$/.test(s) && Number.isSafeInteger(Number(s)) ? s : null;
};
const transitionId = value => {
  const s=typeof value === 'string' ? value : '';
  return /^[1-9]\d{0,29}$/.test(s) ? s : null;
};

/**
 * Один экземпляр — одно выполнение в одном процессе. После перезапуска новый
 * run_id намеренно запрещает последующие POST даже по той же действующей
 * аренде: текст предыдущего результата здесь не хранится и не восстанавливается.
 * Вызывающий ОБЯЗАН получить stageHistoryId из проверенной истории Битрикса;
 * существующая очередь не хранит этот ID у всех ручных/ночных заданий, поэтому
 * один этот ledger не доказывает корректность переданного ID перехода.
 * До POST вызывающий ОБЯЗАН дождаться reserve.status='reserved' и непосредственно
 * перед вызовом preSend(attempt_no).status='allowed'.
 * Эта отметка не гарантирует живую аренду к моменту HTTP: между проверкой и
 * внешней сетью атомарность невозможна. Потребитель обязан дополнительно
 * перепроверить аренду перед отправкой; ранее сохранённый reserve при этом
 * блокирует повторный POST другим исполнителем того же перехода.
 * После этого вызывающий сам подтверждает содержимое ответа; сетевые действия
 * этим модулем не выполняются. Неизвестный COMMIT означает запрет на POST.
 */
export function createRoleInferenceLedger(pool, { jobId, leaseToken, dealId, stageHistoryId, cutoff } = {}) {
  const deal = positiveId(dealId), transition = transitionId(stageHistoryId);
  const cutoffDate = exactMillisTimestamp(cutoff);
  if (!pool || typeof pool.connect !== 'function' || !validUuid(jobId) || !validUuid(leaseToken)
      || !deal || !transition || !cutoffDate) {
    throw new TypeError('Не задана действительная привязка к заданию');
  }
  const exactCutoff = cutoffDate.toISOString();
  const scope = Object.freeze({dealId:deal,stageHistoryId:transition,cutoff:exactCutoff});
  const runId = randomUUID();
  let sealed = false, busy = false;
  async function exclusively(action) {
    if (sealed) throw new Error('ROLE_LEDGER_CLOSED');
    if (busy) throw new Error('ROLE_LEDGER_BUSY');
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  async function transaction(action) {
    if (sealed) throw new Error('ROLE_LEDGER_CLOSED');
    let connection;
    try { connection = await pool.connect(); }
    catch { sealed = true; throw new Error('ROLE_LEDGER_UNAVAILABLE'); }
    let began = false, committing = false, discard = false;
    try {
      await connection.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      began = true;
      const result = await action(connection);
      committing = true;
      await connection.query('COMMIT');
      committing = false;
      return result;
    } catch {
      sealed = true;
      if (committing) {
        // Сервер мог зафиксировать резерв даже при потерянном ответе. Этому
        // экземпляру и вызывающему коду нельзя выдавать право на POST.
        discard = true;
        throw new Error('ROLE_LEDGER_COMMIT_OUTCOME_UNKNOWN');
      }
      if (began) { try { await connection.query('ROLLBACK'); } catch { discard = true; } }
      else discard = true;
      throw new Error('ROLE_LEDGER_UNAVAILABLE');
    } finally {
      try { connection.release(discard ? new Error('Состояние соединения неизвестно') : undefined); }
      catch { sealed = true; throw new Error('ROLE_LEDGER_UNAVAILABLE'); }
    }
  }
  async function lockLease(connection) {
    // Включаем ожидание SELECT/COMMIT в оценку оставшегося времени аренды.
    const sampledAt = performance.now();
    const result = await connection.query(`SELECT id,
      floor(extract(epoch FROM (lease_until-clock_timestamp())) * 1000)::numeric AS remaining_ms
      FROM public.lost_processing_jobs
      WHERE id=$1::uuid AND status='processing' AND lease_token=$2::uuid
        AND deal_id=$3::bigint AND lose_date=$5::timestamptz AND lease_until>clock_timestamp()
        AND ((trigger_type IN ('live','backfill') AND request_key='bitrix24:deal-stage-history:' || $4)
          OR (trigger_type NOT IN ('live','backfill') AND request_key NOT LIKE 'bitrix24:deal-stage-history:%'))
      FOR UPDATE`, [jobId, leaseToken, deal, transition, exactCutoff]);
    if (result.rows.length !== 1) return null;
    const remainingMs = Number(result.rows[0].remaining_ms);
    return Number.isFinite(remainingMs) && remainingMs > 0 ? { remainingMs, sampledAt } : null;
  }
  async function lockScope(connection, create = false) {
    if (create) await connection.query(`INSERT INTO public.lost_role_inference_scopes (deal_id,stage_history_id)
      VALUES ($1::bigint,$2) ON CONFLICT (deal_id,stage_history_id) DO NOTHING`, [deal, transition]);
    const locked = await connection.query(`SELECT deal_id FROM public.lost_role_inference_scopes
      WHERE deal_id=$1::bigint AND stage_history_id=$2 FOR UPDATE`, [deal, transition]);
    return locked.rows.length === 1;
  }
  const ledger = Object.freeze({
    scope() { return scope; },
    async reserve() {
      return exclusively(async () => {
        const reserved = await transaction(async connection => {
          if (!await lockLease(connection)) return { status:'lease_lost' };
          if (!await lockScope(connection, true)) throw new Error('Область перехода не заблокирована');
          const crossScope = await connection.query(`SELECT EXISTS (
            SELECT 1 FROM public.lost_role_inference_attempts WHERE job_id=$1::uuid
              AND (deal_id<>$2::bigint OR stage_history_id<>$3)) AS found`, [jobId, deal, transition]);
          if (crossScope.rows.length !== 1 || crossScope.rows[0].found !== false) return { status:'needs_review' };
          const found = await connection.query(`SELECT job_id::text,attempt_no,lease_token::text,run_id::text,state
            FROM public.lost_role_inference_attempts WHERE deal_id=$1::bigint AND stage_history_id=$2
            ORDER BY job_id,attempt_no`, [deal, transition]);
          const attempts = found.rows;
        // Не только незавершённый запрос, но и смена процесса или аренды
        // требует сверки: прежние ответы и их роль не восстанавливаются.
          if (attempts.length > 3 || attempts.some((row, i) => row.job_id !== jobId.toLowerCase()
              || Number(row.attempt_no) !== i + 1 || !STATES.has(row.state) || row.state !== 'settled'
              || row.lease_token !== leaseToken.toLowerCase() || row.run_id !== runId)) return { status:'needs_review' };
          if (attempts.length === 3) return { status:'limit_reached' };
          const next = attempts.length + 1;
          const inserted = await connection.query(`INSERT INTO public.lost_role_inference_attempts
            (job_id,attempt_no,deal_id,stage_history_id,lease_token,run_id,state,created_at,finished_at)
            SELECT $1::uuid,$3::smallint,$5::bigint,$6,$2::uuid,$4::uuid,'reserved',clock_timestamp(),NULL
            FROM public.lost_processing_jobs j WHERE j.id=$1::uuid AND j.status='processing'
              AND j.lease_token=$2::uuid AND j.deal_id=$5::bigint AND j.lose_date=$7::timestamptz
              AND j.lease_until>clock_timestamp()
            RETURNING attempt_no`, [jobId, leaseToken, next, runId, deal, transition, exactCutoff]);
          if (inserted.rows.length !== 1) return { status:'lease_lost' };
          return { status:'reserved',attempt_no:next };
        });
        if (reserved.status !== 'reserved') return reserved;
        // После COMMIT резерв уже durable. Долгий COMMIT мог занять остаток
        // аренды: дополнительно проверяем её и не выдаём право на отправку,
        // если срок уже истёк. При неопределённом результате резерв остаётся.
        const live = await transaction(lockLease);
        const conservativeMs = live && live.remainingMs - (performance.now() - live.sampledAt);
        return live && conservativeMs > 1000 ? reserved : { status:'lease_lost' };
      });
    },
    async preSend(attemptNo) {
      if (!Number.isSafeInteger(attemptNo) || attemptNo < 1 || attemptNo > 3) throw new TypeError('Некорректная попытка');
      return exclusively(async () => {
        let sampled = null;
        const checked = await transaction(async connection => {
          sampled = await lockLease(connection);
          if (!sampled) return {status:'lease_lost'};
          if (!await lockScope(connection)) return {status:'needs_review'};
          const found = await connection.query(`SELECT job_id::text,attempt_no,lease_token::text,run_id::text,state
            FROM public.lost_role_inference_attempts WHERE deal_id=$1::bigint AND stage_history_id=$2
            ORDER BY job_id,attempt_no`, [deal, transition]);
          const attempts = found.rows;
          if (attempts.length !== attemptNo || attempts.some((row, i) => row.job_id !== jobId.toLowerCase()
              || Number(row.attempt_no) !== i + 1 || row.lease_token !== leaseToken.toLowerCase()
              || row.run_id !== runId || row.state !== (i === attemptNo - 1 ? 'reserved' : 'settled'))) {
            return {status:'needs_review'};
          }
          return {status:'allowed'};
        });
        if (checked.status !== 'allowed') return checked;
        const conservativeMs = sampled && sampled.remainingMs - (performance.now() - sampled.sampledAt);
        return sampled && conservativeMs > 1000 ? checked : {status:'lease_lost'};
      });
    },
    async finish(attemptNo, outcome) {
      if (!Number.isSafeInteger(attemptNo) || attemptNo < 1 || attemptNo > 3
          || !['settled', 'unknown'].includes(outcome)) throw new TypeError('Некорректный результат попытки');
      return exclusively(() => transaction(async connection => {
        if (!await lockLease(connection)) return { status:'lease_lost' };
        if (!await lockScope(connection)) return { status:'needs_review' };
        const updated = await connection.query(`UPDATE public.lost_role_inference_attempts a
          SET state=$5,finished_at=clock_timestamp()
          FROM public.lost_processing_jobs j
          WHERE a.job_id=$1::uuid AND a.attempt_no=$3::smallint AND a.lease_token=$2::uuid
            AND a.run_id=$4::uuid AND a.state='reserved' AND a.deal_id=$6::bigint AND a.stage_history_id=$7
            AND j.id=a.job_id AND j.status='processing' AND j.lease_token=$2::uuid
            AND j.deal_id=$6::bigint AND j.lose_date=$8::timestamptz AND j.lease_until>clock_timestamp() RETURNING a.attempt_no`,
        [jobId, leaseToken, attemptNo, runId, outcome, deal, transition, exactCutoff]);
        return updated.rows.length === 1 ? { status:outcome } : { status:'needs_review' };
      }));
    },
  });
  ledgerScopes.set(ledger, scope);
  ledgerBindings.set(ledger, Object.freeze({ ...scope, jobId:jobId.toLowerCase(), leaseToken:leaseToken.toLowerCase() }));
  return ledger;
}
