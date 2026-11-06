import { inTransaction } from '../persistence/transaction.mjs';

const DISPOSITIONS = ['already_handled', 'already_waiting', 'retry_needed', 'unprocessed', 'unverified'];

function count(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) throw new Error('Некорректный результат');
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('Некорректный результат');
  return n;
}

/** Никаких идентификаторов сделок, событий или текстов в результате. */
export function summarizeDiscovery(report) {
  if (!report || !Array.isArray(report.events) || typeof report.scan_complete !== 'boolean'
      || report.coverage_guaranteed !== false || !Number.isSafeInteger(report.pages_read) || report.pages_read < 0) {
    throw new Error('Некорректный отчёт поиска');
  }
  const counts = Object.fromEntries(DISPOSITIONS.map(name => [name, 0]));
  for (const event of report.events) {
    if (!event || !DISPOSITIONS.includes(event.disposition)) throw new Error('Некорректная классификация');
    counts[event.disposition]++;
  }
  return { pages_read: report.pages_read, scan_complete: report.scan_complete, coverage_guaranteed: false, counts };
}

/** Транзакция только на чтение; RLS не должен скрывать строки. */
export async function reviewSummary(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Нужен пул PostgreSQL');
  try {
    return await inTransaction(pool, async db => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const check = await db.query(`SELECT c.relkind IN ('r','p') AS is_table,
        row_security_active(c.oid) AS rls_active
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname='lost_processing_jobs'`);
      if (check.rows?.length !== 1 || check.rows[0].is_table !== true || check.rows[0].rls_active !== false) {
        throw new Error('Не подтверждена видимость очереди');
      }
      const result = await db.query(`SELECT count(*)::text AS total,
        count(*) FILTER (WHERE comment_state='unknown' AND notify_state='unknown')::text AS both_unknown,
        count(*) FILTER (WHERE comment_state='unknown' AND notify_state<>'unknown')::text AS comment_unknown,
        count(*) FILTER (WHERE comment_state<>'unknown' AND notify_state='unknown')::text AS notification_unknown,
        count(*) FILTER (WHERE comment_state<>'unknown' AND notify_state<>'unknown')::text AS other
        FROM public.lost_processing_jobs WHERE status='needs_review'`);
      if (result.rows?.length !== 1) throw new Error('Неполный результат');
      const { total, both_unknown, comment_unknown, notification_unknown, other } = result.rows[0];
      const counts = { total: count(total), comment_unknown: count(comment_unknown), notification_unknown: count(notification_unknown), both_unknown: count(both_unknown), other: count(other) };
      if (counts.total !== counts.comment_unknown + counts.notification_unknown + counts.both_unknown + counts.other) throw new Error('Несогласованный результат');
      return counts;
    });
  } catch { throw new Error('Не удалось получить отчёт о доставке'); }
}
