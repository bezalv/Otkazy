import { pgSafeReason } from '../rules/pipeline-gate.mjs';
import { baseDealRow, processedRows, communicationRow, safeErrorUsageMeta } from './rows.mjs';
import { inTransaction, CommitOutcomeUnknownError } from './transaction.mjs';
import { revalidateRoleInferenceMetadata, markRoleUsageUnknown } from '../worker/role-inference-metadata.mjs';
import { verifyRoleOrigin } from '../worker/role-origin.mjs';

export { CommitOutcomeUnknownError };

const DEAL_COMMON_UPDATES = [
  'title', 'opportunity', 'date_modify', 'stage_id', 'stage_name', 'previous_stage_id',
  'previous_stage_name', 'stage_history_count', 'lose_reason_id', 'lose_reason',
  'utm_source', 'utm_medium', 'utm_campaign',
];
const DEAL_ANALYSIS_UPDATES = [
  'pause_reason_id', 'pause_reason', 'pause_date', 'deferred_until', 'days_until_deferred',
  'comm_total_events', 'comm_calls', 'comm_calls_with_audio', 'comm_comments', 'comm_chat_messages',
  'comm_tasks', 'comm_chats_count', 'trans_calls_transcribed', 'trans_calls_failed',
  'last_ai_reason_class', 'last_ai_maturity', 'last_ai_probability', 'last_ai_route', 'last_ai_misplaced',
  'last_ai_closure_correctness', 'last_ai_closure_reason_class', 'last_ai_recoverable_now',
  'last_ai_recovery_probability', 'last_ai_recovery_route', 'full_prompt_text', 'journal_text', 'comm_analytics',
];
const COMM_UPDATES = [
  'text_content', 'full_content', 'author_name', 'direction', 'call_duration_seconds',
  'transcript_formatted', 'transcript_manager_text', 'transcript_client_text',
  'transcript_replicas', 'transcript_status',
];
const COMM_PRESERVE = ['screenshot_files', 'screenshot_turns', 'screenshot_text', 'screenshot_extract_status'];

function insertStatement(table, row, { timestamps = [], conflict = '', returning = '' } = {}) {
  // Имена таблиц, колонок и SQL-фрагменты формируются только из кода приложения.
  const columns = [...Object.keys(row), ...timestamps];
  const values = Object.values(row).map((value) => typeof value === 'string' ? value.replace(/\0/g, '') : value);
  const placeholders = values.map((_, index) => `$${index + 1}`).concat(timestamps.map(() => 'NOW()'));
  return {
    text: `INSERT INTO public.${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})${conflict}${returning}`,
    values,
  };
}

function dealConflict(processed) {
  const fields = processed ? [...DEAL_COMMON_UPDATES, ...DEAL_ANALYSIS_UPDATES] : DEAL_COMMON_UPDATES;
  const assignments = fields.map((name) => `${name}=EXCLUDED.${name}`);
  for (const name of ['lose_date', 'days_in_lost', 'lead_id']) {
    assignments.push(`${name}=COALESCE(EXCLUDED.${name}, lost_deals.${name})`);
  }
  if (processed) {
    assignments.push('analysis_count=COALESCE(lost_deals.analysis_count, 0)+1', 'last_analyzed_at=NOW()');
  }
  assignments.push('updated_at=NOW()');
  return ` ON CONFLICT (deal_id) DO UPDATE SET ${assignments.join(', ')}`;
}

const commConflict = ' ON CONFLICT (deal_id, event_type, event_id) DO UPDATE SET '
  + COMM_UPDATES.map((name) => `${name}=EXCLUDED.${name}`).concat(
    COMM_PRESERVE.map((name) => `${name}=COALESCE(EXCLUDED.${name}, lost_deal_communications.${name})`),
    `transcript_engine=CASE
      WHEN (coalesce(EXCLUDED.transcript_formatted,'')='' AND coalesce(EXCLUDED.transcript_manager_text,'')=''
        AND coalesce(EXCLUDED.transcript_client_text,'')='')
        OR EXCLUDED.transcript_formatted IS DISTINCT FROM lost_deal_communications.transcript_formatted
        OR EXCLUDED.transcript_manager_text IS DISTINCT FROM lost_deal_communications.transcript_manager_text
        OR EXCLUDED.transcript_client_text IS DISTINCT FROM lost_deal_communications.transcript_client_text
      THEN EXCLUDED.transcript_engine
      ELSE COALESCE(EXCLUDED.transcript_engine, lost_deal_communications.transcript_engine) END`,
  ).join(', ');

function dealId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw new TypeError('Некорректный идентификатор сделки');
  return id;
}

function operationId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError('Не указан корректный идентификатор операции');
  }
  return value.toLowerCase();
}

async function findOperation(connection, id) {
  const response = await connection.query({
    text: 'SELECT id, deal_id, pipeline_error FROM public.lost_deal_analyses WHERE pipeline_operation_id=$1',
    values: [id],
  });
  const row = response.rows?.[0];
  return row ? { analysisId: row.id, dealId: Number(row.deal_id), status: row.pipeline_error == null ? 'processed' : 'error' } : null;
}

// Вызывается отдельно после COMMIT_OUTCOME_UNKNOWN и не запускает повтор записи.
export async function lookupOperation(pool, id) {
  const operation = operationId(id);
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Нужен пул PostgreSQL');
  const connection = await pool.connect();
  try {
    const response = await connection.query({
      text: `SELECT j.id AS job_id, j.deal_id, j.status AS job_status,
          a.id AS analysis_id, a.pipeline_error
        FROM public.lost_processing_jobs j
        LEFT JOIN public.lost_deal_analyses a ON a.pipeline_operation_id=j.id
        WHERE j.id=$1`,
      values: [operation],
    });
    const row = response.rows?.[0];
    return row ? {
      operationId: row.job_id,
      dealId: Number(row.deal_id),
      jobStatus: row.job_status,
      analysisId: row.analysis_id || null,
      analysisStatus: row.analysis_id ? (row.pipeline_error == null ? 'processed' : 'error') : null,
    } : null;
  } finally {
    connection.release();
  }
}

/**
 * Проверяет действующую аренду перед повторным запуском и возвращает уже
 * сохранённый разбор. Вызывающий может продолжить внешние действия без LLM.
 * Успешное чтение не занимает право на отправку комментария или уведомления.
 */
export async function loadResumableResult(pool, { operation_id, lease_token, allowPilotError = false }) {
  if (typeof allowPilotError !== 'boolean') throw new TypeError('Некорректный режим уведомления');
  const operation = operationId(operation_id);
  const lease = operationId(lease_token);
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Нужен пул PostgreSQL');
  const connection = await pool.connect();
  try {
    const response = await connection.query({
      text: `SELECT j.deal_id, j.silent, j.screenshots, a.id AS analysis_id,
          a.pipeline_error, a.prompt_version, a.ai_judge_json, d.title
        FROM public.lost_processing_jobs j
        LEFT JOIN public.lost_deal_analyses a ON a.pipeline_operation_id=j.id
        LEFT JOIN public.lost_deals d ON d.deal_id=j.deal_id
        WHERE j.id=$1 AND j.status='processing' AND j.lease_token=$2
          AND j.lease_until>clock_timestamp()`,
      values: [operation, lease],
    });
    if (response.rowCount !== 1 || !response.rows?.[0]) throw new Error('Задача не принадлежит этому обработчику или аренда истекла');
    const row = response.rows[0];
    if (!row.analysis_id) return null;
    if (row.pipeline_error && allowPilotError && row.silent !== true) return {
      analysisId: row.analysis_id, silent:false, screenshots:row.screenshots === true,
      result:{deal_id:Number(row.deal_id),pipeline_error:row.pipeline_error},
    };
    if (row.pipeline_error || !row.ai_judge_json || typeof row.ai_judge_json !== 'object'
      || !['правомерен', 'неправомерен', 'недостаточно_данных'].includes(row.ai_judge_json.verdict)) {
      throw new Error('Сохранённый результат не пригоден для внешних действий');
    }
    return {
      analysisId: row.analysis_id,
      silent: row.silent === true,
      screenshots: row.screenshots === true,
      result: {
        deal_id: Number(row.deal_id),
        title: row.title || '',
        prompt_version: row.prompt_version,
        multi_agent_analysis: row.ai_judge_json,
      },
    };
  } finally {
    connection.release();
  }
}

function requireDeal(result, id) {
  if (!result.deal_data || dealId(result.deal_data.deal_id) !== id) throw new TypeError('Карточка не соответствует сделке');
  return { ...result.deal_data, deal_id: id };
}

async function saveWaiting(connection, result, id) {
  const queue = result.audio_wait;
  if (!queue || !queue.lose_date || !queue.first_seen_at || !queue.deadline_at || !queue.next_check_at
    || !Array.isArray(queue.pending_calls) || !queue.observations || typeof queue.observations !== 'object'
    || typeof queue.origin_stage_history_id !== 'string' || !/^[1-9]\d{0,29}$/.test(queue.origin_stage_history_id)) {
    throw new TypeError('Некорректное состояние ожидания записи');
  }
  const response = await connection.query({
    text: `INSERT INTO public.lost_audio_wait
      (deal_id, lose_date, state, first_seen_at, deadline_at, next_check_at, pending_calls, observations, silent, screenshots, origin_stage_history_id, checks, updated_at)
      VALUES ($1, $2, 'waiting', $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, 1, NOW())
      ON CONFLICT (deal_id) DO UPDATE SET
        lose_date=EXCLUDED.lose_date, state='waiting', first_seen_at=EXCLUDED.first_seen_at,
        deadline_at=EXCLUDED.deadline_at, next_check_at=EXCLUDED.next_check_at,
        pending_calls=EXCLUDED.pending_calls, observations=EXCLUDED.observations,
        silent=EXCLUDED.silent, screenshots=EXCLUDED.screenshots, origin_stage_history_id=EXCLUDED.origin_stage_history_id,
        checks=lost_audio_wait.checks+1, lease_until=NULL, updated_at=NOW()
      WHERE (lost_audio_wait.state='waiting' AND lost_audio_wait.lose_date=EXCLUDED.lose_date
        AND lost_audio_wait.origin_stage_history_id=EXCLUDED.origin_stage_history_id)
         OR (lost_audio_wait.lose_date < EXCLUDED.lose_date
           AND NOT (lost_audio_wait.state='waiting' AND lost_audio_wait.origin_stage_history_id IS NULL))
      RETURNING deal_id`,
    values: [id, queue.lose_date, queue.first_seen_at, queue.deadline_at, queue.next_check_at,
      JSON.stringify(queue.pending_calls), JSON.stringify(queue.observations), result.silent === true, result.audio_wait_screenshots === true, queue.origin_stage_history_id],
  });
  if (response.rowCount !== 1) throw new Error('Состояние очереди аудио изменилось');
}

async function finishWaiting(connection, result, id) {
  if (!result.audio_wait) return;
  const queue = result.audio_wait;
  if (!queue.lose_date || !queue.first_seen_at || !queue.deadline_at || !queue.next_check_at
    || !Array.isArray(queue.pending_calls) || !queue.observations || typeof queue.observations !== 'object'
    || typeof queue.origin_stage_history_id !== 'string' || !/^[1-9]\d{0,29}$/.test(queue.origin_stage_history_id)) {
    throw new TypeError('Некорректное состояние очереди аудио');
  }
  const state = result.audio_wait_expired === true ? 'expired' : 'done';
  const response = await connection.query({
    text: `UPDATE public.lost_audio_wait SET state=$1, first_seen_at=$4, deadline_at=$5, next_check_at=$6,
        pending_calls=$7::jsonb, observations=$8::jsonb, silent=$9, screenshots=$10,
        checks=checks+1, lease_until=NULL, updated_at=NOW()
      WHERE deal_id=$2 AND lose_date=$3 AND state='waiting' AND origin_stage_history_id=$11 RETURNING deal_id`,
    values: [state, id, queue.lose_date, queue.first_seen_at, queue.deadline_at, queue.next_check_at,
      JSON.stringify(queue.pending_calls), JSON.stringify(queue.observations), result.silent === true, result.audio_wait_screenshots === true, queue.origin_stage_history_id],
  });
  if (response.rowCount !== 1) throw new Error('Не удалось завершить ожидающую запись');
}

async function cancelWaiting(connection, id, loseDate, historyId) {
  if (historyId == null) return;
  if (typeof historyId !== 'string' || !/^[1-9]\d{0,29}$/.test(historyId)) throw new TypeError('Некорректный ID ожидания аудио');
  await connection.query({
    text: "UPDATE public.lost_audio_wait SET state='cancelled', lease_until=NULL, updated_at=NOW() WHERE deal_id=$1 AND lose_date=$2 AND state='waiting' AND origin_stage_history_id=$3",
    values: [id, loseDate, historyId],
  });
}

// Не изменяем более новую проверку или другую итерацию отказа. Ключ должен
// совпасть с ключом планировщика, который создал именно это задание.
async function rescheduleFailedAudioCheck(connection, job, id) {
  await connection.query({
    text: `WITH retry_clock AS (SELECT clock_timestamp() AS at)
      UPDATE public.lost_audio_wait w
      SET next_check_at=CASE WHEN w.deadline_at > retry_clock.at
            THEN LEAST(retry_clock.at + interval '5 minutes', w.deadline_at)
            ELSE retry_clock.at + interval '15 minutes' END,
          updated_at=retry_clock.at
      FROM retry_clock
      WHERE w.deal_id=$1 AND w.lose_date=$2 AND w.state='waiting'
        AND w.next_check_at <= retry_clock.at
        AND $3 = 'audio-wait:' || w.deal_id::text || ':' ||
          (extract(epoch from w.lose_date) * 1000000)::bigint::text || ':' ||
          (extract(epoch from w.next_check_at) * 1000000)::bigint::text`,
    values: [id, job.lose_date, job.request_key],
  });
}

// Ошибка авторства не исправится ожиданием записи. Завершать можно только то
// ожидание, которому принадлежало задание, не затрагивая новый переход.
async function cancelAmbiguousAudioCheck(connection, job, id, historyId) {
  if (typeof historyId !== 'string' || !/^[1-9]\d{0,29}$/.test(historyId)) {
    throw new TypeError('Неизвестен исходный переход ожидания аудио');
  }
  const response = await connection.query({
    text: `UPDATE public.lost_audio_wait w SET state='cancelled', lease_until=NULL, updated_at=NOW()
      WHERE w.deal_id=$1 AND w.lose_date=$2 AND w.state='waiting' AND w.origin_stage_history_id=$4
        AND $3 = 'audio-wait:' || w.deal_id::text || ':' ||
          (extract(epoch from w.lose_date) * 1000000)::bigint::text || ':' ||
          (extract(epoch from w.next_check_at) * 1000000)::bigint::text
      RETURNING w.deal_id`,
    values: [id, job.lose_date, job.request_key, historyId],
  });
  if (response.rowCount !== 1) throw new Error('Ожидание аудио изменилось до завершения');
}

// Снимок существует только если содержательная старая запись будет изменена.
// FOR UPDATE удерживает текущую строку до той же транзакции записи результата.
async function archiveCommunication(connection, operation, id, row) {
  await connection.query({
    text: `WITH previous AS (
        SELECT event_type,event_id,full_content,transcript_formatted,transcript_manager_text,
          transcript_client_text,transcript_replicas,transcript_status,transcript_engine,event_date
        FROM public.lost_deal_communications
        WHERE deal_id=$2 AND event_type=$3 AND event_id=$4 FOR UPDATE
      )
      INSERT INTO public.lost_overwrite_history (operation_id,deal_id,record_type,event_type,event_id,previous_values)
      SELECT $1,$2,'communication',event_type,event_id,
        jsonb_build_object('event_date',event_date,'full_content',full_content,
          'transcript_formatted',transcript_formatted,'transcript_manager_text',transcript_manager_text,
          'transcript_client_text',transcript_client_text,'transcript_replicas',transcript_replicas,
          'transcript_status',transcript_status,'transcript_engine',transcript_engine)
      FROM previous
      WHERE (coalesce(btrim(transcript_formatted),'') <> '' OR coalesce(btrim(transcript_manager_text),'') <> ''
          OR coalesce(btrim(transcript_client_text),'') <> '')
        AND (full_content IS DISTINCT FROM $5 OR transcript_formatted IS DISTINCT FROM $6
          OR transcript_manager_text IS DISTINCT FROM $7 OR transcript_client_text IS DISTINCT FROM $8
          OR transcript_replicas IS DISTINCT FROM $9 OR transcript_status IS DISTINCT FROM $10
          OR ($11::text IS NOT NULL AND transcript_engine IS DISTINCT FROM $11))
      ON CONFLICT (operation_id,record_type,event_type,event_id) DO NOTHING`,
    values: [operation, id, row.event_type, row.event_id, row.full_content, row.transcript_formatted,
      row.transcript_manager_text, row.transcript_client_text, row.transcript_replicas, row.transcript_status, row.transcript_engine],
  });
}

async function archiveExpiredCard(connection, operation, id) {
  await connection.query({
    text: `WITH previous AS (
        SELECT lose_date,last_analyzed_at,analysis_count,comm_total_events,comm_calls,comm_calls_with_audio,
          comm_comments,comm_chat_messages,comm_tasks,comm_chats_count,trans_calls_transcribed,trans_calls_failed,
          full_prompt_text,journal_text,comm_analytics,last_ai_probability,last_ai_misplaced,last_ai_recovery_probability,
          last_ai_reason_class,last_ai_maturity,last_ai_route,last_ai_closure_correctness,last_ai_closure_reason_class,
          last_ai_recoverable_now,last_ai_recovery_route
        FROM public.lost_deals WHERE deal_id=$2 FOR UPDATE
      )
      INSERT INTO public.lost_overwrite_history (operation_id,deal_id,record_type,previous_values)
      SELECT $1,$2,'card',jsonb_build_object('lose_date',lose_date,'last_analyzed_at',last_analyzed_at,
        'analysis_count',analysis_count,'comm_total_events',comm_total_events,'comm_calls',comm_calls,
        'comm_calls_with_audio',comm_calls_with_audio,'comm_comments',comm_comments,'comm_chat_messages',comm_chat_messages,
        'comm_tasks',comm_tasks,'comm_chats_count',comm_chats_count,'trans_calls_transcribed',trans_calls_transcribed,
        'trans_calls_failed',trans_calls_failed,'full_prompt_text',full_prompt_text,'journal_text',journal_text,
        'comm_analytics',comm_analytics,'last_ai_probability',last_ai_probability,
        'last_ai_misplaced',last_ai_misplaced,'last_ai_recovery_probability',last_ai_recovery_probability,
        'last_ai_reason_class',last_ai_reason_class,'last_ai_maturity',last_ai_maturity,'last_ai_route',last_ai_route,
        'last_ai_closure_correctness',last_ai_closure_correctness,'last_ai_closure_reason_class',last_ai_closure_reason_class,
        'last_ai_recoverable_now',last_ai_recoverable_now,'last_ai_recovery_route',last_ai_recovery_route) FROM previous
      ON CONFLICT (operation_id,record_type,event_type,event_id) DO NOTHING`,
    values: [operation, id],
  });
}

/**
 * Параметризованная запись результата одной сделки в существующие таблицы.
 * Никаких уведомлений и комментариев в Битрикс функция не отправляет.
 * Для записи обязательны id задачи и актуальный lease_token из очереди.
 */
export async function persistResult(pool, result, { allowPilotError = false } = {}) {
  if (typeof allowPilotError !== 'boolean') throw new TypeError('Некорректный режим уведомления');
  if (!result || typeof result !== 'object') throw new TypeError('Не получен результат сделки');
  // Изолируем поле до получения и блокировки настоящего задания. Входу не
  // доверяем: сопоставление делается только с данными заблокированной строки.
  let roleInput = result.role_inference_metadata;
  let analysisRoleUnaccounted = false;
  if (result.multi_agent_analysis && typeof result.multi_agent_analysis === 'object'
      && (Object.hasOwn(result.multi_agent_analysis, 'role_inference')
        || Object.hasOwn(result.multi_agent_analysis, 'role_inference_unaccounted'))) {
    const { role_inference:input, role_inference_unaccounted:unaccounted, ...analysis } = result.multi_agent_analysis;
    if (result._status === 'processed') roleInput = input;
    analysisRoleUnaccounted = unaccounted === true;
    result = { ...result, multi_agent_analysis:analysis };
  }
  result = { ...result };
  delete result.role_inference_metadata;
  const id = dealId(result.deal_id);
  const status = result._status;
  if (!['processed', 'error', 'skipped_by_reason', 'skipped', 'waiting_audio'].includes(status)) {
    throw new TypeError('Неизвестное состояние обработки');
  }
  const operation = operationId(result.operation_id);
  const lease = operationId(result.lease_token);
  const deal = ['processed', 'skipped_by_reason'].includes(status) ? requireDeal(result, id) : null;
  if (status === 'processed') {
    if (result.pipeline_error || result._error || !result.classification || !result.multi_agent_analysis
      || !['правомерен', 'неправомерен', 'недостаточно_данных'].includes(result.multi_agent_analysis.verdict)) {
      throw new TypeError('Неполный результат нельзя сохранять как успешный');
    }
    if (result.audio_wait_expired === true && result.multi_agent_analysis.verdict !== 'недостаточно_данных') {
      throw new TypeError('Истёкшее ожидание аудио не может содержать другой вердикт');
    }
    if (result.audio_wait_expired === true && !result.audio_wait) throw new TypeError('Не указана очередь истёкшего ожидания');
  }
  const comms = result.communications_with_transcripts ?? result.communications ?? deal?.communications ?? [];
  if (!Array.isArray(comms)) throw new TypeError('Некорректный список коммуникаций');
  if (result.audio_wait_expired === true && comms.length) throw new TypeError('Для истёкшего ожидания коммуникации не собирались');

  try {
    return await inTransaction(pool, async (connection) => {
    const locked = await connection.query({
      text: `SELECT deal_id, lose_date, silent, screenshots, trigger_type, request_key,
          to_jsonb(j)->>'origin_stage_history_id' AS origin_stage_history_id,
          to_char(lose_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS role_lose_date_exact
        FROM public.lost_processing_jobs j
        WHERE id=$1 AND deal_id=$2 AND status='processing' AND lease_token=$3
          AND lease_until>clock_timestamp() FOR UPDATE`,
      values: [operation, id, lease],
    });
    if (locked.rowCount !== 1 || !locked.rows?.[0]) throw new Error('Задача не принадлежит этому обработчику или аренда истекла');
    const job = locked.rows[0];
    const jobLoseMs = new Date(job.lose_date).getTime();
    if (job.lose_date == null || !Number.isFinite(jobLoseMs)) throw new Error('У задачи нет корректной даты отказа');
    for (const date of [deal?.lose_date, result.audio_wait?.lose_date]) {
      if (date != null && new Date(date).getTime() !== jobLoseMs) {
        throw new Error('Результат относится к другому переходу в отказ');
      }
    }
    const transition = typeof job.request_key === 'string'
      ? /^bitrix24:deal-stage-history:([1-9]\d{0,29})$/.exec(job.request_key)?.[1] : null;
    let roleTransition=transition;
    if (roleInput && result.role_origin_stage_history_id != null) {
      const candidate=result.role_origin_stage_history_id;
      const confirmed=typeof candidate==='string' && await verifyRoleOrigin(
        (text,values)=>connection.query({text,values}),
        {job,dealId:id,loseDate:job.role_lose_date_exact,stageHistoryId:candidate});
      // Переход мог измениться после оценки автора. Нельзя сохранять вердикт
      // или заявлять подтверждённый учёт по другому переходу.
      if (!confirmed) throw new Error('Не подтверждён переход определения авторов');
      roleTransition=candidate;
    }
    const role = revalidateRoleInferenceMetadata(roleInput,{jobId:operation,leaseToken:lease,dealId:String(id),
      stageHistoryId:roleTransition,cutoff:job.role_lose_date_exact});
    const roleUnaccounted = result.role_inference_unaccounted === true || analysisRoleUnaccounted || (!!roleInput && !role);
    const roleSpent = roleUnaccounted || (role?.model_calls > 0)
      || (role?.physical_requests_started > 0) || role?.uncertain_outcome === true;
    result = { ...result, silent: job.silent === true, audio_wait_screenshots: job.screenshots === true,
      ...(status === 'processed' && (role || roleUnaccounted) ? {multi_agent_analysis:{...result.multi_agent_analysis,
        ...(role ? {role_inference:role} : {}), ...(roleUnaccounted ? {role_inference_unaccounted:true} : {})}} : {}),
      ...(status === 'processed' && roleSpent ? {llm_meta:markRoleUsageUnknown(result.llm_meta,result.multi_agent_analysis)} : {}) };

    const save = async () => {
    if (['processed', 'error'].includes(status)) {
      // Блокировка сериализует наши параллельные записи с одним operation_id.
      await connection.query({ text: 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', values: [operation] });
      const existing = await findOperation(connection, operation);
      if (existing) {
        if (existing.dealId !== id || existing.status !== status) throw new Error('Операция уже относится к другому результату');
        return { status: 'already_committed', dealId: id, analysisId: existing.analysisId, recordedStatus: existing.status };
      }
    }
    if (status === 'error') {
      const message = pgSafeReason(result._error || result.pipeline_error || result._reason || 'неизвестная ошибка').slice(0, 1000);
      const meta = safeErrorUsageMeta(result.llm_meta);
      const errorMetadata = { ...(meta ? { proof_repair: meta.proof_repair, judge_usage: meta.judge_usage,
        judge_usage_known: meta.judge_usage_known, judge_usage_complete: meta.judge_usage_complete,
        usage_complete:roleSpent ? false : meta.usage_complete } : {}), ...(role ? { role_inference:role } : {}),
        ...(roleUnaccounted ? {role_inference_unaccounted:true} : {}) };
      const inserted = await connection.query(insertStatement('lost_deal_analyses', {
        deal_id: id, pipeline_error: message, prompt_version: result.prompt_version || 'v2.8-sol',
        trigger_type: ['live','audio_wait','manual','nightly','backfill'].includes(job.trigger_type) ? job.trigger_type : 'batch', processing_time_sec: Number(result.processing_time_sec) || 0,
        pipeline_operation_id: operation,
        ...(meta ? { llm_prompt_tokens: meta.prompt_tokens, llm_completion_tokens: meta.completion_tokens,
          llm_total_tokens: meta.total_tokens, judge_prompt_tokens: meta.judge_usage?.prompt_tokens ?? null,
          judge_completion_tokens: meta.judge_usage?.completion_tokens ?? null } : {}),
        // DEFAULT 0 не означает отсутствие расхода: при сбое роль могла
        // вызвать модель, а сведения о последующих стадиях неизвестны.
        ...(roleSpent ? { llm_prompt_tokens:null, llm_completion_tokens:null, llm_total_tokens:null } : {}),
        ...(roleSpent && !meta ? {
          judge_prompt_tokens:null, judge_completion_tokens:null } : {}),
        ...(roleSpent ? { writer_prompt_tokens:null, writer_completion_tokens:null } : {}),
        ...(meta || role || roleUnaccounted ? { ai_judge_json:JSON.stringify(errorMetadata) } : {}),
      }, { returning: ' RETURNING id' }));
      if (inserted.rowCount !== 1 || !inserted.rows?.[0]?.id) throw new Error('Не удалось сохранить сбой');
      if (job.trigger_type === 'audio_wait') {
        if (['author_ambiguous', 'chat_connector_unknown'].includes(result.error_kind)) {
          await cancelAmbiguousAudioCheck(connection, job, id, result.audio_origin_stage_history_id);
        } else {
          await rescheduleFailedAudioCheck(connection, job, id);
        }
      }
      return { status, dealId: id, analysisId: inserted.rows[0].id };
    }
    if (status === 'waiting_audio') {
      await saveWaiting(connection, result, id);
      return { status, dealId: id };
    }
    if (status === 'skipped') {
      await cancelWaiting(connection, id, job.lose_date, result.audio_origin_stage_history_id);
      return { status, dealId: id };
    }
    if (status === 'skipped_by_reason') {
      await connection.query(insertStatement('lost_deals', { ...baseDealRow(deal), analysis_count: 0 }, {
        timestamps: ['updated_at'], conflict: dealConflict(false),
      }));
      await cancelWaiting(connection, id, job.lose_date, result.audio_origin_stage_history_id);
      return { status, dealId: id };
    }
    const rows = processedRows(result, deal, comms);
    rows.analysis.trigger_type=['live','audio_wait','manual','nightly','backfill'].includes(job.trigger_type) ? job.trigger_type : 'batch';
    rows.analysis.pipeline_operation_id = operation;
    if (result.audio_wait_expired === true) await archiveExpiredCard(connection, operation, id);
    await connection.query(insertStatement('lost_deals', rows.deal, {
      timestamps: ['last_analyzed_at', 'updated_at'], conflict: dealConflict(true),
    }));
    const inserted = await connection.query(insertStatement('lost_deal_analyses', rows.analysis, { returning: ' RETURNING id' }));
    if (inserted.rowCount !== 1 || !inserted.rows?.[0]?.id) throw new Error('Не удалось сохранить анализ');
    for (let index = 0; index < comms.length; index++) {
      const communication = communicationRow(id, comms[index], index);
      await archiveCommunication(connection, operation, id, communication);
      await connection.query(insertStatement('lost_deal_communications', communication, { conflict: commConflict }));
    }
    await finishWaiting(connection, result, id);
    return { status, dealId: id, analysisId: inserted.rows[0].id };
    };
    const saved = await save();
    const needsExternalActions = (status === 'processed' || (allowPilotError && status === 'error')) && job.silent !== true;
    const finishQuery = needsExternalActions
      ? `SELECT id FROM public.lost_processing_jobs
          WHERE id=$1 AND status='processing' AND lease_token=$2 AND lease_until>clock_timestamp()`
      : `UPDATE public.lost_processing_jobs SET status='done', lease_token=NULL, lease_until=NULL, updated_at=NOW()
          WHERE id=$1 AND status='processing' AND lease_token=$2 AND lease_until>clock_timestamp() RETURNING id`;
    const finished = await connection.query({ text: finishQuery, values: [operation, lease] });
    if (finished.rowCount !== 1) throw new Error('Аренда задачи истекла до завершения записи');
    return { ...saved, needsExternalActions };
    });
  } catch (error) {
    if (error instanceof CommitOutcomeUnknownError && operation) error.operationId = operation;
    throw error;
  }
}
