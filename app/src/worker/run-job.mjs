import { processDeal } from '../process-deal.mjs';

// Входом служит только уже захваченное задание. Ошибки сохранения или потери
// аренды не превращаются в результат сделки и оставляются очереди на восстановление.
export function toPersistenceResult(job, outcome) {
  const base = { deal_id: Number(job.deal_id), operation_id: job.id, lease_token: job.lease_token, silent: job.silent === true };
  const collection = outcome?.collection || {};
  if (outcome?.status === 'processed') return {
    ...base, ...outcome.analysis, _status: 'processed', deal_data: outcome.dealData,
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
    _error: outcome?.pipelineGate?.pipeline_error || outcome?.analysis?.pipeline_error || collection._error
      || (outcome?.status === 'source_incomplete' ? 'сбор неполный: не установлены данные для ожидания записи' : 'Сбой обработки сделки'),
  };
}

/**
 * Все зависимости передаются извне, реальных сетевых вызовов здесь нет.
 * delivery вызывается лишь после сохранения результата либо его восстановления.
 */
export async function runJob({ job, queue, store, loadAudioWait, delivery, process = processDeal, processOptions = {}, heartbeatMs = 60000 }) {
  if (!job?.id || !job?.lease_token || !job?.deal_id || !job?.lose_date) throw new TypeError('Не задано захваченное задание');
  if (!queue?.renew || !store?.loadResumableResult || !store?.persistResult || typeof loadAudioWait !== 'function') {
    throw new TypeError('Не заданы зависимости обработки');
  }
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1000) throw new TypeError('Некорректный интервал аренды');
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
    let outcome;
    try {
      // Ручной и ночной повторы должны видеть поздно появившиеся записи,
      // даже если предыдущий цикл ожидания уже завершён. Старую очередь при
      // этом не открываем повторно и её прежний срок не продлеваем.
      const recheckTerminalAudio = ['manual', 'nightly'].includes(job.trigger_type)
        && audioWait && ['done', 'expired', 'cancelled'].includes(audioWait.state);
      outcome = await process({ ...processOptions, dealId: Number(job.deal_id), expectedLoseDate: job.lose_date,
        silent: job.silent === true, screenshots: job.screenshots === true,
        savedAudioWait: recheckTerminalAudio ? { ...audioWait, _recheck_terminal: true } : audioWait });
    } catch {
      // Исключения нормализации не должны исчезать вместе с процессом.
      outcome = { status: 'error', collection: { _error: 'Сбой обработки данных сделки' } };
    }
    await checkLease();
    if (outcome?.status === 'obsolete_transition') {
      if (typeof queue.finishObsoleteTransition !== 'function'
        || !await queue.finishObsoleteTransition(job.id, job.lease_token)) {
        throw new Error('Не удалось завершить устаревший переход');
      }
      return { status: 'obsolete' };
    }
    const result = toPersistenceResult(job, outcome);
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
