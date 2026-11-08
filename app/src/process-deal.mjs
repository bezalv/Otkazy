import { collectDeal } from './collect/index.mjs';
import { normalizeCommunications } from './collect/normalize.mjs';
import { planAudioWait } from './audio-wait/index.mjs';
import { transcribeCalls } from './calls/index.mjs';
import { buildJournal } from './analysis/journal.mjs';
import { buildCommunicationAnalytics } from './analysis/communication-analytics.mjs';
import { assembleFacts } from './analysis/facts-assembler.mjs';
import { inferChatRoles } from './analysis/chat-role-inference.mjs';
import { processScreenshots } from './screenshots/process.mjs';
import { pgDecide } from './rules/pipeline-gate.mjs';
import { dsEvaluate, dsInsufficientJudge } from './rules/data-sufficiency.mjs';
import { runAgents } from './agents/index.mjs';

/** Обрабатывает одну сделку без записи в БД и без внешних уведомлений. */
export async function processDeal({
  dealId, bitrix, llm, resolveFile, downloadFile, transcribe,
  judgeSystemPrompt, writerSystemPrompt, audioWaitEnabledAt, savedAudioWait = null,
  silent = false, screenshots = true, nowMs = null, clock = Date.now, expectedLoseDate = null, expectedHistoryId = null, wait,
  semanticChatRoles = false, verifyFallbackSession,
}) {
  if (verifyFallbackSession !== undefined && (semanticChatRoles !== true || silent !== true)) {
    throw new Error('Проверка сессии доступна только в тихом ручном эксперименте');
  }
  if (verifyFallbackSession !== undefined && typeof verifyFallbackSession !== 'function') {
    throw new TypeError('Проверка сессии должна быть функцией');
  }
  if (semanticChatRoles === true && silent !== true) {
    throw new Error('Эксперимент определения ролей доступен только в тихом режиме');
  }
  if (typeof judgeSystemPrompt !== 'string' || !judgeSystemPrompt.trim()) {
    throw new Error('Не задан промпт судьи');
  }
  if (typeof clock !== 'function') throw new TypeError('Не заданы часы обработки');
  const startedAt = nowMs ?? clock();
  if (!Number.isFinite(startedAt)) throw new TypeError('Некорректное время обработки');
  const collected = await collectDeal({ client: bitrix, dealId, silent, now: startedAt, wait, expectedLoseDate, expectedHistoryId, requireCurrentHistory: true });
  if (collected.deal_data && expectedLoseDate != null) {
    const expected = new Date(expectedLoseDate).getTime();
    const actual = new Date(collected.deal_data.lose_date).getTime();
    if (!Number.isFinite(expected) || !collected.deal_data.lose_date || !Number.isFinite(actual)) {
      return { status: 'error', collection: { ...collected, _error: 'Неизвестна дата отказа' } };
    }
    if (actual > expected) return { status: 'obsolete_transition', collection: collected };
    if (actual < expected) return { status: 'error', collection: { ...collected, _error: 'История стадий ещё не подтверждает дату отказа' } };
  }
  if (collected._status !== 'pending_normalization') return { status: collected._status, collection: collected };

  // Сбор и ожидание готовности записи могут занять минуты. Сравнивать время
  // завершения звонка с моментом начала сбора означало бы терять новые звонки.
  const evaluatedAt = nowMs ?? clock();
  if (!Number.isFinite(evaluatedAt)) throw new TypeError('Некорректное время обработки');
  const audioWait = planAudioWait({
    stageId: collected.deal_data.stage_id,
    callsComplete: collected._sources.calls.complete,
    calls: collected.raw.calls,
    loseDate: collected.deal_data.lose_date,
    enabledAt: audioWaitEnabledAt,
    saved: savedAudioWait,
    nowMs: evaluatedAt, silent, screenshots,
  });
  // Идентификатор кладётся в отдельную колонку вместе с очередью и переживает
  // перезапуск процесса; timestamp не является идентификатором перехода.
  if (audioWait.queue) audioWait.queue.origin_stage_history_id = String(collected.stage_history[0].ID);
  if (audioWait.action !== 'analyze') return { status: audioWait.action, collection: collected, audioWait };

  const normalized = await normalizeCommunications({
    collection: collected, resolveFile, transcribeVoice: transcribe, screenshots, verifyFallbackSession,
  });
  let chatRoleInferenceStats = null;
  let chatRoleInferenceEvidence = null;
  // Только явный ручной режим для проверки текста. Обычная обработка по умолчанию
  // не подключает эту экспериментальную оценку и не ослабляет защиту источников.
  if (semanticChatRoles === true) {
    const prerequisites = pgDecide({ sources: collected._sources, recognition: { voices: normalized.voice_failures } });
    if (prerequisites.block) return { status: 'blocked', collection: collected, audioWait, pipelineGate: prerequisites };
    const inferred = await inferChatRoles({ communications: normalized.deal_data.communications, client: llm,
      cutoff: collected.deal_data.lose_date, dealId });
    normalized.deal_data.communications = inferred.communications;
    chatRoleInferenceStats = inferred.stats;
    chatRoleInferenceEvidence = inferred.evidence;
  }
  const earlyGate = pgDecide({ sources: collected._sources, communications: normalized.deal_data.communications,
    recognition: { voices: normalized.voice_failures }, allowNonmaterialUnknown: semanticChatRoles === true });
  if (earlyGate.block) return { status: 'blocked', collection: collected, audioWait, pipelineGate: earlyGate,
    ...(chatRoleInferenceStats ? { chatRoleInferenceStats, chatRoleInferenceEvidence } : {}) };

  const calls = await transcribeCalls({ dealData: normalized.deal_data, transcribe });
  const recognition = { calls: calls.transcription_errors, voices: normalized.voice_failures, screenshots: [] };
  const initialGate = pgDecide({ sources: collected._sources, recognition, communications: normalized.deal_data.communications,
    allowNonmaterialUnknown: semanticChatRoles === true });
  if (initialGate.block) return { status: 'blocked', collection: collected, audioWait, calls, pipelineGate: initialGate,
    ...(chatRoleInferenceStats ? { chatRoleInferenceStats, chatRoleInferenceEvidence } : {}) };

  const journalInput = { ...normalized.deal_data, communications: calls.communications, transcription_stats: calls.transcription_stats };
  const analytics = buildCommunicationAnalytics(buildJournal(journalInput), evaluatedAt);
  const screenshotResult = await processScreenshots({ base: analytics, resolveFile, downloadFile, client: llm });
  recognition.screenshots = screenshotResult.failures;
  const pipelineGate = pgDecide({ sources: collected._sources, recognition, communications: calls.communications,
    allowNonmaterialUnknown: semanticChatRoles === true });
  if (pipelineGate.block) return { status: 'blocked', collection: collected, audioWait, calls, pipelineGate,
    ...(chatRoleInferenceStats ? { chatRoleInferenceStats, chatRoleInferenceEvidence } : {}) };

  const prepared = assembleFacts(screenshotResult.output, judgeSystemPrompt);
  const sufficiency = dsEvaluate(prepared.facts_packet.facts);
  prepared._data_enough = sufficiency.enough;
  prepared._data_sufficiency = sufficiency;
  if (!sufficiency.enough) prepared.judge = dsInsufficientJudge(sufficiency);
  const analysis = await runAgents({
    prepared, pipelineGate, analytics: screenshotResult.output,
    screenshotStats: screenshotResult.output.screenshot_stats,
    writerSystemPrompt, client: llm, now: evaluatedAt, rejectUnknownRoleProof: semanticChatRoles === true,
  });
  return {
    status: analysis.pipeline_error ? 'error' : 'processed',
    collection: collected, dealData: normalized.deal_data, audioWait, calls, pipelineGate, analysis,
    ...(chatRoleInferenceStats ? { chatRoleInferenceStats, chatRoleInferenceEvidence } : {}),
  };
}
