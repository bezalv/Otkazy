import { createHash, randomUUID } from 'node:crypto';
import { inTransaction } from './transaction.mjs';
import { PrejudgeStageError, prepareTranscriptArtifact, rehydrateVerifiedTranscript, transcriptSourceKey } from './prejudge.mjs';
import { ambiguousProcessingOnly } from '../calls/transcript-quality.mjs';
import { verifiedAudioHash } from '../stt-client.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export class SttAttemptsExhaustedError extends PrejudgeStageError {
  constructor() { super(); this.name='SttAttemptsExhaustedError'; }
}
function validate(scope, request, audioSha256, policySha256, expectedEngine) {
  if (!uuid(scope?.operationId) || !uuid(scope?.leaseToken) || !Number.isSafeInteger(Number(scope?.dealId)) || Number(scope.dealId) <= 0
    || !/^[1-9]\d{0,29}$/.test(scope.stageHistoryId || '') || typeof scope.loseDate !== 'string'
    || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(scope.loseDate) || !Number.isFinite(Date.parse(scope.loseDate))
    || !sha(audioSha256) || !sha(policySha256) || !(Array.isArray(expectedEngine) ? expectedEngine : [expectedEngine])
      .every(x=>typeof x==='string' && /^reserve:[a-z0-9-]{1,24}$/.test(x))
    || (Array.isArray(expectedEngine) && (expectedEngine.length===0 || expectedEngine.length>4))) throw new PrejudgeStageError();
  try { return transcriptSourceKey(request); } catch { throw new PrejudgeStageError(); }
}
async function authorize(c, s) {
  const row = await c.query({ text:`SELECT id,request_key,trigger_type,origin_stage_history_id FROM public.lost_processing_jobs j
    WHERE j.id=$1 AND j.deal_id=$2 AND j.lease_token=$3 AND j.status='processing'
      AND j.lease_until>clock_timestamp() AND j.lose_date=$4::timestamptz
    FOR UPDATE`, values:[s.operationId,Number(s.dealId),s.leaseToken,s.loseDate] });
  if (row.rowCount !== 1) throw new Error('Нет действующей аренды перехода');
  const job=row.rows[0];
  if (['manual','nightly'].includes(job.trigger_type) && job.origin_stage_history_id != null
      && job.origin_stage_history_id !== s.stageHistoryId) throw new Error('Переход задания изменился');
  if(job.request_key !== `bitrix24:deal-stage-history:${s.stageHistoryId}`
      && !(['manual','nightly'].includes(job.trigger_type) && job.origin_stage_history_id === s.stageHistoryId)) {
    if (!['audio_wait','manual','nightly'].includes(job.trigger_type)) throw new Error('Нет подтверждённого перехода');
    const origin=await c.query({text:`SELECT deal_id FROM public.lost_audio_wait
      WHERE deal_id=$1 AND lose_date=$2::timestamptz AND origin_stage_history_id=$3
        AND state IN ('waiting','done','expired','cancelled')
        AND ($4::text <> 'audio_wait' OR (state='waiting' AND $5::text = 'audio-wait:' || deal_id::text || ':' ||
          (extract(epoch from lose_date)*1000000)::bigint::text || ':' || (extract(epoch from next_check_at)*1000000)::bigint::text)) FOR UPDATE`,
      values:[Number(s.dealId),s.loseDate,s.stageHistoryId,job.trigger_type,job.request_key]});
    if(origin.rowCount!==1) throw new Error('Очередь не подтверждает переход');
  }
}
async function stillLeased(c,s) {
  const result=await c.query({text:`SELECT id FROM public.lost_processing_jobs WHERE id=$1 AND deal_id=$2
    AND status='processing' AND lease_token=$3 AND lease_until>clock_timestamp()`,
    values:[s.operationId,Number(s.dealId),s.leaseToken]});
  if(result.rowCount!==1) throw new Error('Аренда истекла');
}

/** Резервирует не более двух попыток для одних байтов. Unknown может стоить денег. */
export async function claimSttAttempt(pool, { scope, request, audioSha256, policySha256, expectedEngine }) {
  const key=validate(scope,request,audioSha256,policySha256,expectedEngine);
  try {
    const claimed = await inTransaction(pool, async c => {
      await authorize(c,scope);
      const values=[Number(scope.dealId),scope.stageHistoryId,scope.loseDate,key,audioSha256,policySha256];
      // Один lock на источник и переход, включая разные версии аудио/политик.
      await c.query({text:`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        values:[`lost-stt:${scope.dealId}:${scope.stageHistoryId}:${new Date(scope.loseDate).toISOString()}:${key}`]});
      await stillLeased(c,scope);
      const rows=await c.query({text:`SELECT a.*, (j.status='processing' AND j.lease_token=a.owner_lease_token
          AND j.lease_until>clock_timestamp()) AS owner_active FROM public.lost_prejudge_stt_attempts a
        LEFT JOIN public.lost_processing_jobs j ON j.id=a.owner_job_id
        WHERE a.deal_id=$1 AND a.stage_history_id=$2 AND a.lose_date=$3::timestamptz AND a.source_key=$4
        ORDER BY a.created_at DESC FOR UPDATE OF a`, values:values.slice(0,4)});
      for (const row of rows.rows) {
        if (row.status==='pending' && row.owner_active) throw new Error('Предыдущая попытка ещё выполняется');
        if (row.status==='pending') await c.query({text:`UPDATE public.lost_prejudge_stt_attempts SET status='unknown' WHERE attempt_id=$1`,values:[row.attempt_id]});
      }
      const same=rows.rows.filter(r=>r.audio_sha256===audioSha256 && r.policy_sha256===policySha256);
      for (const row of same) if (row.status==='completed') {
        if (!row.transcript || hash(canonical(row.transcript))!==row.transcript_sha256) throw new Error('Повреждённый транскрипт');
        if (row.transcript.status==='channel_mismatch' && row.transcript.source_key===key
            && row.transcript.audio_sha256===audioSha256 && Number(request.channel_count)===2) {
          await stillLeased(c,scope);
          return {cached:{success:false,retryable:false,channels_mismatch:true,reserve_failed:true,
            activity_id:request.activity_id,comm_index:request.comm_index,channel_count:2,audio_sha256:audioSha256,
            error:'Резерв распознавания: channels_mismatch'}};
        }
        const cached=rehydrateVerifiedTranscript(row.transcript,request,audioSha256,expectedEngine);
        if (cached) { await stillLeased(c,scope); return {cached}; }
        throw new Error('Результат не соответствует политике распознавания');
      }
      if (same.length >= 2) { await stillLeased(c,scope); return {exhausted:true}; }
      const attemptId=randomUUID();
      await c.query({text:`INSERT INTO public.lost_prejudge_stt_attempts
        (attempt_id,deal_id,stage_history_id,lose_date,source_key,audio_sha256,policy_sha256,owner_job_id,owner_lease_token,status)
        VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7,$8,$9,'pending')`,
        values:[attemptId,...values,scope.operationId,scope.leaseToken]});
      await stillLeased(c,scope);
      return {allowed:true,attemptId};
    });
    if (claimed.exhausted) throw new SttAttemptsExhaustedError();
    return claimed;
  } catch (error) { if (error instanceof SttAttemptsExhaustedError) throw error; throw new PrejudgeStageError(); }
}

/** Атомарно сохраняет подтверждённый ответ и помечает попытку завершённой. */
export async function completeSttAttempt(pool, { scope, request, result, audioSha256, policySha256, expectedEngine, attempt }) {
  const key=validate(scope,request,audioSha256,policySha256,expectedEngine);
  if (!uuid(attempt?.attemptId)) throw new PrejudgeStageError();
  let payload;
  if (result?.success===false && result.channels_mismatch===true && result.retryable===false
      && Number(request.channel_count)===2 && verifiedAudioHash(result,request)===audioSha256) {
    payload={status:'channel_mismatch',source_key:key,audio_sha256:audioSha256};
  } else {
    let artifact;
    try { artifact=prepareTranscriptArtifact(request,result,{allowEmpty:true}); } catch { throw new PrejudgeStageError(); }
    const allowedEngines=Array.isArray(expectedEngine) ? expectedEngine : [expectedEngine];
    if (!allowedEngines.includes(result?.transcript_engine)) throw new PrejudgeStageError();
    if (artifact.payload.status!=='verified_stt_response' || artifact.payload.source.source_identity_sha256!==key
        || artifact.payload.source.audio_bytes_sha256!==audioSha256) throw new PrejudgeStageError();
    payload=artifact.payload;
  }
  const checksum=hash(canonical(payload));
  try {
    return await inTransaction(pool,async c=>{
      await authorize(c,scope);
      if (ambiguousProcessingOnly(result)) {
        const unknown=await c.query({text:`UPDATE public.lost_prejudge_stt_attempts SET status='unknown'
          WHERE attempt_id=$1 AND deal_id=$2 AND stage_history_id=$3 AND lose_date=$4::timestamptz
            AND source_key=$5 AND audio_sha256=$6 AND policy_sha256=$7 AND owner_job_id=$8 AND owner_lease_token=$9
            AND status='pending' RETURNING attempt_id`,
          values:[attempt.attemptId,Number(scope.dealId),scope.stageHistoryId,scope.loseDate,key,audioSha256,policySha256,scope.operationId,scope.leaseToken]});
        if (unknown.rowCount!==1) throw new Error('Не сохранено состояние попытки');
        await stillLeased(c,scope);
        return true;
      }
      const updated=await c.query({text:`UPDATE public.lost_prejudge_stt_attempts SET status='completed',transcript=$1::jsonb,transcript_sha256=$2
        WHERE attempt_id=$3 AND deal_id=$4 AND stage_history_id=$5 AND lose_date=$6::timestamptz
          AND source_key=$7 AND audio_sha256=$8 AND policy_sha256=$9 AND owner_job_id=$10 AND owner_lease_token=$11
          AND status='pending' RETURNING transcript,transcript_sha256`,
        values:[JSON.stringify(payload),checksum,attempt.attemptId,Number(scope.dealId),scope.stageHistoryId,scope.loseDate,
          key,audioSha256,policySha256,scope.operationId,scope.leaseToken]});
      if(updated.rowCount!==1 || hash(canonical(updated.rows[0].transcript))!==checksum || updated.rows[0].transcript_sha256!==checksum) throw new Error('Ответ не сохранён');
      await stillLeased(c,scope);
      return true;
    });
  } catch { throw new PrejudgeStageError(); }
}
