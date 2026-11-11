import { randomUUID } from 'node:crypto';
import { NIGHTLY_MAX_DEALS } from '../rules/nightly-retry.mjs';
import { exactMillisTimestamp } from '../time-precision.mjs';

const DEFAULT_LEASE_SECONDS = 70 * 60;
const EVENT_KEY = /^bitrix24:deal-stage-history:[1-9]\d{0,29}$/;
const EVENT_PREFIX = 'bitrix24:deal-stage-history:';

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

  async function enqueueOn(connection, { requestKey, dealId, loseDate, triggerType, silent = false, screenshots = true }, createdAt = null) {
      if (typeof requestKey !== 'string' || !requestKey.trim() || requestKey.length > 300) throw new TypeError('Некорректный ключ задания');
      if (!Number.isSafeInteger(Number(dealId)) || Number(dealId) <= 0) throw new TypeError('Некорректный ID сделки');
      const date = new Date(loseDate);
      if (!loseDate || !Number.isFinite(date.getTime())) throw new TypeError('Некорректная дата отказа');
      if (typeof triggerType !== 'string' || !triggerType.trim()) throw new TypeError('Не задан тип запуска');
      const eventChannel = triggerType === 'live' || triggerType === 'backfill';
      if ((eventChannel && !EVENT_KEY.test(requestKey)) || (!eventChannel && requestKey.startsWith(EVENT_PREFIX))) {
        throw new TypeError('Ключ перехода не соответствует типу запуска');
      }
      if (eventChannel && !exactMillisTimestamp(loseDate)) throw new TypeError('Некорректная точность даты перехода');
      if (triggerType === 'backfill') {
        // Граница неизменяема в БД. Исторический тихий прогон не должен
        // перехватить живое событие и тем самым погасить уведомления.
        const cutoff = await connection.query(`SELECT $1::timestamptz < enabled_at
          AND date_trunc('milliseconds',enabled_at)=enabled_at AS allowed
          FROM public.lost_live_config WHERE id=true`, [date.toISOString()]);
        if (cutoff.rows.length !== 1 || cutoff.rows[0].allowed !== true) {
          throw new Error('Восстановление возможно только до включения живого канала');
        }
      }
      const id = uuid();
      if (!validId(id)) throw new TypeError('Некорректный UUID задания');
      const params = [id, requestKey, Number(dealId), date.toISOString(), triggerType, silent === true, screenshots === true];
      if (createdAt !== null) params.push(createdAt);
      const inserted = await connection.query(`
        insert into public.lost_processing_jobs
          (id, request_key, deal_id, lose_date, trigger_type, silent, screenshots${createdAt === null ? '' : ', created_at'})
        values ($1, $2, $3, $4, $5, $6, $7${createdAt === null ? '' : ', $8::timestamptz'})
        on conflict (request_key) do nothing
        returning id, request_key, deal_id, lose_date, trigger_type, silent, screenshots, status`, params);
      if (inserted.rows.length) return { created: true, job: inserted.rows[0] };
      const existing = await connection.query(`
        select id, request_key, deal_id, lose_date, trigger_type, silent, screenshots, status,
          lose_date=$2::timestamptz as date_matches
        from public.lost_processing_jobs where request_key = $1`, [requestKey, date.toISOString()]);
      const job = existing.rows[0];
      // Один и тот же переход иногда обнаруживают оба канала. Сохраняем
      // параметры первого задания без изменений: повтор не создаёт новую
      // отправку и не меняет уже выбранный тихий режим. Это исключение
      // относится только к каноническому ключу и паре live/backfill.
      const sameEventDifferentChannel = EVENT_KEY.test(requestKey)
        && ((job?.trigger_type === 'live' && triggerType === 'backfill')
          || (job?.trigger_type === 'backfill' && triggerType === 'live'));
      if (!job || Number(job.deal_id) !== params[2] || job.date_matches !== true
          || (!sameEventDifferentChannel && (job.trigger_type !== triggerType
            || job.silent !== params[5] || job.screenshots !== params[6]))) {
        throw new Error('Ключ задания уже используется с другими параметрами');
      }
      return { created: false, job };
  }

  async function transaction(fn) {
    // PGlite предоставляет transaction; pg.Pool — выделенное соединение.
    if (typeof pool.transaction === 'function') return pool.transaction(fn);
    const client = await pool.connect();
    let releaseError;
    let committing = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const value = await fn(client);
      committing = true;
      await client.query('COMMIT');
      committing = false;
      return value;
    } catch (error) {
      // После ошибки COMMIT сервер мог подтвердить транзакцию без ответа клиенту.
      // Повтор разрешается по request_key; соединение больше не возвращаем в пул.
      if (committing) releaseError = error;
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = releaseError || rollbackError; }
      if (committing) throw new Error('Неизвестен результат COMMIT ночного задания', { cause: error });
      throw error;
    } finally { client.release(releaseError); }
  }

  return {
    async enqueue(action) {
      if (action?.triggerType === 'nightly') throw new TypeError('Ночные задания требуют общего бюджета');
      return enqueueOn(pool, action);
    },

    // Одна блокировка на все окна: даже переход через 04:00 не позволяет двум
    // экземплярам одновременно проверить лимит и поставить лишнее задание.
    async enqueueNightlyBudgeted(action) {
      if (action?.triggerType !== 'nightly') throw new TypeError('Ожидалось ночное задание');
      return transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lost-nightly-budget', 0))");
        const previous = await client.query('SELECT 1 FROM public.lost_processing_jobs WHERE request_key=$1', [action.requestKey]);
        if (previous.rows.length) return enqueueOn(client, action);
        const result = await client.query(`WITH current_time_value AS (SELECT clock_timestamp() AS instant),
          bounds AS (SELECT instant, (date_trunc('day', (instant AT TIME ZONE 'UTC') + interval '3 hours')
            - interval '3 hours') AT TIME ZONE 'UTC' AS starts FROM current_time_value)
          SELECT instant, (SELECT count(*)::int FROM public.lost_processing_jobs j
            WHERE j.trigger_type='nightly' AND j.created_at >= bounds.starts
              AND j.created_at < bounds.starts + interval '24 hours') AS used FROM bounds`);
        const { instant, used } = result.rows[0];
        if (used >= NIGHTLY_MAX_DEALS) return { created: false, budgetExhausted: true };
        return enqueueOn(client, action, instant);
      });
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
                where active.deal_id = job.deal_id and active.status in ('processing', 'needs_review')
              )
            order by job.available_at, job.created_at, job.id
            for update skip locked limit 1
          )
          update public.lost_processing_jobs job
          set status = 'processing', lease_token = $1,
              lease_until = now() + make_interval(secs => $2::double precision),
              attempts = attempts + 1, updated_at = now()
          from candidate where job.id = candidate.id
          returning job.*, to_char(job.lose_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS lose_date`, [token, duration]);
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

    // Запись разрешена только текущему владельцу и не перезаписывает ID.
    async bindRetryTransition({ id, token, dealId, loseDate, stageHistoryId }) {
      if (!validId(id) || !validId(token) || !Number.isSafeInteger(Number(dealId)) || Number(dealId) <= 0
          || !exactMillisTimestamp(loseDate instanceof Date ? loseDate.toISOString() : loseDate)
          || typeof stageHistoryId !== 'string' || !/^[1-9]\d{0,29}$/.test(stageHistoryId)) throw new TypeError('Некорректный переход');
      const result = await pool.query(`UPDATE public.lost_processing_jobs SET origin_stage_history_id=$5,updated_at=clock_timestamp()
        WHERE id=$1 AND lease_token=$2 AND deal_id=$3 AND lose_date=$4::timestamptz
          AND trigger_type IN ('manual','nightly') AND status='processing' AND lease_until>clock_timestamp()
          AND (origin_stage_history_id IS NULL OR origin_stage_history_id=$5)
        RETURNING origin_stage_history_id`, [id,token,Number(dealId),loseDate,stageHistoryId]);
      return result.rows.length === 1 && result.rows[0].origin_stage_history_id === stageHistoryId;
    },

    // Происхождение старого ожидания не угадывается по дате. Останавливаем
    // только задание: исходную очередь аудио оператор сверит отдельно.
    async markAudioOriginNeedsReview(id, token, reason) {
      if (!validId(id) || !validId(token)) throw new TypeError('Некорректный идентификатор аренды');
      if (!['audio_origin_missing', 'audio_origin_mismatch'].includes(reason)) throw new TypeError('Некорректная причина сверки');
      const result = await pool.query(`UPDATE public.lost_processing_jobs
        SET status='needs_review', lease_token=NULL, lease_until=NULL, last_error=$3, updated_at=now()
        WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp() RETURNING id`,
      [id, token, reason]);
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

    // Ночной повтор мог ждать в очереди, пока другая задача устранила сбой.
    async finishObsoleteNightly(id, token) {
      if (!validId(id) || !validId(token)) throw new TypeError('Некорректный идентификатор аренды');
      const result = await pool.query(`
        UPDATE public.lost_processing_jobs j
        SET status='done', lease_token=NULL, lease_until=NULL, updated_at=now()
        WHERE j.id=$1 AND j.lease_token=$2 AND j.status='processing'
          AND j.lease_until>clock_timestamp() AND j.trigger_type='nightly'
          AND NOT EXISTS (
            SELECT 1 FROM public.lost_pipeline_attention a
            WHERE a.deal_id=j.deal_id AND a.retry_eligible=true
          )
        RETURNING j.id`, [id, token]);
      return result.rows.length === 1;
    },

    // Обработчик подтвердил по истории Битрикса уже другой переход в отказ.
    async finishObsoleteTransition(id, token, audioHistoryId = null) {
      if (!validId(id) || !validId(token)) throw new TypeError('Некорректный идентификатор аренды');
      if (audioHistoryId !== null && (typeof audioHistoryId !== 'string' || !/^[1-9]\d{0,29}$/.test(audioHistoryId))) throw new TypeError('Некорректный ID ожидания');
      const result = await pool.query(`
        WITH obsolete AS (
          UPDATE public.lost_processing_jobs
          SET status='done', lease_token=NULL, lease_until=NULL, updated_at=now()
          WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp()
          RETURNING id, deal_id, lose_date, request_key, trigger_type
        ), cancelled AS (
          UPDATE public.lost_audio_wait w SET state='cancelled', lease_until=NULL, updated_at=now()
          FROM obsolete o
          WHERE o.trigger_type='audio_wait' AND w.deal_id=o.deal_id AND w.lose_date=o.lose_date AND w.origin_stage_history_id=$3
            AND w.state='waiting' AND o.request_key = 'audio-wait:' || w.deal_id::text || ':' ||
              (extract(epoch from w.lose_date) * 1000000)::bigint::text || ':' ||
              (extract(epoch from w.next_check_at) * 1000000)::bigint::text
          RETURNING w.deal_id
        )
        SELECT id FROM obsolete`, [id, token, audioHistoryId]);
      return result.rows.length === 1;
    },
  };
}
