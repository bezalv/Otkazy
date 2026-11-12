// Постановка очередной проверки аудио. Новая таблица ожиданий не создаётся.
// Старая n8n и этот планировщик не должны работать одновременно.
export async function enqueueDueAudioChecks(pool, { limit = 20, pilotEnabledAt = null } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('Нужен пул PostgreSQL');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Некорректный размер пакета');
  if (pilotEnabledAt !== null && (!Number.isFinite(Date.parse(pilotEnabledAt)) || new Date(pilotEnabledAt).toISOString() !== pilotEnabledAt)) throw new TypeError('Некорректная граница пилота');
  const result = await pool.query(`
    WITH due AS (
      SELECT w.deal_id, w.lose_date, w.next_check_at, w.silent, w.screenshots,
        'audio-wait:' || w.deal_id::text || ':' ||
        (extract(epoch from w.lose_date) * 1000000)::bigint::text || ':' ||
        (extract(epoch from w.next_check_at) * 1000000)::bigint::text AS request_key
      FROM public.lost_audio_wait w
      WHERE w.state='waiting' AND w.next_check_at <= now()
        ${pilotEnabledAt ? 'AND w.lose_date >= $2::timestamptz' : ''}
        AND (w.lease_until IS NULL OR w.lease_until <= now())
        AND NOT EXISTS (
          SELECT 1 FROM public.lost_processing_jobs j
          WHERE j.request_key = 'audio-wait:' || w.deal_id::text || ':' ||
            (extract(epoch from w.lose_date) * 1000000)::bigint::text || ':' ||
            (extract(epoch from w.next_check_at) * 1000000)::bigint::text
        )
      ORDER BY w.next_check_at, w.deal_id
      FOR UPDATE OF w SKIP LOCKED LIMIT $1
    )
    INSERT INTO public.lost_processing_jobs
      (id, request_key, deal_id, lose_date, trigger_type, silent, screenshots)
    SELECT gen_random_uuid(), request_key, deal_id, lose_date, 'audio_wait', silent, screenshots FROM due
    ON CONFLICT (request_key) DO NOTHING
    RETURNING id, deal_id, request_key`, pilotEnabledAt ? [limit, pilotEnabledAt] : [limit]);
  return result.rows;
}

export async function loadAudioWait(pool, job) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('Нужен пул PostgreSQL');
  if (!Number.isSafeInteger(Number(job?.deal_id)) || Number(job.deal_id) <= 0) throw new TypeError('Некорректная сделка');
  const result = await pool.query(`SELECT w.*,
      'audio-wait:' || w.deal_id::text || ':' ||
      (extract(epoch from w.lose_date) * 1000000)::bigint::text || ':' ||
      (extract(epoch from w.next_check_at) * 1000000)::bigint::text AS _scheduled_request_key
    FROM public.lost_audio_wait w WHERE w.deal_id=$1`, [Number(job.deal_id)]);
  return result.rows[0] || null;
}

export async function loadAudioWaitEnabledAt(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('Нужен пул PostgreSQL');
  const result = await pool.query('SELECT enabled_at FROM public.lost_audio_wait_config WHERE id=true');
  const date = result.rows[0]?.enabled_at;
  if (!date || !Number.isFinite(new Date(date).getTime())) throw new Error('Не задана дата включения ожидания аудио');
  return new Date(date).toISOString();
}
