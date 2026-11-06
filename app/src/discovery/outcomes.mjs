import { discoverTransitions } from './index.mjs';
import { inTransaction } from '../persistence/transaction.mjs';
import { exactMillisTimestamp } from '../time-precision.mjs';

const EVENT_KEY = /^bitrix24:deal-stage-history:[1-9]\d{0,29}$/;
const MAX_EVENTS = 5000;

function validateEvents(events) {
  if (!Array.isArray(events) || events.length > MAX_EVENTS) throw new TypeError('Некорректный список переходов');
  const keys = new Set();
  return events.map(event => {
    const rawId = event?.deal_id;
    if ((typeof rawId !== 'string' && typeof rawId !== 'number') || !/^[1-9]\d{0,9}$/.test(String(rawId))
      || (typeof rawId === 'number' && !Number.isSafeInteger(rawId))
      || BigInt(rawId) > 2147483647n) throw new TypeError('Некорректная сделка перехода');
    if (typeof event.event_key !== 'string' || !EVENT_KEY.test(event.event_key) || keys.has(event.event_key)) {
      throw new TypeError('Некорректный или повторный ключ перехода');
    }
    keys.add(event.event_key);
    const date = exactMillisTimestamp(event.occurred_at);
    if (!date) throw new TypeError('Некорректная дата перехода');
    return { event_key: event.event_key, deal_id: Number(rawId), occurred_at: date.toISOString() };
  });
}

/**
 * Пакетная сверка только чтением. Исторические строки n8n не содержат ID
 * конкретного перехода и сами по себе не доказывают исход этого перехода.
 */
export function createOutcomeComparator(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Нужен пул PostgreSQL');
  return async function compareOutcomes(input) {
    const events = validateEvents(input);
    if (!events.length) return [];
    try {
      return await inTransaction(pool, async connection => {
        // Проверка схемы и данные находятся в одном снимке: даже если новые
        // таблицы ещё не созданы, их отсутствие не скрывает другие записи.
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const schema = await connection.query(`SELECT
          to_regclass('public.lost_deals') IS NOT NULL AS deals,
          to_regclass('public.lost_deal_analyses') IS NOT NULL AS analyses,
          to_regclass('public.lost_deal_communications') IS NOT NULL AS communications,
          to_regclass('public.lost_audio_wait') IS NOT NULL AS audio_wait,
          to_regclass('public.lost_processing_jobs') IS NOT NULL AS jobs,
          to_regclass('public.lost_bitrix_events') IS NOT NULL AS inbox,
          EXISTS (SELECT 1 FROM pg_attribute
            WHERE attrelid=to_regclass('public.lost_deal_analyses') AND attname='pipeline_operation_id'
              AND NOT attisdropped) AS operation_column`);
        const info = schema.rows?.[0];
        if (!info || !info.deals || !info.analyses || !info.communications || !info.audio_wait
          || (info.jobs && !info.operation_column)) throw new Error('Неполная схема восстановления');
        const expectedTables = ['lost_deals', 'lost_deal_analyses', 'lost_deal_communications', 'lost_audio_wait',
          ...(info.jobs ? ['lost_processing_jobs'] : []), ...(info.inbox ? ['lost_bitrix_events'] : [])];
        const visibility = await connection.query(`SELECT count(*)::integer AS table_count,
            bool_and(c.relkind IN ('r','p')) AS all_tables,
            bool_or(row_security_active(c.oid)) AS rls_active
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname=ANY($1::text[])`, [expectedTables]);
        const access = visibility.rows?.[0];
        if (!access || Number(access.table_count) !== expectedTables.length || access.all_tables !== true || access.rls_active !== false) {
          // Если RLS действует на текущую роль, EXISTS может скрывать строки и
          // отсутствие результата не доказывает отсутствие данных.
          throw new Error('Нельзя подтвердить видимость всех строк');
        }
        // SQL-фрагменты выбираются только по наличию таблиц; значения всегда
        // поступают параметром, а не через динамическую подстановку.
        const hasJobs = info.jobs === true, hasInbox = info.inbox === true;
        const sql = `WITH events AS (
            SELECT event_key, deal_id, occurred_at FROM jsonb_to_recordset($1::jsonb)
              AS e(event_key text, deal_id bigint, occurred_at timestamptz)
          )
          SELECT e.event_key,
            EXISTS (SELECT 1 FROM public.lost_deals d WHERE d.deal_id=e.deal_id) AS has_deal,
            EXISTS (SELECT 1 FROM public.lost_deal_analyses a WHERE a.deal_id=e.deal_id) AS has_analyses,
            EXISTS (SELECT 1 FROM public.lost_deal_communications c WHERE c.deal_id=e.deal_id) AS has_communications,
            EXISTS (SELECT 1 FROM public.lost_audio_wait w WHERE w.deal_id=e.deal_id) AS has_audio_wait,
            EXISTS (SELECT 1 FROM public.lost_audio_wait w WHERE w.deal_id=e.deal_id
              AND w.state='waiting' AND w.lose_date=e.occurred_at) AS matching_audio_wait,
            ${hasJobs ? 'EXISTS (SELECT 1 FROM public.lost_processing_jobs j WHERE j.deal_id=e.deal_id)' : 'false'} AS has_jobs,
            ${hasInbox ? 'EXISTS (SELECT 1 FROM public.lost_bitrix_events i WHERE i.deal_id=e.deal_id)' : 'false'} AS has_inbox,
            ${hasJobs ? "EXISTS (SELECT 1 FROM public.lost_processing_jobs j WHERE j.deal_id=e.deal_id AND j.status IN ('pending','processing','needs_review'))" : 'false'} AS has_active_jobs,
            ${hasInbox ? "EXISTS (SELECT 1 FROM public.lost_bitrix_events i WHERE i.deal_id=e.deal_id AND i.status IN ('pending','processing'))" : 'false'} AS has_active_inbox,
            ${hasJobs ? 'EXISTS (SELECT 1 FROM public.lost_processing_jobs j WHERE j.deal_id=e.deal_id AND j.request_key<>e.event_key)' : 'false'} AS has_other_jobs,
            ${hasJobs ? `(SELECT j.status FROM public.lost_processing_jobs j
              WHERE j.request_key=e.event_key AND j.deal_id=e.deal_id AND j.lose_date=e.occurred_at)` : 'NULL::text'} AS exact_job_status,
            ${hasJobs ? `(SELECT a.id FROM public.lost_processing_jobs j JOIN public.lost_deal_analyses a ON a.pipeline_operation_id=j.id
              WHERE j.request_key=e.event_key AND j.deal_id=e.deal_id AND j.lose_date=e.occurred_at AND a.deal_id=e.deal_id)` : 'NULL::bigint'} AS exact_analysis_id,
            ${hasJobs ? `(SELECT a.pipeline_error FROM public.lost_processing_jobs j JOIN public.lost_deal_analyses a ON a.pipeline_operation_id=j.id
              WHERE j.request_key=e.event_key AND j.deal_id=e.deal_id AND j.lose_date=e.occurred_at AND a.deal_id=e.deal_id)` : 'NULL::text'} AS exact_error,
            ${hasJobs ? `(SELECT a.ai_verdict FROM public.lost_processing_jobs j JOIN public.lost_deal_analyses a ON a.pipeline_operation_id=j.id
              WHERE j.request_key=e.event_key AND j.deal_id=e.deal_id AND j.lose_date=e.occurred_at AND a.deal_id=e.deal_id)` : 'NULL::text'} AS exact_verdict
          FROM events e`;
        const response = await connection.query(sql, [JSON.stringify(events)]);
        if (!Array.isArray(response.rows) || response.rows.length !== events.length) throw new Error('Неполная сверка');
        const byKey = new Map(response.rows.map(row => [row.event_key, row]));
        if (byKey.size !== events.length) throw new Error('Повтор результатов сверки');
        return events.map(event => {
          const row = byKey.get(event.event_key);
          if (!row) throw new Error('Нет результата сверки');
          for (const name of ['has_deal', 'has_analyses', 'has_communications', 'has_audio_wait', 'matching_audio_wait', 'has_jobs', 'has_inbox', 'has_active_jobs', 'has_active_inbox', 'has_other_jobs']) {
            if (typeof row[name] !== 'boolean') throw new Error('Некорректный результат сверки');
          }
          const base = { event_key: event.event_key };
          const evidence = { event_key: event.event_key };
          // Незавершённая обработка или сверка доставки может изменить исход;
          // её нельзя скрыть за найденным ранее успешным анализом.
          if (row.has_active_jobs || row.has_active_inbox) return { ...base, status: 'unknown' };
          // lost_audio_wait не хранит ID перехода. Одинаковые временные метки
          // могут оказаться на разных страницах и не доказывают единственность.
          if (row.matching_audio_wait) return { ...base, status: 'unknown', reason: 'audio_wait_transition_unverified' };
          if (row.exact_job_status === 'done' && row.exact_analysis_id != null) {
            if (row.exact_error != null) return row.has_other_jobs ? { ...base, status: 'unknown' } : { ...base, status: 'pipeline_error', evidence };
            if (['правомерен', 'неправомерен', 'недостаточно_данных'].includes(row.exact_verdict)) {
              return { ...base, status: 'processed', evidence };
            }
          }
          if (!row.has_deal && !row.has_analyses && !row.has_communications && !row.has_audio_wait && !row.has_jobs && !row.has_inbox) {
            return { ...base, status: 'not_found', complete: true };
          }
          return { ...base, status: 'unknown' };
        });
      });
    } catch {
      throw new Error('Не удалось сверить сохранённые исходы');
    }
  };
}

/** Только отчёт; ничего не создаёт и не запускает. */
export function scanLostTransitions({ pool, ...options }) {
  return discoverTransitions({ ...options, compareOutcomes: createOutcomeComparator(pool) });
}
