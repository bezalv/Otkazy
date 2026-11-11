// Отдельный ручной прогон. Он не создаёт job в автоматической очереди и не
// вызывает доставку в Битрикс; материалы попадают в общую staging-таблицу.
import { randomUUID } from 'node:crypto';
import { processDeal } from '../process-deal.mjs';
import { inTransaction } from '../persistence/transaction.mjs';
import { PrejudgeStageError, sanitizePrejudgeArtifact, prepareManualJudgeResultArtifact } from '../persistence/prejudge.mjs';
import { exactMillisTimestamp } from '../time-precision.mjs';
import { createRoleSessionContext } from '../worker/role-session-context.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGE = /^[1-9]\d{0,29}$/;

/** Только явный ручной вызов; production worker и планировщик не участвуют. */
export async function runManualPrejudge({ pool, dealId, stageHistoryId, loseDate, options, semanticRolesFrom, repairProofErrors = false, uuid = randomUUID }) {
  const id = Number(dealId);
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function'
      || !Number.isSafeInteger(id) || id <= 0 || id > 2147483647
      || !STAGE.test(String(stageHistoryId || '')) || !exactMillisTimestamp(loseDate)
      || !options || typeof options !== 'object' || Array.isArray(options) || typeof uuid !== 'function') {
    throw new TypeError('Некорректные параметры ручного прогона');
  }
  if (typeof repairProofErrors !== 'boolean' || (repairProofErrors && semanticRolesFrom === undefined)) {
    throw new TypeError('Исправление ссылок доступно только при ручной проверке авторов');
  }
  // Нельзя подменить сквозную привязку, тихий режим или сохранение снаружи.
  for (const key of ['dealId','expectedHistoryId','expectedLoseDate','silent','prejudgeCheckpoint',
    'prejudgeCheckLease','prejudgeSttHooks','semanticChatRoles','roleInferenceClient','verifyFallbackSession',
    'verifyLatestSession','repairProofErrors','roleSessionContext']) {
    if (Object.hasOwn(options, key)) throw new TypeError('Недопустимый параметр ручного прогона');
  }
  // Opt-in только для одного ручного запуска. Контекст верифицирует сессию
  // по той же сделке и исходному переходу, без доступа к другим диалогам.
  let roleSessionContext;
  if (semanticRolesFrom !== undefined) {
    roleSessionContext = createRoleSessionContext({ client:options.bitrix, dealId:String(id),
      transitionId:String(stageHistoryId), cutoff:loseDate, from:semanticRolesFrom });
  }
  const runId = uuid();
  if (typeof runId !== 'string' || !UUID.test(runId)) throw new TypeError('Некорректный ID ручного прогона');
  const scope = [runId, id, String(stageHistoryId), loseDate];
  try {
    const created = await pool.query({text:`INSERT INTO public.lost_prejudge_manual_jobs
      (id,request_key,deal_id,stage_history_id,lose_date,status)
      VALUES ($1,'manual-test:' || $1::uuid::text,$2,$3,$4::timestamptz,'running') RETURNING id`,values:scope});
    if (created.rowCount !== 1) throw new Error('Прогон не создан');
  } catch { throw new PrejudgeStageError(); }
  const check = async () => {
    const result = await pool.query({text:`SELECT id FROM public.lost_prejudge_manual_jobs
      WHERE id=$1 AND deal_id=$2 AND stage_history_id=$3 AND lose_date=$4::timestamptz
        AND request_key='manual-test:' || id::text AND status='running'`,values:scope});
    if (result.rowCount !== 1) throw new PrejudgeStageError();
  };
  const checkpoint = async (input, {complete = false} = {}) => {
    if (Number(input?.dealId)!==id || String(input?.stageHistoryId)!==String(stageHistoryId)
        || !exactMillisTimestamp(input?.loseDate)
        || Date.parse(input.loseDate)!==Date.parse(loseDate)) throw new PrejudgeStageError();
    const artifact = sanitizePrejudgeArtifact(input.artifact);
    try {
      return await inTransaction(pool, async connection => {
        const job = await connection.query({text:`SELECT id FROM public.lost_prejudge_manual_jobs
          WHERE id=$1 AND deal_id=$2 AND stage_history_id=$3 AND lose_date=$4::timestamptz
            AND request_key='manual-test:' || id::text AND status='running' FOR UPDATE`,values:scope});
        if (job.rowCount!==1) throw new Error('Ручной прогон не подтверждён');
        const values=[runId,id,String(stageHistoryId),loseDate,artifact.type,artifact.key,
          JSON.stringify(artifact.payload),artifact.payloadSha256];
        const inserted=await connection.query({text:`INSERT INTO public.lost_prejudge_artifacts
          (job_id,deal_id,stage_history_id,lose_date,artifact_type,artifact_key,payload,payload_sha256,run_kind)
          VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7::jsonb,$8,'manual')
          ON CONFLICT (job_id,artifact_type,artifact_key) DO NOTHING RETURNING payload,payload_sha256`,values});
        let stored=inserted.rows?.[0];
        if (inserted.rowCount===0) {
          const previous=await connection.query({text:`SELECT payload,payload_sha256 FROM public.lost_prejudge_artifacts
            WHERE job_id=$1 AND deal_id=$2 AND stage_history_id=$3 AND lose_date=$4::timestamptz
              AND artifact_type=$5 AND artifact_key=$6 AND run_kind='manual'`,values:values.slice(0,6)});
          if (previous.rowCount!==1) throw new Error('Материалы не подтверждены');
          stored=previous.rows[0];
        }
        const verified=sanitizePrejudgeArtifact({type:artifact.type,key:artifact.key,payload:stored?.payload});
        if (stored?.payload_sha256!==artifact.payloadSha256 || verified.payloadSha256!==artifact.payloadSha256) {
          throw new Error('Материалы изменились');
        }
        if (complete) {
          if (artifact.type !== 'judge_result') throw new Error('Нет результата судьи');
          const finished=await connection.query({text:`UPDATE public.lost_prejudge_manual_jobs SET status='completed',finished_at=now()
            WHERE id=$1 AND deal_id=$2 AND stage_history_id=$3 AND lose_date=$4::timestamptz
              AND request_key='manual-test:' || id::text AND status='running' RETURNING id`,values:scope});
          if (finished.rowCount!==1) throw new Error('Ручной прогон не завершён');
        }
        return {saved:true,payloadSha256:artifact.payloadSha256};
      });
    } catch { throw new PrejudgeStageError(); }
  };
  const finish = async status => {
    const result=await pool.query({text:`UPDATE public.lost_prejudge_manual_jobs SET status=$5,finished_at=now()
      WHERE id=$1 AND deal_id=$2 AND stage_history_id=$3 AND lose_date=$4::timestamptz
        AND request_key='manual-test:' || id::text AND status='running' RETURNING id`,values:[...scope,status]});
    if (result.rowCount!==1) throw new PrejudgeStageError();
  };
  try {
    const result=await processDeal({ ...options, dealId:id, expectedHistoryId:String(stageHistoryId),
      expectedLoseDate:loseDate, silent:true, prejudgeCheckpoint:checkpoint, prejudgeCheckLease:check, repairProofErrors,
      ...(roleSessionContext ? {semanticChatRoles:true, roleSessionContext,
        verifyFallbackSession:roleSessionContext.verify, verifyLatestSession:roleSessionContext.verify} : {}) });
    if (result?.status==='processed') {
      const artifact=prepareManualJudgeResultArtifact(result);
      await checkpoint({dealId:id,stageHistoryId:String(stageHistoryId),loseDate,artifact},{complete:true});
      return {runId,result,resultSaved:true};
    }
    await finish('failed');
    return {runId,result,resultSaved:false};
  } catch (error) {
    try { await finish('failed'); } catch { /* Состояние остаётся видимым для ручной сверки. */ }
    throw error;
  }
}
