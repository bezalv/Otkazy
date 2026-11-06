import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processDeal } from '../process-deal.mjs';
import { loadPilotBaselines } from './candidates.mjs';
import { runPilotCommand } from './command.mjs';
import { compareWithBaseline, readonlyBitrix } from './index.mjs';
import { describeComposition, PILOT_VERDICTS, PILOT_REASON_CLASSES } from './composition.mjs';
import { diagnoseOutcome } from './diagnostics.mjs';
import { categorizeReasons, compareCallFacts, summarizeJudgeEvidence } from './fact-diff.mjs';

const ALLOWED = new Map([['127142', '2021'], ['126198', '2005']]);
const STATUSES = new Set(['processed', 'waiting', 'skip', 'skipped', 'skipped_by_reason', 'blocked',
  'error', 'obsolete_transition', 'source_incomplete', 'unverified', 'other']);
const safeEnum = (value, allowed) => typeof value === 'string' && allowed.includes(value) ? value : 'unavailable';

/**
 * Выполняет один read-only разбор и сравнивает его в памяти с конкретным
 * сохранённым анализом. Сетевой контур и закрытие ресурсов использует тот же
 * runPilotCommand; сырые факты, текст и идентификаторы наружу не возвращаются.
 */
export async function runInvestigation({ dealId, analysisId, env = process.env,
  runCommand = runPilotCommand, readBaselines = loadPilotBaselines, processFn = processDeal } = {}) {
  if (typeof dealId !== 'string' || typeof analysisId !== 'string' || ALLOWED.get(dealId) !== analysisId) {
    throw new TypeError('Выбранная пара сделки и анализа не подтверждена');
  }
  if (typeof runCommand !== 'function' || typeof readBaselines !== 'function' || typeof processFn !== 'function') {
    throw new TypeError('Некорректные зависимости');
  }
  let detail = null;
  const checkedRead = async (pool, options) => {
    const result = await readBaselines(pool, options);
    if (!result || !Array.isArray(result.baselines) || result.baselines.length !== 1
        || Number(result.baselines[0]?.deal_id) !== Number(dealId)
        || String(result.baselines[0]?.analysis_id) !== analysisId) throw new Error('Эталон изменился');
    return result;
  };
  const makeRunner = deps => {
    const reader = readonlyBitrix(deps.bitrix);
    return { async run({ dealId: currentId, baseline, screenshots }) {
      const id = Number(dealId);
      if (Number(currentId) !== id || Number(baseline?.deal_id) !== id || String(baseline?.analysis_id) !== analysisId
          || baseline.pipeline_error != null || !baseline.lose_date) throw new Error('Эталон не подтверждён');
      deps.signal?.throwIfAborted();
      const saved = baseline.saved_audio_wait ?? null;
      const sameDate = saved?.lose_date && new Date(saved.lose_date).getTime() === new Date(baseline.lose_date).getTime();
      const terminal = ['done', 'expired', 'cancelled'].includes(saved?.state);
      if ((saved?.state === 'waiting' || (terminal && sameDate)) && (typeof saved.origin_stage_history_id !== 'string'
          || !/^[1-9]\d{0,29}$/.test(saved.origin_stage_history_id))) {
        return { status: 'unverified', diagnostic: diagnoseOutcome({ status: 'unverified' }),
          composition: describeComposition(null, baseline), verdict: 'unavailable', reason_class: 'unavailable', facts: { exact: 'unavailable' } };
      }
      const result = await processFn({ dealId: id, bitrix: reader, llm: deps.llm,
        transcribe: deps.transcribe, downloadFile: deps.downloadFile,
        resolveFile: fileId => reader.request('disk.file.get', { id: fileId }),
        judgeSystemPrompt: deps.judgeSystemPrompt, writerSystemPrompt: deps.writerSystemPrompt,
        audioWaitEnabledAt: baseline.audio_wait_enabled_at,
        savedAudioWait: terminal ? { ...saved, _recheck_terminal: true } : saved,
        silent: true, screenshots, clock: Date.now, expectedLoseDate: baseline.lose_date,
        expectedHistoryId: sameDate ? saved.origin_stage_history_id : null,
        ...(deps.signal ? { wait: ms => delay(ms, undefined, { signal: deps.signal }) } : {}) });
      deps.signal?.throwIfAborted();
      const oldFacts = baseline.ai_facts_json?.facts;
      const current = result?.analysis?.multi_agent_analysis;
      const newFacts = current?.facts_packet?.facts;
      const communications = result?.calls?.communications;
      const oldJudge = baseline.ai_judge_json?.multi_agent_analysis ?? baseline.ai_judge_json?.judge ?? baseline.ai_judge_json;
      if (result?.status === 'processed' && Array.isArray(oldFacts) && Array.isArray(newFacts) && Array.isArray(communications)) {
        detail = { verdicts: { previous: safeEnum(baseline.ai_verdict, PILOT_VERDICTS), current: safeEnum(current.verdict, PILOT_VERDICTS) },
          reason_classes: { previous: safeEnum(baseline.ai_reason_class, PILOT_REASON_CLASSES), current: safeEnum(current.closure_reason_class, PILOT_REASON_CLASSES) },
          calls: compareCallFacts({ previousFacts: oldFacts, currentFacts: newFacts, currentCommunications: communications }),
          previous_evidence: summarizeJudgeEvidence(oldJudge, oldFacts, baseline.ai_facts_json?.metrics),
          current_evidence: summarizeJudgeEvidence(current, newFacts, current.facts_packet?.metrics),
          previous_reasons: categorizeReasons(oldJudge), current_reasons: categorizeReasons(current),
          limitations: ['previous_audio_bytes_unverified', 'historical_analysis_origin_unverified',
            'inputs_may_have_changed', 'model_responses_are_nondeterministic'] };
      }
      return { ...compareWithBaseline(result, baseline), diagnostic: diagnoseOutcome(result),
        composition: describeComposition(result, baseline) };
    } };
  };
  const summary = await runCommand({ ids: [dealId], env, readBaselines: checkedRead, makeRunner });
  if (summary?.service_closed !== true) throw new Error('Завершение пилота не подтверждено');
  let status = summary?.status === 'deadline' ? 'deadline' : 'other';
  if (summary?.selected === 1 && summary?.attempted === 1 && summary.statuses && typeof summary.statuses === 'object') {
    const found = Object.entries(summary.statuses);
    if (found.length === 1 && STATUSES.has(found[0][0]) && found[0][1] === 1) status = found[0][0];
  }
  if (status === 'processed' && !detail) status = 'other';
  // Возврат только после закрытия STT, базы и всей прерванной работы. Даже
  // при повреждённой сводке адаптера произвольные поля не выводятся.
  return { status, detail: status === 'processed' ? detail : null, service_closed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) { console.error('Укажите сделку и номер её сохранённого анализа'); process.exitCode = 1; }
  else runInvestigation({ dealId: process.argv[2], analysisId: process.argv[3] })
    .then(value => console.log(JSON.stringify(value)))
    .catch(() => { console.error('Сравнение не завершено'); process.exitCode = 1; });
}
