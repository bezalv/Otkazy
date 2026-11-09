import { createHash } from 'node:crypto';
import { communicationRow } from './rows.mjs';
import { inTransaction } from './transaction.mjs';
import { verifiedAudioHash } from '../stt-client.mjs';

// Этот слой сохраняет только готовые результаты и не считает ID файла хешем
// аудио. Автоматическое повторное использование по одному ID запрещено.
export class PrejudgeStageError extends Error {
  constructor() { super('Не удалось сохранить материалы до анализа'); this.name = 'PrejudgeStageError'; }
}

const digest = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const transitionId = value => typeof value === 'string' && /^[1-9]\d{0,29}$/.test(value);
const secretParam = /(?:^|[-_])(token|key|secret|auth|password|passwd|signature|sig|credential|session|ticket|jwt)(?:$|[-_])|^(?:authorization|apikey|apiKey|accessToken|refreshToken|authId|oauth|code)$/i;
function cleanText(value) {
  return value.replace(/\0/g, '').replace(/https?:\/\/[^\s<>"\]\[]+/giu, matched => {
    const trailing = matched.match(/[.,!?;:]+$/u)?.[0] || '';
    const source = trailing ? matched.slice(0,-trailing.length) : matched;
    let url;
    try { url = new URL(source); } catch { return matched; }
    let changed = false;
    if (url.username || url.password) { url.username = 'hidden'; url.password = ''; changed = true; }
    const safePath = url.pathname.replace(/(\/rest\/\d+\/)[^/]+/giu, '$1[скрыто]');
    if (safePath !== url.pathname) { url.pathname = safePath; changed = true; }
    for (const key of [...new Set(url.searchParams.keys())]) {
      if (secretParam.test(key)) { url.searchParams.set(key,'[скрыто]'); changed = true; }
    }
    if (/(?:^|[&#])(?:access_token|refresh_token|token|auth|signature|sig|key)=/i.test(url.hash)) {
      url.hash = '#[скрыто]'; changed = true;
    }
    return changed ? url.toString() + trailing : matched;
  });
}
function safeJson(value, { redactUrls = true } = {}) {
  const encoded = JSON.stringify(value, (_, item) => typeof item === 'string'
    ? (redactUrls ? cleanText(item) : item.replace(/\0/g, '')) : item);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 20 * 1024 * 1024) throw new TypeError('Некорректные материалы');
  return JSON.parse(encoded);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

// Общая граница для изолированного ручного и штатного сохранения: даже при
// ошибке вызывающего сохранённый JSON проходит то же удаление секретов.
export function sanitizePrejudgeArtifact(artifact) {
  if (!artifact || !['begin', 'raw_collection', 'communications', 'transcript', 'judge_input', 'judge_result'].includes(artifact.type)
      || !/^[a-f0-9]{64}$/.test(artifact.key || '')) throw new PrejudgeStageError();
  try {
    const payload = safeJson(artifact.payload);
    return { type:artifact.type, key:artifact.key, payload, payloadSha256:digest(canonical(payload)) };
  } catch { throw new PrejudgeStageError(); }
}

/** Результат изолированного ручного прогона; старые рабочие таблицы не меняются. */
export function prepareManualJudgeResultArtifact(result) {
  const analysis = result?.analysis;
  if (result?.status !== 'processed' || !analysis || typeof analysis !== 'object'
      || !analysis.classification || typeof analysis.classification !== 'object'
      || !analysis.multi_agent_analysis || typeof analysis.multi_agent_analysis !== 'object'
      || !['правомерен','неправомерен','недостаточно_данных'].includes(analysis.multi_agent_analysis.verdict)
      || typeof analysis.multi_agent_analysis.final_comment !== 'string') throw new PrejudgeStageError();
  // Коммуникации уже отдельно сохранены через безопасную проекцию; их сырая
  // копия в анализе может содержать временные подписанные адреса аудио.
  const {communications: _communications, ...finalAnalysis} = analysis;
  const payload = safeJson({status:'processed', analysis:finalAnalysis,
    ...(result.chatRoleInferenceMetadata ? {chatRoleInferenceMetadata:result.chatRoleInferenceMetadata} : {}),
    ...(result.chatRoleInferenceUnaccounted ? {chatRoleInferenceUnaccounted:true} : {})});
  return {type:'judge_result',key:digest('manual-judge-result-v1'),payload};
}

export function transcriptSourceKey(request) {
  const identity = safeJson({ file_id: request?.file_id ?? null, activity_id: request?.activity_id ?? null,
    call_date: request?.call_date ?? null, call_direction: request?.call_direction ?? null,
    channel_count: Number(request?.channel_count), speaker_role: request?.speaker_role ?? null,
    require_audio_only: request?.require_audio_only === true, voice_file_snapshot: request?.voice_file_snapshot ?? null,
    download_url: /^\d+$/.test(String(request?.file_id ?? '')) ? null : request?.download_url ?? null }, {redactUrls:false});
  if (identity.file_id === null || identity.activity_id === null || ![1,2].includes(identity.channel_count)) throw new TypeError('Нет источника транскрипта');
  return digest(canonical(identity));
}

export function prepareTranscriptArtifact(request, result, { allowEmpty = false } = {}) {
  if (!request || !result || result.success !== true || typeof result.formatted_dialog !== 'string'
      || (!allowEmpty && !result.formatted_dialog.trim()) || ![1, 2].includes(Number(request.channel_count))) throw new TypeError('Неполный транскрипт');
  // URL может содержать credential и попадает только в SHA, не в payload.
  const identityKey = transcriptSourceKey(request);
  const audioSha = verifiedAudioHash(result,request);
  if (!result.formatted_dialog.trim() && !audioSha) throw new TypeError('Пустой ответ без подтверждения');
  const payload = safeJson({ status:audioSha ? 'verified_stt_response' : 'candidate_unvalidated', source: { file_id: request.file_id, activity_id: request.activity_id,
    call_date: request.call_date ?? null, channel_count: Number(request.channel_count), speaker_role: request.speaker_role ?? null,
    source_identity_sha256: identityKey, audio_bytes_sha256: audioSha },
    transcript: { formatted_dialog: result.formatted_dialog, manager_text: result.manager_text ?? '',
      client_text: result.client_text ?? '', total_replicas: result.total_replicas ?? 0,
      conversation: Array.isArray(result.conversation) ? result.conversation.map(item => ({
        id:typeof item?.id === 'number' ? item.id : null,
        speaker:typeof item?.speaker === 'string' ? item.speaker : null,
        text:typeof item?.text === 'string' ? item.text : null,
      })) : [], transcript_engine: result.transcript_engine ?? null, channel_count: result.channel_count ?? null,
      transcript_mode: result._transcript_mode ?? null,
      ...(result.transcription_coverage ? {transcription_coverage:result.transcription_coverage} : {}) } });
  // Разные версии аудио и результаты одного источника должны сосуществовать
  // в одном job; повтор идентичного ответа остаётся идемпотентным.
  return { type: 'transcript', key: digest(`${identityKey}:${audioSha || 'unverified'}:${digest(canonical(payload))}`), payload };
}

export function rehydrateVerifiedTranscript(payload, request, audioSha256, expectedEngine) {
  const key = transcriptSourceKey(request);
  const allowedEngines = Array.isArray(expectedEngine) ? expectedEngine : [expectedEngine];
  if (payload.status !== 'verified_stt_response' || payload.source?.source_identity_sha256 !== key
      || payload.source?.audio_bytes_sha256 !== audioSha256 || !allowedEngines.includes(payload.transcript?.transcript_engine)) return null;
  const t = payload.transcript;
  if (Number(t.channel_count) !== Number(request.channel_count) || typeof t.formatted_dialog !== 'string'
      || typeof t.manager_text !== 'string' || typeof t.client_text !== 'string'
      || !Array.isArray(t.conversation) || !Number.isSafeInteger(t.total_replicas)
      || t.total_replicas !== t.conversation.length || !t.conversation.every(x => Number.isSafeInteger(x.id)
        && typeof x.speaker === 'string' && typeof x.text === 'string')
      || (!t.formatted_dialog.trim() && (t.total_replicas !== 0 || t.manager_text || t.client_text))) throw new PrejudgeStageError();
  return { success:true, activity_id:request.activity_id, comm_index:request.comm_index,
    date:request.call_date, direction:request.call_direction, channel_count:t.channel_count,
    speaker_role:request.speaker_role || '', total_replicas:t.total_replicas, conversation:t.conversation,
    formatted_dialog:t.formatted_dialog, manager_text:t.manager_text, client_text:t.client_text,
    transcript_engine:t.transcript_engine, audio_sha256:audioSha256,
    ...(t.transcription_coverage ? {transcription_coverage:t.transcription_coverage}
      : t.transcript_engine === 'reserve:gigaam' ? {transcription_coverage:{version:0,status:'unknown_legacy'}} : {}),
    ...(t.transcript_mode === 'mono' ? {_transcript_mode:'mono'} : {}) };
}


export function prepareBeginArtifact({ sttAttempts = false } = {}) {
  return { type:'begin', key:digest('begin-v1'), payload:{state:'processing_started',...(sttAttempts ? {protocol_version:2} : {})} };
}

const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) ? value : null;
const items = value => value && typeof value === 'object' ? Object.entries(value) : [];
function fileIds(message) {
  const ids = message?.params?.FILE_ID || message?.params?.fileId || [];
  return [...new Set((Array.isArray(ids) ? ids : [ids])
    .filter(id => id != null && String(id) !== '' && String(id) !== '0').map(String))];
}

/** Ограниченная проекция входов ДО распознавания голосовых, без адресов файлов. */
export function prepareRawCollectionArtifact(collection) {
  const raw = collection?.raw;
  if (!raw || !['calls','comments','tasks','chats','sessions'].every(name => Array.isArray(raw[name]))) {
    throw new TypeError('Неполная коллекция');
  }
  const payload = safeJson({ projection:'safe_fields_only', url_policy:'credential_fields_redacted',
    calls:raw.calls.map(call => ({id:scalar(call.ID),created:scalar(call.CREATED),start:scalar(call.START_TIME),
      end:scalar(call.END_TIME),provider:scalar(call.PROVIDER_ID),direction:scalar(call.DIRECTION),
      has_recording:!!call.SETTINGS?.RECORD_URL || items(call.FILES).length>0})),
    comments:raw.comments.map(comment => ({id:scalar(comment.ID),created:scalar(comment.CREATED),
      author_id:scalar(comment.AUTHOR_ID),text:scalar(comment.COMMENT)})),
    tasks:raw.tasks.map(task => ({id:scalar(task.id ?? task.ID),created:scalar(task.createdDate ?? task.CREATED_DATE),
      title:scalar(task.title ?? task.TITLE)})),
    chats:raw.chats.map(chat => ({id:scalar(chat.CHAT_ID),connector_id:scalar(chat.CONNECTOR_ID)})),
    sessions:raw.sessions.map(session => ({chat_id:scalar(session.chat_id ?? session.history?.chatId),
      session_id:scalar(session.session_id ?? session.history?.sessionId),
      messages:items(session.history?.message).map(([key,message]) => ({id:scalar(message?.id ?? message?.ID ?? key),
        date:scalar(message?.date || message?.DATE || null),sender_id:scalar(message?.senderid ?? message?.SENDER_ID ?? message?.author_id ?? message?.AUTHOR_ID),
        text:scalar(message?.text || message?.TEXT || ''),file_ids:fileIds(message)})),
      files:items(session.history?.files).map(([key,file]) => ({id:scalar(file?.id ?? file?.ID ?? key),
        date:scalar(file?.date || file?.DATE || null),type:scalar(file?.type || file?.TYPE || null),name:scalar(file?.name || file?.NAME || null)})) })) });
  return {type:'raw_collection',key:digest('raw-collection-v1'),payload};
}

function communicationRows(dealId, communications) {
  if (!Number.isSafeInteger(Number(dealId)) || Number(dealId) <= 0 || !Array.isArray(communications)) throw new TypeError('Неполные коммуникации');
  return communications.map((item, index) => {
    const row = communicationRow(Number(dealId), item, index);
    if (item.transcription_coverage) row.transcription_coverage = item.transcription_coverage;
    // Подписанные ссылки/сырые файлы не нужны для повторной проверки фактов.
    delete row.call_audio_url; delete row.screenshot_files;
    return row;
  });
}

export function prepareCommunicationsArtifact(dealId, communications, voiceFailures) {
  if (!Array.isArray(voiceFailures)) throw new TypeError('Неизвестна полнота голосовых');
  const payload = safeJson({ url_policy:'credential_fields_redacted', communications: communicationRows(dealId, communications),
    voice_failures_count: voiceFailures.length });
  return { type:'communications', key:digest(`communications-v1:${digest(canonical(payload))}`), payload };
}

export function prepareJudgeInputArtifact(dealId, communications, factsPacket) {
  if (!factsPacket || typeof factsPacket !== 'object' || !Array.isArray(factsPacket.facts)) throw new TypeError('Неполные материалы');
  const rows = communicationRows(dealId, communications);
  const originalFacts = safeJson(factsPacket, {redactUrls:false});
  const payload = safeJson({ url_policy:'credential_fields_redacted', facts_packet_original_sha256:digest(canonical(originalFacts)),
    communications: rows, facts_packet: factsPacket });
  return { type: 'judge_input', key: digest('judge-input-v1'), payload };
}

/** Запись только под действующей арендой и подтверждённым ключом перехода. */
export async function savePrejudgeArtifact(pool, { operationId, leaseToken, dealId, stageHistoryId, loseDate, artifact }) {
  const id = Number(dealId);
  if (!uuid(operationId) || !uuid(leaseToken) || !Number.isSafeInteger(id) || id <= 0 || id > 2147483647
      || !transitionId(stageHistoryId) || typeof loseDate !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(loseDate)
      || !Number.isFinite(Date.parse(loseDate)) || !artifact || !['begin', 'raw_collection', 'communications', 'transcript', 'judge_input'].includes(artifact.type)
      || !/^[a-f0-9]{64}$/.test(artifact.key || '')) throw new PrejudgeStageError();
  let payload;
  try { payload = safeJson(artifact.payload); } catch { throw new PrejudgeStageError(); }
  const hash = digest(canonical(payload));
  try {
    return await inTransaction(pool, async connection => {
      const locked = await connection.query({ text: `SELECT id,request_key,trigger_type,origin_stage_history_id FROM public.lost_processing_jobs
        WHERE id=$1 AND deal_id=$2 AND status='processing' AND lease_token=$3
          AND lease_until>clock_timestamp() AND lose_date=$4::timestamptz FOR UPDATE`,
        values: [operationId, id, leaseToken, loseDate] });
      if (locked.rowCount !== 1) throw new Error('Нет аренды или подтверждённого перехода');
      const job = locked.rows[0];
      if (['manual','nightly'].includes(job.trigger_type) && job.origin_stage_history_id != null
          && job.origin_stage_history_id !== stageHistoryId) throw new Error('Переход задания изменился');
      if (job.request_key !== `bitrix24:deal-stage-history:${stageHistoryId}`
          && !(['manual','nightly'].includes(job.trigger_type) && job.origin_stage_history_id === stageHistoryId)) {
        // Для поздней записи и ручных/ночных повторов ID перехода должен быть
        // ранее сохранён в очереди ожидания для этой сделки и даты отказа.
        if (!['audio_wait','manual','nightly'].includes(job.trigger_type)) throw new Error('Нет подтверждённого перехода');
        const origin = await connection.query({ text: `SELECT deal_id FROM public.lost_audio_wait
          WHERE deal_id=$1 AND lose_date=$2::timestamptz AND origin_stage_history_id=$3
            AND state IN ('waiting','done','expired','cancelled')
            AND ($4::text <> 'audio_wait' OR (state='waiting' AND $5::text = 'audio-wait:' || deal_id::text || ':' ||
              (extract(epoch from lose_date) * 1000000)::bigint::text || ':' ||
              (extract(epoch from next_check_at) * 1000000)::bigint::text)) FOR UPDATE`,
          values:[id,loseDate,stageHistoryId,job.trigger_type,job.request_key] });
        if (origin.rowCount !== 1) throw new Error('Очередь не подтверждает переход');
      }
      const inserted = await connection.query({ text: `INSERT INTO public.lost_prejudge_artifacts
        (job_id,deal_id,stage_history_id,lose_date,artifact_type,artifact_key,payload,payload_sha256)
        VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7::jsonb,$8)
        ON CONFLICT (job_id,artifact_type,artifact_key) DO NOTHING RETURNING payload_sha256,payload`,
        values: [operationId,id,stageHistoryId,loseDate,artifact.type,artifact.key,JSON.stringify(payload),hash] });
      let stored = inserted.rows?.[0];
      if (inserted.rowCount === 0) {
        const existing = await connection.query({ text: `SELECT payload_sha256,payload FROM public.lost_prejudge_artifacts
          WHERE job_id=$1 AND deal_id=$2 AND stage_history_id=$3 AND lose_date=$4::timestamptz
            AND artifact_type=$5 AND artifact_key=$6`, values:[operationId,id,stageHistoryId,loseDate,artifact.type,artifact.key] });
        if (existing.rowCount !== 1) throw new Error('Материалы изменились');
        stored = existing.rows[0];
      }
      if (!stored || stored.payload_sha256 !== hash || !stored.payload || typeof stored.payload !== 'object'
          || digest(canonical(safeJson(stored.payload))) !== hash) throw new Error('Материалы изменились');
      const lease = await connection.query({ text: `SELECT id FROM public.lost_processing_jobs
        WHERE id=$1 AND status='processing' AND lease_token=$2 AND lease_until>clock_timestamp()`, values:[operationId,leaseToken] });
      if (lease.rowCount !== 1) throw new Error('Аренда истекла');
      return { saved: true, payloadSha256: hash };
    });
  } catch { throw new PrejudgeStageError(); }
}

/** После аварии не повторяем платное распознавание по одному ID файла. */
export async function hasPrejudgeArtifacts(pool, { operationId, leaseToken, dealId, stageHistoryId, loseDate }) {
  if (!uuid(operationId) || !uuid(leaseToken) || !Number.isSafeInteger(Number(dealId)) || Number(dealId) <= 0
      || !transitionId(stageHistoryId) || typeof loseDate !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(loseDate)
      || !Number.isFinite(Date.parse(loseDate))) throw new PrejudgeStageError();
  let connection;
  try {
    connection = await pool.connect();
    const result = await connection.query({ text: `SELECT EXISTS (SELECT 1 FROM public.lost_prejudge_artifacts a
        WHERE a.deal_id=j.deal_id AND a.stage_history_id=$4 AND a.lose_date=$5::timestamptz
          AND a.run_kind='automatic') AS has_artifacts FROM public.lost_processing_jobs j
      WHERE j.id=$1 AND j.deal_id=$2 AND j.status='processing' AND j.lease_token=$3
        AND j.lease_until>clock_timestamp() AND j.lose_date=$5::timestamptz`,
      values:[operationId,Number(dealId),leaseToken,stageHistoryId,loseDate] });
    if (result.rowCount !== 1 || typeof result.rows[0]?.has_artifacts !== 'boolean') throw new Error('Нет действующей аренды');
    return result.rows[0].has_artifacts;
  } catch { throw new PrejudgeStageError(); }
  finally { connection?.release(); }
}

/** Старый незавершённый запуск не фиксировал попытки, а judge_input мог уже уйти модели. */
export async function hasUnsafePrejudgeResume(pool, scope) {
  const {operationId,leaseToken,dealId,stageHistoryId,loseDate}=scope;
  if (!uuid(operationId) || !uuid(leaseToken) || !Number.isSafeInteger(Number(dealId)) || Number(dealId)<=0
      || !transitionId(stageHistoryId) || typeof loseDate!=='string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(loseDate)
      || !Number.isFinite(Date.parse(loseDate))) throw new PrejudgeStageError();
  let connection;
  try {
    connection=await pool.connect();
    const result=await connection.query({text:`SELECT EXISTS (SELECT 1 FROM public.lost_prejudge_artifacts a
      LEFT JOIN public.lost_processing_jobs old ON old.id=a.job_id
      WHERE a.deal_id=j.deal_id AND a.stage_history_id=$4 AND a.lose_date=$5::timestamptz AND a.run_kind='automatic'
      AND ((a.artifact_type='judge_input' AND (a.job_id=j.id OR
            (old.status IS DISTINCT FROM 'done' AND j.trigger_type IS DISTINCT FROM 'manual'))) OR
        (a.artifact_type='begin' AND a.payload->>'protocol_version' IS DISTINCT FROM '2'
          AND old.status IS DISTINCT FROM 'done'))) AS unsafe FROM public.lost_processing_jobs j
      WHERE j.id=$1 AND j.deal_id=$2 AND j.status='processing' AND j.lease_token=$3
        AND j.lease_until>clock_timestamp() AND j.lose_date=$5::timestamptz`,
      values:[operationId,Number(dealId),leaseToken,stageHistoryId,loseDate]});
    if(result.rowCount!==1 || typeof result.rows[0]?.unsafe!=='boolean') throw new Error('Нет аренды');
    return result.rows[0].unsafe;
  } catch { throw new PrejudgeStageError(); }
  finally { connection?.release(); }
}

/** Материалы найдены, но безопасное продолжение по аудиобайтам не настроено. */
export async function markPrejudgeNeedsReview(pool, { operationId, leaseToken, dealId, reason = 'prejudge_materials_need_review' }) {
  if (!uuid(operationId) || !uuid(leaseToken) || !Number.isSafeInteger(Number(dealId)) || Number(dealId) <= 0) throw new PrejudgeStageError();
  if (!['prejudge_materials_need_review','stt_attempts_exhausted'].includes(reason)) throw new PrejudgeStageError();
  let connection;
  try {
    connection = await pool.connect();
    const result = await connection.query({ text: `UPDATE public.lost_processing_jobs
      SET status='needs_review',lease_token=NULL,lease_until=NULL,last_error=$4,updated_at=NOW()
      WHERE id=$1 AND deal_id=$2 AND status='processing' AND lease_token=$3
        AND lease_until>clock_timestamp() RETURNING id`, values:[operationId,Number(dealId),leaseToken,reason] });
    if (result.rowCount !== 1) throw new Error('Нет действующей аренды');
    return true;
  } catch { throw new PrejudgeStageError(); }
  finally { connection?.release(); }
}
