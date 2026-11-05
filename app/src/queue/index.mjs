import { randomUUID } from 'node:crypto';

const DEFAULT_LEASE_SECONDS = 70 * 60;

function validId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function leaseSeconds(value) {
  if (!Number.isInteger(value) || value < 60 || value > 86400) throw new TypeError('Некорректный срок аренды задания');
  return value;
}

/** Очередь хранит только параметры запуска; все запросы выполняются через подключённый pg. */
export function createJobQueue(pool, { uuid = randomUUID, lease = DEFAULT_LEASE_SECONDS } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('Нужен пул PostgreSQL');
  const duration = leaseSeconds(lease);

  return {
    async enqueue({ requestKey, dealId, loseDate, triggerType, silent = false, screenshots = true }) {
      if (typeof requestKey !== 'string' || !requestKey.trim() || requestKey.length > 300) throw new TypeError('Некорректный ключ задания');
      if (!Number.isSafeInteger(Number(dealId)) || Number(dealId) <= 0) throw new TypeError('Некорректный ID сделки');
      const date = new Date(loseDate);
      if (!loseDate || !Number.isFinite(date.getTime())) throw new TypeError('Некорректная дата отказа');
      if (typeof triggerType !== 'string' || !triggerType.trim()) throw new TypeError('Не задан тип запуска');
      const id = uuid();
      if (!validId(id)) throw new TypeError('Некорректный UUID задания');
      const params = [id, requestKey, Number(dealId), date.toISOString(), triggerType, silent === true, screenshots === true];
      const inserted = await pool.query(`
        insert into public.lost_processing_jobs
          (id, request_key, deal_id, lose_date, trigger_type, silent, screenshots)
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (request_key) do nothing
        returning id, request_key, deal_id, lose_date, trigger_type, silent, screenshots, status`, params);
      if (inserted.rows.length) return { created: true, job: inserted.rows[0] };
      const existing = await pool.query(`
        select id, request_key, deal_id, lose_date, trigger_type, silent, screenshots, status
        from public.lost_processing_jobs where request_key = $1`, [requestKey]);
      const job = existing.rows[0];
      if (!job || Number(job.deal_id) !== params[2] || new Date(job.lose_date).getTime() !== date.getTime()
          || job.trigger_type !== triggerType || job.silent !== params[5] || job.screenshots !== params[6]) {
        throw new Error('Ключ задания уже используется с другими параметрами');
      }
      return { created: false, job };
    },

    async recoverExpired() {
      const result = await pool.query(`
        update public.lost_processing_jobs
        set status = 'pending', lease_token = null, lease_until = null, updated_at = now()
        where status = 'processing' and lease_until <= now()
        returning id`);
      return result.rows.length;
    },

    async claim() {
      const token = uuid();
      if (!validId(token)) throw new TypeError('Некорректный UUID аренды');
      try {
        const result = await pool.query(`
          with candidate as (
            select job.id from public.lost_processing_jobs job
            where job.status = 'pending' and job.available_at <= now()
              and not exists (
                select 1 from public.lost_processing_jobs active
                where active.deal_id = job.deal_id and active.status = 'processing'
              )
            order by job.available_at, job.created_at, job.id
            for update skip locked limit 1
          )
          update public.lost_processing_jobs job
          set status = 'processing', lease_token = $1,
              lease_until = now() + make_interval(secs => $2::double precision),
              attempts = attempts + 1, updated_at = now()
          from candidate where job.id = candidate.id
          returning job.*`, [token, duration]);
        return result.rows[0] || null;
      } catch (error) {
        // Два процесса могли одновременно выбрать разные задания одной сделки.
        if (error?.code === '23505' && error?.constraint === 'lost_jobs_one_processing_per_deal') return null;
        throw error;
      }
    },

    async renew(id, token) {
      if (!validId(id) || !validId(token)) throw new TypeError('Некорректный идентификатор аренды');
      const result = await pool.query(`
        update public.lost_processing_jobs
        set lease_until = now() + make_interval(secs => $3::double precision), updated_at = now()
        where id = $1 and lease_token = $2 and status = 'processing' and lease_until > now()
        returning id`, [id, token, duration]);
      return result.rows.length === 1;
    },

    // Устаревшая проверка аудио завершается, не изменяя актуальную очередь аудио.
    async finishObsoleteAudioCheck(id, token) {
      if (!validId(id) || !validId(token)) throw new TypeError('Некорректный идентификатор аренды');
      const result = await pool.query(`
        UPDATE public.lost_processing_jobs j
        SET status='done', lease_token=NULL, lease_until=NULL, updated_at=now()
        WHERE j.id=$1 AND j.lease_token=$2 AND j.status='processing'
          AND j.lease_until>clock_timestamp() AND j.trigger_type='audio_wait'
          AND NOT EXISTS (
            SELECT 1 FROM public.lost_audio_wait w WHERE w.deal_id=j.deal_id AND w.state='waiting'
              AND j.request_key = 'audio-wait:' || w.deal_id::text || ':' ||
                (extract(epoch from w.lose_date) * 1000000)::bigint::text || ':' ||
                (extract(epoch from w.next_check_at) * 1000000)::bigint::text
          )
        RETURNING j.id`, [id, token]);
      return result.rows.length === 1;
    },
  };
}
