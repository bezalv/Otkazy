import { collectDeal } from './collect/index.mjs';
import { normalizeCommunications } from './collect/normalize.mjs';
import { planAudioWait } from './audio-wait/index.mjs';
import { transcribeCalls } from './calls/index.mjs';
import { buildJournal } from './analysis/journal.mjs';
import { buildCommunicationAnalytics } from './analysis/communication-analytics.mjs';
import { assembleFacts } from './analysis/facts-assembler.mjs';
import { processScreenshots } from './screenshots/process.mjs';
import { pgDecide } from './rules/pipeline-gate.mjs';
import { dsEvaluate, dsInsufficientJudge } from './rules/data-sufficiency.mjs';
import { runAgents } from './agents/index.mjs';

/** Обрабатывает одну сделку без записи в БД и без внешних уведомлений. */
export async function processDeal({
  dealId, bitrix, llm, resolveFile, downloadFile, transcribe,
  judgeSystemPrompt, writerSystemPrompt, audioWaitEnabledAt, savedAudioWait = null,
  silent = false, screenshots = true, nowMs = Date.now(), expectedLoseDate = null, wait,
}) {
  if (typeof judgeSystemPrompt !== 'string' || !judgeSystemPrompt.trim()) {
    throw new Error('Не задан промпт судьи');
  }
  const collected = await collectDeal({ client: bitrix, dealId, silent, now: nowMs, wait });
  if (collected.deal_data && expectedLoseDate != null) {
    const expected = new Date(expectedLoseDate).getTime();
    const actual = new Date(collected.deal_data.lose_date).getTime();
    if (!Number.isFinite(expected) || !collected.deal_data.lose_date || !Number.isFinite(actual) || actual !== expected) {
      return { status: 'error', collection: { ...collected, _error: 'Дата отказа изменилась или неизвестна' } };
    }
  }
  if (collected._status !== 'pending_normalization') return { status: collected._status, collection: collected };

  const audioWait = planAudioWait({
    stageId: collected.deal_data.stage_id,
    callsComplete: collected._sources.calls.complete,
    calls: collected.raw.calls,
    loseDate: collected.deal_data.lose_date,
    enabledAt: audioWaitEnabledAt,
    saved: savedAudioWait,
    nowMs, silent, screenshots,
  });
  if (audioWait.action !== 'analyze') return { status: audioWait.action, collection: collected, audioWait };

  const normalized = await normalizeCommunications({
    collection: collected, resolveFile, transcribeVoice: transcribe, screenshots,
  });
  const calls = await transcribeCalls({ dealData: normalized.deal_data, transcribe });
  const recognition = { calls: calls.transcription_errors, voices: normalized.voice_failures, screenshots: [] };
  const initialGate = pgDecide({ sources: collected._sources, recognition });
  if (initialGate.block) return { status: 'blocked', collection: collected, audioWait, calls, pipelineGate: initialGate };

  const journalInput = { ...normalized.deal_data, communications: calls.communications, transcription_stats: calls.transcription_stats };
  const analytics = buildCommunicationAnalytics(buildJournal(journalInput), nowMs);
  const screenshotResult = await processScreenshots({ base: analytics, resolveFile, downloadFile, client: llm });
  recognition.screenshots = screenshotResult.failures;
  const pipelineGate = pgDecide({ sources: collected._sources, recognition });
  if (pipelineGate.block) return { status: 'blocked', collection: collected, audioWait, calls, pipelineGate };

  const prepared = assembleFacts(screenshotResult.output, judgeSystemPrompt);
  const sufficiency = dsEvaluate(prepared.facts_packet.facts);
  prepared._data_enough = sufficiency.enough;
  prepared._data_sufficiency = sufficiency;
  if (!sufficiency.enough) prepared.judge = dsInsufficientJudge(sufficiency);
  const analysis = await runAgents({
    prepared, pipelineGate, analytics: screenshotResult.output,
    screenshotStats: screenshotResult.output.screenshot_stats,
    writerSystemPrompt, client: llm, now: nowMs,
  });
  return {
    status: analysis.pipeline_error ? 'error' : 'processed',
    collection: collected, dealData: normalized.deal_data, audioWait, calls, pipelineGate, analysis,
  };
}
