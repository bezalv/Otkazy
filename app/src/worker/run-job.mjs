import { processDeal } from '../process-deal.mjs';
import { safeErrorUsageMeta } from '../persistence/rows.mjs';
import { revalidateRoleInferenceMetadata, markRoleUsageUnknown } from './role-inference-metadata.mjs';
import { PrejudgeStageError } from '../persistence/prejudge.mjs';
import { SttAttemptsExhaustedError } from '../persistence/stt-attempts.mjs';
import { resolveCurrentTransition } from '../collect/index.mjs';

// Входом служит только уже захваченное задание. Ошибки сохранения или потери
// аренды не превращаются в результат сделки и оставляются очереди на восстановление.
export function toPersistenceResult(job, outcome, audioOriginHistoryId = null, verifiedRoleHistoryId = null) {
  const base = { deal_id: Number(job.deal_id), operation_id: job.id, lease_token: job.lease_token, silent: job.silent === true,
    audio_origin_stage_history_id: audioOriginHistoryId,
    ...(verifiedRoleHistoryId ? {role_origin_stage_history_id:verifiedRoleHistoryId} : {}) };
  const collection = outcome?.collection || {};
  const transition = typeof job.request_key === 'string'
    ? /^bitrix24:deal-stage-history:([1-9]\d{0,29})$/.exec(job.request_key)?.[1] : null;
  const binding = {jobId:job.id,leaseToken:job.lease_token,dealId:String(job.deal_id),
    // Этот ID ещё раз независимо проверяется под блокировкой задания в БД.
    stageHistoryId:verifiedRoleHistoryId || transition,
    cutoff:job.lose_date instanceof Date && Number.isFinite(job.lose_date.getTime()) ? job.lose_date.toISOString() : job.lose_date};
  const roleMetadata = revalidateRoleInferenceMetadata(outcome?.chatRoleInferenceMetadata,binding);
  const roleUnaccounted = outcome?.chatRoleInferenceUnaccounted === true
    || (!!outcome?.chatRoleInferenceMetadata && !roleMetadata);
  const roleSpent = roleUnaccounted || (roleMetadata?.model_calls > 0)
    || (roleMetadata?.physical_requests_started > 0) || roleMetadata?.uncertain_outcome === true;
  const inputAnalysis = outcome?.analysis?.multi_agent_analysis;
  const hasAnalysis = inputAnalysis && typeof inputAnalysis === 'object' && !Array.isArray(inputAnalysis);
  // Поле от произвольного process не должно попасть даже в store, если не
  // подтверждено отдельным валидатором. Остальное содержимое не меняем.
  const cleanAnalysis = hasAnalysis ? { ...inputAnalysis } : {};
  delete cleanAnalysis.role_inference;
  delete cleanAnalysis.role_inference_unaccounted;
  if (outcome?.status === 'processed') return {
    ...base, ...outcome.analysis, _status: 'processed', deal_data: outcome.dealData,
    ...(hasAnalysis ? { multi_agent_analysis: { ...cleanAnalysis,
      ...(roleMetadata ? {role_inference:roleMetadata} : {}),
      ...(roleUnaccounted ? {role_inference_unaccounted:true} : {}) } } : {}),
    ...(roleSpent ? { llm_meta:markRoleUsageUnknown(outcome.analysis?.llm_meta,cleanAnalysis) } : {}),
    ...(roleUnaccounted ? {role_inference_unaccounted:true} : {}),
    comm_stats: outcome.dealData?.comm_stats || {},
    communications_with_transcripts: outcome.analysis?.communications || [],
    audio_wait: outcome.audioWait?.queue || null,
  };
  if (outcome?.status === 'expired') return {
    ...base, _status: 'processed', deal_data: collection.deal_data,
    classification: outcome.audioWait.classification, multi_agent_analysis: outcome.audioWait.multi_agent_analysis,
    communications: [], comm_stats: {}, audio_wait: outcome.audioWait.queue, audio_wait_expired: true,
  };
  if (outcome?.status === 'waiting') return { ...base, _status: 'waiting_audio', audio_wait: outcome.audioWait.queue };
  if (outcome?.status === 'skipped_by_reason') return { ...base, _status: 'skipped_by_reason', deal_data: collection.deal_data };
  if (outcome?.status === 'skipped' || outcome?.status === 'skip' || collection._reason === 'not_in_lost_stage') return { ...base, _status: 'skipped' };
  return {
    ...base, _status: 'error',
    ...(roleMetadata ? { role_inference_metadata:roleMetadata } : {}),
    ...(roleUnaccounted ? { role_inference_unaccounted:true } : {}),
    ...(safeErrorUsageMeta(outcome?.analysis?.llm_meta) ? { llm_meta: safeErrorUsageMeta(outcome.analysis.llm_meta) } : {}),
    // Только блокировка с известной непоправимой без ручной проверки причиной
    // завершает конкретное ожидание аудио. Сетевые ошибки остаются повторяемыми.
    ...(outcome?.status === 'blocked' && outcome.pipelineGate?.final === true
      && ['author_ambiguous', 'chat_connector_unknown'].includes(outcome.pipelineGate.kind)
      ? { error_kind: outcome.pipelineGate.kind } : {}),
    _error: outcome?.pipelineGate?.pipeline_error || outcome?.analysis?.pipeline_error
      || (collection._sources?.openlines?.reason === 'latest_session_link_unverified'
        ? 'сбор неполный: обнаружена новая сессия чата, её связь со сделкой не подтверждена' : null)
      || collection._error
      || (outcome?.status === 'source_incomplete' ? 'сбор неполный: не установлены данные для ожидания записи' : 'Сбой обработки сделки'),
  };
}

/**
 * Все зависимости передаются извне, реальных сетевых вызовов здесь нет.
 * delivery вызывается лишь после сохранения результата либо его восстановления.
 */
export async function runJob({ job, queue, store, loadAudioWait, delivery, createRoleInference, process = processDeal, processOptions = {}, heartbeatMs = 60000, resolveRetryTransition = resolveCurrentTransition }) {
  if (processOptions.semanticChatRoles === true) {
    throw new Error('Эксперимент определения ролей доступен только без записи и доставки');
  }
  if (!job?.id || !job?.lease_token || !job?.deal_id || !job?.lose_date) throw new TypeError('Не задано захваченное задание');
  if (!queue?.renew || !store?.loadResumableResult || !store?.persistResult || typeof loadAudioWait !== 'function') {
    throw new TypeError('Не заданы зависимости обработки');
  }
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1000) throw new TypeError('Некорректный интервал аренды');
  if (processOptions.prejudgeCheckpoint !== undefined || processOptions.prejudgeCheckLease !== undefined
      || processOptions.prejudgeSttHooks !== undefined) throw new TypeError('Недопустимый внешний checkpoint');
  if (processOptions.persistInputsBeforeJudge !== undefined && typeof processOptions.persistInputsBeforeJudge !== 'boolean') {
    throw new TypeError('Некорректная настройка сохранения материалов');
  }
  const stageEnabled = processOptions.persistInputsBeforeJudge === true;
  if (createRoleInference !== undefined && (typeof createRoleInference !== 'function' || !stageEnabled)) {
    throw new TypeError('Для определения авторов нужно предварительное сохранение');
  }
  const sttPolicy = processOptions.sttAttemptPolicy;
  const engines=Array.isArray(sttPolicy?.expectedEngine) ? sttPolicy.expectedEngine : [sttPolicy?.expectedEngine];
  if (sttPolicy !== undefined && (!stageEnabled || !sttPolicy || typeof sttPolicy !== 'object'
      || !/^[a-f0-9]{64}$/.test(sttPolicy.sha256 || '') || !engines.length || engines.length>4
      || !engines.every(x=>typeof x==='string' && /^reserve:[a-z0-9-]{1,24}$/.test(x))))
    throw new TypeError('Не задана версия политики STT');
  if (stageEnabled && (typeof store.savePrejudgeArtifact !== 'function' || typeof store.hasPrejudgeArtifacts !== 'function'
      || typeof store.markPrejudgeNeedsReview !== 'function')) {
    throw new TypeError('Не подключено сохранение материалов');
  }
  if (sttPolicy && (typeof store.claimSttAttempt !== 'function' || typeof store.completeSttAttempt !== 'function'
      || typeof store.hasUnsafePrejudgeResume !== 'function')) throw new TypeError('Не подключён журнал попыток STT');
  let leaseLost = false;
  let renewal = Promise.resolve();
  const renew = () => {
    renewal = renewal.then(async () => {
      if (!leaseLost && !(await queue.renew(job.id, job.lease_token))) leaseLost = true;
    }).catch(() => { leaseLost = true; });
    return renewal;
  };
  const timer = setInterval(renew, heartbeatMs);
  timer.unref?.();
  const checkLease = async () => { await renew(); if (leaseLost) throw new Error('Аренда задания потеряна'); };
  try {
    await checkLease();
    const saved = await store.loadResumableResult({ operation_id: job.id, lease_token: job.lease_token });
    if (saved) {
      await checkLease();
      if (typeof delivery !== 'function') return { status: 'awaiting_delivery', analysisId: saved.analysisId };
      return await delivery({ job, saved, checkLease });
    }
    if (job.trigger_type === 'nightly') {
      await checkLease();
      if (typeof queue.finishObsoleteNightly !== 'function') throw new Error('Не подключена проверка ночного повтора');
      if (await queue.finishObsoleteNightly(job.id, job.lease_token)) return { status: 'obsolete' };
      await checkLease();
    }
    const audioWait = await loadAudioWait(job);
    if (job.trigger_type === 'audio_wait'
      && (!audioWait || audioWait.state !== 'waiting' || audioWait._scheduled_request_key !== job.request_key)) {
      await checkLease();
      if (typeof queue.finishObsoleteAudioCheck !== 'function'
        || !await queue.finishObsoleteAudioCheck(job.id, job.lease_token)) {
        throw new Error('Не удалось подтвердить устаревшее расписание');
      }
      return { status: 'obsolete' };
    }
    const eventKey = typeof job.request_key === 'string' && /^bitrix24:deal-stage-history:([1-9]\d{0,29})$/.exec(job.request_key);
    const audioSameDate = audioWait && audioWait.lose_date != null
      && new Date(audioWait.lose_date).getTime() === new Date(job.lose_date).getTime();
    let audioHistoryId = null;
    // Даже новый отказ позже старого не даёт права затереть незавершённое
    // историческое ожидание, у которого неизвестен исходный переход.
    if (audioWait?.state === 'waiting' && (typeof audioWait.origin_stage_history_id !== 'string'
      || !/^[1-9]\d{0,29}$/.test(audioWait.origin_stage_history_id))) {
      await checkLease();
      if (typeof queue.markAudioOriginNeedsReview !== 'function'
        || !await queue.markAudioOriginNeedsReview(job.id, job.lease_token, 'audio_origin_missing')) throw new Error('Не удалось отметить необходимость сверки аудио');
      return { status: 'needs_review', reason: 'audio_origin_missing' };
    }
    if (audioSameDate && ['waiting', 'done', 'expired', 'cancelled'].includes(audioWait.state)) {
      const id = audioWait.origin_stage_history_id;
      const reason = typeof id !== 'string' || !/^[1-9]\d{0,29}$/.test(id) ? 'audio_origin_missing'
        : eventKey && eventKey[1] !== id ? 'audio_origin_mismatch' : null;
      if (reason) {
        await checkLease();
        if (typeof queue.markAudioOriginNeedsReview !== 'function'
          || !await queue.markAudioOriginNeedsReview(job.id, job.lease_token, reason)) throw new Error('Не удалось отметить необходимость сверки аудио');
        return { status: 'needs_review', reason };
      }
      audioHistoryId = id;
    }
    if (stageEnabled && ['manual','nightly'].includes(job.trigger_type) && job.origin_stage_history_id != null
        && (typeof job.origin_stage_history_id !== 'string' || !/^[1-9]\d{0,29}$/.test(job.origin_stage_history_id)
          || (audioHistoryId && audioHistoryId !== job.origin_stage_history_id))) throw new PrejudgeStageError();
    let retryHistoryId = null;
    if (stageEnabled && !(eventKey || audioHistoryId) && ['manual','nightly'].includes(job.trigger_type)) {
      if (typeof resolveRetryTransition !== 'function' || typeof queue.bindRetryTransition !== 'function') throw new PrejudgeStageError();
      await checkLease();
      const verified = await resolveRetryTransition({client:processOptions.bitrix,dealId:Number(job.deal_id),loseDate:job.lose_date,wait:processOptions.wait});
      await checkLease();
      if (verified?.status === 'obsolete') {
        if (typeof queue.finishObsoleteTransition !== 'function' || !await queue.finishObsoleteTransition(job.id,job.lease_token)) throw new PrejudgeStageError();
        return {status:'obsolete'};
      }
      if (verified?.status !== 'current' || typeof verified.stageHistoryId !== 'string'
          || !/^[1-9]\d{0,29}$/.test(verified.stageHistoryId)) throw new PrejudgeStageError();
      const bound = await queue.bindRetryTransition({id:job.id,token:job.lease_token,dealId:Number(job.deal_id),
        loseDate:job.lose_date,stageHistoryId:verified.stageHistoryId});
      if (!bound) throw new PrejudgeStageError();
      await checkLease();
      retryHistoryId = verified.stageHistoryId;
    }
    if (stageEnabled && !(eventKey || audioHistoryId || retryHistoryId)) throw new PrejudgeStageError();
    let stageScope;
    if (stageEnabled) {
      await checkLease();
      // Нельзя автоматически повторять распознавание по тем же ID файла:
      // начало уже записано, а идентичность аудиобайтов не подтверждена.
      stageScope={operationId:job.id,leaseToken:job.lease_token,dealId:Number(job.deal_id),
        stageHistoryId:eventKey ? eventKey[1] : audioHistoryId || retryHistoryId,
        loseDate:job.lose_date instanceof Date ? job.lose_date.toISOString() : job.lose_date};
      const unsafe = sttPolicy ? await store.hasUnsafePrejudgeResume(stageScope) : await store.hasPrejudgeArtifacts(stageScope);
      if (unsafe) {
        await checkLease();
        if (await store.markPrejudgeNeedsReview(stageScope) !== true) throw new PrejudgeStageError();
        return {status:'needs_review',reason:'prejudge_materials_need_review'};
      }
    }
    let outcome,semanticRoleActive=false;
    try {
      if ((['live', 'backfill'].includes(job.trigger_type) || String(job.request_key || '').startsWith('bitrix24:deal-stage-history:')) && !eventKey) {
        throw new Error('Некорректный ключ перехода');
      }
      // Ручной и ночной повторы должны видеть поздно появившиеся записи,
      // даже если предыдущий цикл ожидания уже завершён. Старую очередь при
      // этом не открываем повторно и её прежний срок не продлеваем.
      const recheckTerminalAudio = ['manual', 'nightly'].includes(job.trigger_type)
        && audioWait && ['done', 'expired', 'cancelled'].includes(audioWait.state);
      const runOptions = { ...processOptions };
      delete runOptions.persistInputsBeforeJudge;
      delete runOptions.sttAttemptPolicy;
      let roleOptions={};
      if (createRoleInference) {
        await checkLease();
        const deps=await createRoleInference({job,stageScope,checkLease});
        if (!deps?.sessionContext || !deps?.roleClient) throw new Error('Не созданы зависимости определения авторов');
        roleOptions={semanticChatRoles:true,roleSessionContext:deps.sessionContext,
          verifyFallbackSession:deps.sessionContext.verify,verifyLatestSession:deps.sessionContext.verify,
          roleInferenceClient:deps.roleClient};
        semanticRoleActive=true;
        await checkLease();
      }
      outcome = await process({ ...runOptions, dealId: Number(job.deal_id), expectedLoseDate: job.lose_date, expectedHistoryId: eventKey ? eventKey[1] : audioHistoryId || retryHistoryId,
        silent: job.silent === true, screenshots: job.screenshots === true, ...roleOptions,
        ...(stageEnabled ? { prejudgeCheckpoint:async args => {
          await checkLease();
          return store.savePrejudgeArtifact({ ...args, operationId:job.id, leaseToken:job.lease_token });
        }, prejudgeCheckLease:checkLease, ...(sttPolicy ? {prejudgeSttHooks:{
          beforeStt:async args=>{ await checkLease(); const claim=await store.claimSttAttempt({scope:stageScope,...args,
            policySha256:sttPolicy.sha256,expectedEngine:sttPolicy.expectedEngine}); await checkLease(); return claim; },
          afterStt:async args=>{ await checkLease(); return store.completeSttAttempt({scope:stageScope,...args,
            policySha256:sttPolicy.sha256,expectedEngine:sttPolicy.expectedEngine}); },
        }} : {}) } : {}),
        savedAudioWait: recheckTerminalAudio ? { ...audioWait, _recheck_terminal: true } : audioWait });
    } catch (error) {
      if (error instanceof SttAttemptsExhaustedError && stageEnabled) {
        await checkLease();
        if (await store.markPrejudgeNeedsReview({...stageScope,reason:'stt_attempts_exhausted'}) !== true) throw new PrejudgeStageError();
        return {status:'needs_review',reason:'stt_attempts_exhausted'};
      }
      if (error instanceof PrejudgeStageError) throw error;
      // Исключения нормализации не должны исчезать вместе с процессом.
      outcome = { status: 'error', collection: { _error: 'Сбой обработки данных сделки' } };
    }
    await checkLease();
    if (outcome?.status === 'obsolete_transition') {
      if (typeof queue.finishObsoleteTransition !== 'function'
        || !await queue.finishObsoleteTransition(job.id, job.lease_token, audioHistoryId)) {
        throw new Error('Не удалось завершить устаревший переход');
      }
      return { status: 'obsolete' };
    }
    let result = toPersistenceResult(job, outcome, audioHistoryId, stageScope?.stageHistoryId ?? null);
    if (semanticRoleActive && result._status==='processed' && result.role_inference_unaccounted===true) {
      // Непроверенные provenance/учёт не могут сопровождать успешный вердикт.
      // Факт возможного расхода сохраняется в ошибке, без текста ответа модели.
      outcome={...outcome,status:'error',analysis:{pipeline_error:'Не подтверждён учёт определения авторов'},
        chatRoleInferenceUnaccounted:true};
      result=toPersistenceResult(job,outcome,audioHistoryId,stageScope?.stageHistoryId ?? null);
    }
    const stored = await store.persistResult(result);
    if (!stored.needsExternalActions) return { status: stored.status, analysisId: stored.analysisId || null,
      ...(outcome?.audioWait?.reason === 'audio_wait_terminal_recordings_missing'
        ? { reason: outcome.audioWait.reason } : {}) };
    await checkLease();
    if (typeof delivery !== 'function') return { status: 'awaiting_delivery', analysisId: stored.analysisId };
    const resume = await store.loadResumableResult({ operation_id: job.id, lease_token: job.lease_token });
    if (!resume) throw new Error('Сохранённый анализ не найден');
    return await delivery({ job, saved: resume, checkLease });
  } finally {
    clearInterval(timer);
    await renewal;
  }
}
