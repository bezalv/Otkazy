import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createJobQueue } from '../queue/index.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = ['event', 'data[FIELDS][ID]', 'auth[domain]', 'auth[member_id]', 'auth[application_token]'];
const MAX_BODY = 64 * 1024;
const digest = value => createHash('sha256').update(value, 'utf8').digest();

export class LiveInputError extends Error {}
export class LiveAuthError extends Error {}
export class LiveConfigError extends Error {}

function tokenEqual(expectedHash, value) {
  return timingSafeEqual(expectedHash, digest(value));
}
function one(fields, name) {
  const values = fields.getAll(name);
  if (values.length !== 1 || !values[0]) throw new Error('Некорректное событие');
  return values[0];
}
function positiveId(value, max = 2147483647n) {
  if (!/^\d{1,30}$/.test(String(value))) throw new Error('Некорректный ID');
  const id = BigInt(value);
  if (id <= 0n || id > max) throw new Error('Некорректный ID');
  return id.toString();
}
function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('Некорректный UUID');
  return value;
}
function decodeBody(body) {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.isBuffer(body) ? body : null;
  if (!bytes || !bytes.length || bytes.length > MAX_BODY) throw new Error('Некорректное событие');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Некорректное событие'); }
  if (/%(?![0-9a-f]{2})/i.test(text)) throw new Error('Некорректное событие');
  const fields = new URLSearchParams(text);
  for (const name of FIELDS) if (fields.getAll(name).length !== 1) throw new Error('Некорректное событие');
  return fields;
}

/** Проверяет существующий cutoff только чтением, не создавая запись в БД. */
export async function validateLiveConfig(pool, liveEnabledAt) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('Нужен пул PostgreSQL');
  if (typeof liveEnabledAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(liveEnabledAt)
      || !Number.isFinite(Date.parse(liveEnabledAt))) throw new LiveConfigError('Не задано время включения лайв-триггера');
  const result = await pool.query('SELECT enabled_at=$1::timestamptz AS matches FROM public.lost_live_config WHERE id=true', [liveEnabledAt]);
  if (result.rows.length !== 1 || result.rows[0].matches !== true) throw new LiveConfigError('Конфигурация лайв-триггера отсутствует или отличается от сохранённой');
}

/**
 * Приём формы: успешный return допустимо преобразовать в HTTP 2xx только после
 * завершения INSERT. При ошибке COMMIT/соединения успех не предполагается.
 */
export function createLiveInbox(pool, { applicationToken, domain, memberId, liveEnabledAt, leaseSeconds = 300, retrySeconds = 60, createId = randomUUID } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('Нужен пул PostgreSQL');
  if (typeof applicationToken !== 'string' || !applicationToken || typeof memberId !== 'string' || !memberId
      || typeof domain !== 'string' || !/^[a-z0-9.-]+$/i.test(domain)) throw new TypeError('Не настроена проверка события Битрикса');
  if (typeof liveEnabledAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(liveEnabledAt)
      || !Number.isFinite(Date.parse(liveEnabledAt))) throw new TypeError('Не задано время включения лайв-триггера');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 86400
      || !Number.isInteger(retrySeconds) || retrySeconds < 1 || retrySeconds > 86400) throw new TypeError('Некорректные интервалы очереди');
  const expectedHash = digest(applicationToken);
  const expectedDomain = domain.toLowerCase();
  const enabledAtMs = Date.parse(liveEnabledAt);
  const assertConfig = (connection = pool) => validateLiveConfig(connection, liveEnabledAt);
  return {
    assertConfig,
    async acceptForm(body) {
      let fields;
      try { fields = decodeBody(body); } catch { throw new LiveInputError('Некорректное событие'); }
      // Проверять секрет до любого обращения к БД; его и тело не логируем.
      let suppliedToken, suppliedDomain, suppliedMember, eventName, dealId;
      try {
        suppliedToken = one(fields, 'auth[application_token]');
        suppliedDomain = one(fields, 'auth[domain]');
        suppliedMember = one(fields, 'auth[member_id]');
        eventName = one(fields, 'event');
      } catch { throw new LiveInputError('Некорректное событие'); }
      if (!tokenEqual(expectedHash, suppliedToken) || suppliedDomain.toLowerCase() !== expectedDomain
          || suppliedMember !== memberId) throw new LiveAuthError('Событие не прошло проверку');
      if (eventName !== 'ONCRMDEALUPDATE') return { status: 'ignored' };
      try { dealId = Number(positiveId(one(fields, 'data[FIELDS][ID]'))); }
      catch { throw new LiveInputError('Некорректное событие'); }
      await assertConfig();
      const id = uuid(createId());
      await pool.query(`INSERT INTO public.lost_bitrix_events (id, deal_id) VALUES ($1, $2)`, [id, dealId]);
      return { status: 'accepted', eventId: id };
    },
    async recoverExpired() {
      await assertConfig();
      const result = await pool.query(`UPDATE public.lost_bitrix_events
        SET status='pending',lease_token=NULL,lease_until=NULL,updated_at=now()
        WHERE status='processing' AND lease_until<=now() RETURNING id`);
      return result.rows.length;
    },
    async claim() {
      await assertConfig();
      const token = uuid(createId());
      const result = await pool.query(`WITH candidate AS (
          SELECT id FROM public.lost_bitrix_events WHERE status='pending' AND available_at<=now()
          ORDER BY available_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
        ) UPDATE public.lost_bitrix_events e SET status='processing',lease_token=$1,
          lease_until=now()+make_interval(secs=>$2::double precision),attempts=attempts+1,updated_at=now()
        FROM candidate WHERE e.id=candidate.id RETURNING e.*`, [token, leaseSeconds]);
      return result.rows[0] || null;
    },
    async renew(id, token) {
      await assertConfig();
      const result = await pool.query(`UPDATE public.lost_bitrix_events
        SET lease_until=now()+make_interval(secs=>$3::double precision),updated_at=now()
        WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp() RETURNING id`,
      [uuid(id), uuid(token), leaseSeconds]);
      return result.rows.length === 1;
    },
    async retry(id, token) {
      await assertConfig();
      const result = await pool.query(`UPDATE public.lost_bitrix_events
        SET status='pending',lease_token=NULL,lease_until=NULL,
          available_at=now()+make_interval(secs=>$3::double precision),updated_at=now()
        WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp() RETURNING id`,
      [uuid(id), uuid(token), retrySeconds]);
      return result.rows.length === 1;
    },
    /** Запись job и завершение события — в одной транзакции с проверкой lease. */
    async finish(id, token, transition) {
      uuid(id); uuid(token);
      await assertConfig();
      const connection = await pool.connect();
      let poison = null;
      let outcome = 'ignored';
      try {
        await connection.query('BEGIN');
        try {
          await assertConfig(connection);
          const locked = await connection.query(`SELECT deal_id FROM public.lost_bitrix_events
            WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp() FOR UPDATE`, [id, token]);
          if (locked.rows.length !== 1) throw new Error('Аренда события утрачена');
          const dealId = Number(locked.rows[0].deal_id);
          if (transition) {
            const historyId = positiveId(transition.historyId, 10n ** 30n - 1n);
            const date = new Date(transition.loseDate);
            if (!transition.loseDate || !Number.isFinite(date.getTime())) throw new Error('Некорректная дата отказа');
            // Текущая LOSE-сделка могла закрыться ещё до подключения нового
            // триггера; её редактирование не должно создавать живой повтор.
            if (date.getTime() >= enabledAtMs) {
              const queue = createJobQueue(connection);
              await queue.enqueue({ requestKey: `bitrix24:deal-stage-history:${historyId}`, dealId,
                loseDate: date.toISOString(), triggerType: 'live', silent: false, screenshots: true });
              outcome = 'queued';
            }
          }
          const finished = await connection.query(`UPDATE public.lost_bitrix_events SET status='done',outcome=$3,
            lease_token=NULL,lease_until=NULL,updated_at=now()
            WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp() RETURNING id`,
          [id, token, outcome]);
          if (finished.rows.length !== 1) throw new Error('Аренда события утрачена');
        } catch (error) {
          try { await connection.query('ROLLBACK'); } catch (rollbackError) { poison = rollbackError; }
          throw error;
        }
        try { await connection.query('COMMIT'); }
        catch (error) { poison = error; throw new Error('EVENT_COMMIT_OUTCOME_UNKNOWN'); }
        return outcome;
      } finally { connection.release(poison || undefined); }
    },
  };
}

/** Последний переход в отказ; ошибки или неполная история не означают отказа нет. */
export async function readCurrentTransition(bitrix, dealId) {
  if (!bitrix || typeof bitrix.request !== 'function') throw new TypeError('Нужен клиент Битрикса');
  const id = Number(positiveId(dealId));
  const deal = await bitrix.request('crm.deal.get', { id });
  const stage = deal?.result?.STAGE_ID;
  if (typeof stage !== 'string' || !stage) throw new Error('Неизвестна стадия сделки');
  if (stage !== 'C23:LOSE') return null;
  const response = await bitrix.request('crm.stagehistory.list', {
    entityTypeId: 2, filter: { OWNER_ID: id }, order: { CREATED_TIME: 'DESC' },
    select: ['ID', 'STAGE_ID', 'CREATED_TIME'], start: 0,
  });
  const items = Array.isArray(response?.result) ? response.result : response?.result?.items;
  if (!Array.isArray(items) || !items[0] || typeof items[0].STAGE_ID !== 'string') throw new Error('Некорректная история стадий');
  // Карточка может обновиться раньше истории; искать прежний LOSE дальше
  // нельзя: это потеряет событие текущего перехода из-за дедупликации.
  const event = items[0];
  if (event.STAGE_ID !== 'C23:LOSE') throw new Error('История ещё не подтверждает текущую стадию');
  const historyId = positiveId(event.ID, 10n ** 30n - 1n);
  const date = new Date(event.CREATED_TIME);
  if (!event.CREATED_TIME || !Number.isFinite(date.getTime())) throw new Error('Некорректная дата перехода');
  return { historyId, loseDate: date.toISOString() };
}

/** Обрабатывает только захваченное событие; технический сбой переводится на повтор. */
export async function processLiveEvent({ inbox, event, bitrix }) {
  if (!inbox?.finish || !inbox?.retry || !inbox?.assertConfig || !event?.id || !event?.lease_token) throw new TypeError('Не задано захваченное событие');
  await inbox.assertConfig();
  let transition;
  try { transition = await readCurrentTransition(bitrix, event.deal_id); }
  catch {
    if (!await inbox.retry(event.id, event.lease_token)) throw new Error('Аренда события утрачена');
    return { status: 'retry' };
  }
  // При сбое БД, включая неизвестный COMMIT, не предполагаем результат и не
  // пытаемся повторить здесь: восстановление очереди выполнит это безопасно.
  const status = await inbox.finish(event.id, event.lease_token, transition);
  if (!['queued', 'ignored'].includes(status)) throw new Error('Неизвестный результат сохранения события');
  return { status };
}
