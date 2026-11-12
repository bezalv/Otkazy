import { buildBitrixComment } from './comment.mjs';
import { createHash } from 'node:crypto';

const productionRecipients = [65, 26175, 19601];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ids(job, lease) {
  if (!uuid.test(job || '') || !uuid.test(lease || '')) throw new TypeError('Некорректная аренда');
}

async function transaction(pool, action) {
  const connection = await pool.connect();
  let committing = false;
  let discard = false;
  try {
    await connection.query('BEGIN');
    const value = await action(connection);
    committing = true;
    await connection.query('COMMIT');
    committing = false;
    return value;
  } catch (error) {
    if (committing) {
      discard = true;
      throw new Error('DELIVERY_COMMIT_OUTCOME_UNKNOWN');
    }
    try { await connection.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { connection.release(discard ? new Error('Состояние сессии неизвестно') : undefined); }
}

async function lockJob(connection, jobId, lease) {
  const res = await connection.query(`SELECT j.*, a.id AS analysis_id, a.ai_judge_json, a.pipeline_error,
      a.prompt_version, d.title FROM public.lost_processing_jobs j
      JOIN public.lost_deal_analyses a ON a.pipeline_operation_id=j.id
      LEFT JOIN public.lost_deals d ON d.deal_id=j.deal_id
      WHERE j.id=$1 AND j.status='processing' AND j.lease_token=$2
        AND j.lease_until>clock_timestamp() FOR UPDATE OF j`, [jobId, lease]);
  if (res.rows.length !== 1) throw new Error('Результат или действующая аренда не найдены');
  const row = res.rows[0];
  if (row.pipeline_error || !row.ai_judge_json || !['правомерен', 'неправомерен', 'недостаточно_данных'].includes(row.ai_judge_json.verdict)) {
    throw new Error('Результат непригоден для отправки');
  }
  return row;
}

async function fencedUpdate(connection, jobId, lease, set, values = []) {
  // set составлен только из литералов ниже, данные передаются параметрами.
  const r = await connection.query(`UPDATE public.lost_processing_jobs SET ${set}, updated_at=now()
    WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp() RETURNING id`, [jobId, lease, ...values]);
  if (r.rows.length !== 1) throw new Error('Аренда истекла');
}

export function createDelivery(pool, client, { now = () => Date.now(), mode = 'production' } = {}) {
  if (!pool || typeof pool.connect !== 'function' || !client || typeof client.request !== 'function') throw new TypeError('Нужны PostgreSQL и клиент Битрикса');
  if (!['production', 'pilot65'].includes(mode)) throw new TypeError('Неизвестный режим доставки');
  const pilot = mode === 'pilot65', recipients = pilot ? [65] : productionRecipients;
  const notificationKey = pilot ? 'pilot_notification' : 'notification';
  const notificationPath = pilot ? '{pilot_notification}' : '{notification}';

  function notificationMessage(row) {
    const judge = row.ai_judge_json;
    const header = pilot ? `🧪 Отказы: ${judge.verdict}` : judge.verdict === 'неправомерен' ? '🔴 Неправомерный отказ' : '💰 Отказ по цене — возможен возврат спецпредложением';
    if (pilot) {
      const reason = typeof judge.exact_reason === 'string' ? judge.exact_reason.trim().slice(0, 2000) : '';
      return `${header}\nСделка #${row.deal_id}\n${judge.verdict_reason_short || ''}${reason ? `\n${reason}` : ''}\nhttps://dinalnsk.bitrix24.ru/crm/deal/details/${row.deal_id}/`;
    }
    return `${header}\nСделка: ${row.title || ''} (#${row.deal_id})\n${judge.verdict_reason_short || ''}\nhttps://dinalnsk.bitrix24.ru/crm/deal/details/${row.deal_id}/`;
  }

  async function claimComment(jobId, lease) {
    return transaction(pool, async db => {
      const row = await lockJob(db, jobId, lease);
      if (row.silent) {
        await fencedUpdate(db, jobId, lease, "comment_state='skipped', notify_state='skipped'");
        return { state: 'skipped' };
      }
      if (pilot) {
        if (row.comment_state === 'pending') await fencedUpdate(db, jobId, lease, "comment_state='skipped'");
        return { state: row.comment_state === 'pending' ? 'skipped' : row.comment_state };
      }
      if (row.comment_state === 'sending') {
        await fencedUpdate(db, jobId, lease, "comment_state='unknown', status='needs_review', lease_token=NULL, lease_until=NULL");
        return { state: 'unknown' };
      }
      if (row.comment_state !== 'pending') return { state: row.comment_state };
      const body = buildBitrixComment({ deal_id: row.deal_id, prompt_version: row.prompt_version, multi_agent_analysis: row.ai_judge_json }, now());
      // Хеш и время позволяют сверить возможную отправку без записи текста в очередь.
      // Несовпадение не доказывает отсутствие комментария: Битрикс может изменить текст.
      const digest = createHash('sha256').update(body.fields.COMMENT, 'utf8').digest('hex');
      await fencedUpdate(db, jobId, lease, "comment_state='sending', comment_sha256=$3, comment_attempted_at=clock_timestamp()", [digest]);
      return { state: 'send', body };
    });
  }

  async function markComment(jobId, lease, commentId) {
    return transaction(pool, async db => {
      const row = await lockJob(db, jobId, lease);
      if (row.comment_state !== 'sending') throw new Error('Комментарий не ожидает подтверждения');
      if (commentId == null) await fencedUpdate(db, jobId, lease, "comment_state='unknown', status='needs_review', lease_token=NULL, lease_until=NULL");
      else await fencedUpdate(db, jobId, lease, "comment_state='ok', comment_id=$3", [String(commentId)]);
    });
  }

  async function claimNotification(jobId, lease) {
    return transaction(pool, async db => {
      const row = await lockJob(db, jobId, lease);
      if (row.silent) {
        await fencedUpdate(db, jobId, lease, "notify_state='skipped'");
        return { state: 'skipped' };
      }
      if (row.comment_state !== (pilot ? 'skipped' : 'ok')) throw new Error('Комментарий ещё не подтверждён');
      const judge = row.ai_judge_json;
      const verdict = judge.verdict, closure = judge.closure_reason_class;
      if (row.notify_state === 'sending') {
        const notification = judge[notificationKey] || {};
        if (!notification.recipient_states || !Array.isArray(notification.delivered) || !Array.isArray(notification.failed)
            || recipients.some(id => !['pending', 'sending', 'ok', 'unknown'].includes(notification.recipient_states[id]))) {
          await fencedUpdate(db, jobId, lease, "notify_state='unknown', status='needs_review', lease_token=NULL, lease_until=NULL");
          return { state: 'unknown' };
        }
        // Неподтверждённый вызов мог дойти до Битрикса: помечаем его и продолжаем только pending.
        for (const id of recipients) {
          if (notification.recipient_states[id] === 'sending') {
            notification.recipient_states[id] = 'unknown';
            notification.failed.push({ user_id: id, error: 'неоднозначный результат отправки' });
          }
        }
        await db.query(`UPDATE public.lost_deal_analyses SET ai_judge_json=jsonb_set(coalesce(ai_judge_json, '{}'::jsonb), '${notificationPath}', $2::jsonb, true) WHERE id=$1`, [row.analysis_id, JSON.stringify(notification)]);
        await fencedUpdate(db, jobId, lease, "notify_state='sending'");
        return { state: 'send', message: notificationMessage(row) };
      }
      if (row.notify_state !== 'pending') return { state: row.notify_state };
      if (!pilot && verdict !== 'неправомерен' && !(verdict === 'правомерен' && closure === 'price')) {
        await fencedUpdate(db, jobId, lease, "notify_state='skipped'");
        return { state: 'skipped' };
      }
      // Сериализация разных задач одной сделки и вердикта, включая предыдущие обработки.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`lost-notify:${row.deal_id}:${verdict}`]);
      const previous = pilot ? { rows: [] } : await db.query(`SELECT ai_judge_json->'${notificationKey}'->>'status' AS state
        FROM public.lost_deal_analyses WHERE deal_id=$1
          AND (ai_judge_json->>'verdict'=$2 OR ai_verdict=$2)
          AND ai_judge_json->'${notificationKey}'->>'status' IN ('ok','sending','unknown')`, [row.deal_id, verdict]);
      if (previous.rows.some(item => item.state === 'ok')) {
        await fencedUpdate(db, jobId, lease, "notify_state='skipped'");
        return { state: 'skipped' };
      }
      if (previous.rows.length) {
        await fencedUpdate(db, jobId, lease, "notify_state='unknown', status='needs_review', lease_token=NULL, lease_until=NULL");
        return { state: 'unknown' };
      }
      const mark = JSON.stringify({ status: 'sending', recipients, delivered: [], failed: [], recipient_states: Object.fromEntries(recipients.map(id => [id, 'pending'])) });
      await db.query(`UPDATE public.lost_deal_analyses SET ai_judge_json=jsonb_set(coalesce(ai_judge_json, '{}'::jsonb), '${notificationPath}', $2::jsonb, true) WHERE id=$1`, [row.analysis_id, mark]);
      await fencedUpdate(db, jobId, lease, "notify_state='sending'");
      return { state: 'send', message: notificationMessage(row) };
    });
  }

  async function claimRecipient(jobId, lease, userId) {
    return transaction(pool, async db => {
      const row = await lockJob(db, jobId, lease);
      const mark = row.ai_judge_json[notificationKey];
      if (row.notify_state !== 'sending' || !mark?.recipient_states) throw new Error('Некорректное состояние уведомления');
      if (mark.recipient_states[userId] !== 'pending') return false;
      mark.recipient_states[userId] = 'sending';
      await db.query(`UPDATE public.lost_deal_analyses SET ai_judge_json=jsonb_set(coalesce(ai_judge_json, '{}'::jsonb), '${notificationPath}', $2::jsonb, true) WHERE id=$1`, [row.analysis_id, JSON.stringify(mark)]);
      await fencedUpdate(db, jobId, lease, "notify_state='sending'");
      return true;
    });
  }

  async function recordNotificationAttempt(jobId, lease, userId, delivered) {
    return transaction(pool, async db => {
      const row = await lockJob(db, jobId, lease);
      if (row.notify_state !== 'sending') throw new Error('Уведомление не ожидает подтверждения');
      const mark = row.ai_judge_json[notificationKey];
      if (!mark || !Array.isArray(mark.delivered) || !Array.isArray(mark.failed) || mark.recipient_states?.[userId] !== 'sending') throw new Error('Некорректное состояние уведомления');
      mark.recipient_states[userId] = delivered ? 'ok' : 'unknown';
      if (delivered) mark.delivered.push(userId);
      else mark.failed.push({ user_id: userId, error: 'неоднозначный результат отправки' });
      await db.query(`UPDATE public.lost_deal_analyses SET ai_judge_json=jsonb_set(coalesce(ai_judge_json, '{}'::jsonb), '${notificationPath}', $2::jsonb, true) WHERE id=$1`, [row.analysis_id, JSON.stringify(mark)]);
      await fencedUpdate(db, jobId, lease, "notify_state='sending'");
    });
  }

  async function markNotificationNotStarted(jobId, lease, userId) {
    return transaction(pool, async db => {
      const row = await lockJob(db, jobId, lease);
      const mark = row.ai_judge_json[notificationKey];
      if (row.notify_state !== 'sending' || mark?.recipient_states?.[userId] !== 'sending'
          || !Array.isArray(mark.failed)) throw new Error('Некорректное состояние уведомления');
      // Состояние получателя совместимо с существующим форматом; причина
      // отдельно фиксирует, что HTTP-вызов точно не начался.
      mark.recipient_states[userId] = 'unknown';
      mark.failed.push({ user_id: userId, error: 'запрос не был отправлен' });
      await db.query(`UPDATE public.lost_deal_analyses SET ai_judge_json=jsonb_set(coalesce(ai_judge_json, '{}'::jsonb), '${notificationPath}', $2::jsonb, true) WHERE id=$1`, [row.analysis_id, JSON.stringify(mark)]);
      await fencedUpdate(db, jobId, lease, "notify_state='sending'");
    });
  }

  async function markNotification(jobId, lease) {
    return transaction(pool, async db => {
      const row = await lockJob(db, jobId, lease);
      if (row.notify_state !== 'sending') throw new Error('Уведомление не ожидает подтверждения');
      const mark = row.ai_judge_json[notificationKey];
      if (!mark || !Array.isArray(mark.delivered) || !Array.isArray(mark.failed) || !mark.recipient_states
          || recipients.some(id => !['ok', 'unknown'].includes(mark.recipient_states[id]))) throw new Error('Уведомления ещё не обработаны');
      // Любой неуспешный сетевой ответ неоднозначен; не повторяем его автоматически.
      const state = mark.delivered.length ? 'ok' : 'unknown';
      mark.status = state;
      mark.sent_at = new Date(now()).toISOString();
      await db.query(`UPDATE public.lost_deal_analyses SET ai_judge_json=jsonb_set(coalesce(ai_judge_json, '{}'::jsonb), '${notificationPath}', $2::jsonb, true) WHERE id=$1`, [row.analysis_id, JSON.stringify(mark)]);
      if (state === 'ok') await fencedUpdate(db, jobId, lease, "notify_state='ok'");
      else await fencedUpdate(db, jobId, lease, "notify_state='unknown', status='needs_review', lease_token=NULL, lease_until=NULL");
      return state;
    });
  }

  async function finish(jobId, lease) {
    return transaction(pool, async db => {
      const row = await lockJob(db, jobId, lease);
      if (!['ok', 'skipped'].includes(row.comment_state) || !['ok', 'skipped'].includes(row.notify_state)) return false;
      await fencedUpdate(db, jobId, lease, "status='done', lease_token=NULL, lease_until=NULL");
      return true;
    });
  }

  async function stillSendingNotification(jobId, lease) {
    const db = await pool.connect();
    try {
      const r = await db.query(`SELECT id FROM public.lost_processing_jobs
        WHERE id=$1 AND lease_token=$2 AND status='processing' AND notify_state='sending'
          AND lease_until>clock_timestamp()`, [jobId, lease]);
      return r.rows.length === 1;
    } finally { db.release(); }
  }

  // Эта проверка запускается уже после получения слота ограничителя.
  // Между ответом БД и HTTP нет общей транзакции с Битриксом: при обрыве
  // после начала fetch результат по-прежнему считается неоднозначным.
  async function beforeDelivery(jobId, lease, action, userId) {
    if (pilot && action === 'comment') return false;
    const db = await pool.connect();
    try {
      const sql = action === 'comment'
        ? `SELECT id FROM public.lost_processing_jobs WHERE id=$1 AND lease_token=$2
            AND status='processing' AND lease_until>clock_timestamp() AND comment_state='sending'`
        : `SELECT j.id FROM public.lost_processing_jobs j
            JOIN public.lost_deal_analyses a ON a.pipeline_operation_id=j.id
            WHERE j.id=$1 AND j.lease_token=$2 AND j.status='processing'
              AND j.lease_until>clock_timestamp() AND j.notify_state='sending'
              AND a.ai_judge_json->'${notificationKey}'->'recipient_states'->>$3='sending'`;
      const r = await db.query(sql, action === 'comment' ? [jobId, lease] : [jobId, lease, String(userId)]);
      return r.rows.length === 1;
    } finally { db.release(); }
  }

  return {
    async deliver(jobId, lease) {
      ids(jobId, lease);
      const comment = await claimComment(jobId, lease);
      if (comment.state === 'send') {
        let id, notStarted = false;
        try {
          const response = await client.request('crm.timeline.comment.add', comment.body, {
            beforeSend: () => beforeDelivery(jobId, lease, 'comment'),
          });
          if ((typeof response.result === 'number' && Number.isSafeInteger(response.result) && response.result > 0)
              || (typeof response.result === 'string' && /^[1-9]\d*$/.test(response.result))) id = response.result;
        } catch (error) { notStarted = error?.requestStarted === false; }
        try { await markComment(jobId, lease, id); }
        catch (error) { if (!notStarted) throw error; }
        if (id == null) return { state: 'unknown', action: 'comment' };
      } else if (!['ok', 'skipped'].includes(comment.state)) return { state: comment.state, action: 'comment' };
      const notification = await claimNotification(jobId, lease);
      if (notification.state === 'send') {
        for (const userId of recipients) {
          // Утерявший аренду обработчик не начинает следующие сетевые вызовы.
          if (!await stillSendingNotification(jobId, lease)) return { state: 'unknown', action: 'notification' };
          if (!await claimRecipient(jobId, lease, userId)) continue;
          let delivered = false, notStarted = false;
          try {
            const response = await client.request('im.notify.system.add', { USER_ID: userId, MESSAGE: notification.message }, {
              beforeSend: () => beforeDelivery(jobId, lease, 'notification', userId),
            });
            delivered = response.result === true || (Number.isSafeInteger(Number(response.result)) && Number(response.result) > 0);
          } catch (error) { notStarted = error?.requestStarted === false; }
          if (notStarted) {
            // При утрате аренды новый владелец сам разберёт состояние.
            try { await markNotificationNotStarted(jobId, lease, userId); }
            catch { return { state: 'unknown', action: 'notification' }; }
            continue;
          }
          // Сохраняем каждое подтверждение прежде, чем начать следующий вызов.
          await recordNotificationAttempt(jobId, lease, userId, delivered);
        }
        if (await markNotification(jobId, lease) === 'unknown') return { state: 'unknown', action: 'notification' };
      } else if (!['ok', 'skipped'].includes(notification.state)) return { state: notification.state, action: 'notification' };
      return { state: await finish(jobId, lease) ? 'done' : 'unknown' };
    },
  };
}
