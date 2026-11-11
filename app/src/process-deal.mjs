import { collectDeal } from './collect/index.mjs';
import { normalizeCommunications, TemporalScopeError } from './collect/normalize.mjs';
import { scopeCollectionAtLose } from './collect/temporal-scope.mjs';
import { planAudioWait } from './audio-wait/index.mjs';
import { transcribeCalls } from './calls/index.mjs';
import { buildJournal } from './analysis/journal.mjs';
import { buildCommunicationAnalytics } from './analysis/communication-analytics.mjs';
import { assembleFacts } from './analysis/facts-assembler.mjs';
import { inferChatRoles } from './analysis/chat-role-inference.mjs';
import { sanitizeRoleInferenceMetadata } from './worker/role-inference-metadata.mjs';
import { getDurableRoleClientLedger } from './worker/durable-role-client.mjs';
import { getRoleInferenceLedgerScope } from './worker/role-inference-ledger.mjs';
import { processScreenshots } from './screenshots/process.mjs';
import { pgDecide } from './rules/pipeline-gate.mjs';
import { dsEvaluate, dsInsufficientJudge } from './rules/data-sufficiency.mjs';
import { runAgents } from './agents/index.mjs';
import { PrejudgeStageError, prepareBeginArtifact, prepareRawCollectionArtifact, prepareTranscriptArtifact, prepareCommunicationsArtifact, prepareJudgeInputArtifact, isLegacyEmptyTranscript } from './persistence/prejudge.mjs';
import { ambiguousProcessingOnly } from './calls/transcript-quality.mjs';
import { supportsSttAttempts, verifiedAudioHash } from './stt-client.mjs';
import { getRoleSessionContextScope } from './worker/role-session-context.mjs';

function blockedTemporalScope(collection, audioWait, source, reason) {
  const sources = { ...collection._sources, [source]: { ...collection._sources[source], complete: false, error: reason } };
  return { status: 'blocked', collection, audioWait, pipelineGate: pgDecide({ sources }) };
}

/** Обрабатывает одну сделку без записи в БД и без внешних уведомлений. */
export async function processDeal({
  dealId, bitrix, llm, resolveFile, downloadFile, transcribe,
  judgeSystemPrompt, writerSystemPrompt, audioWaitEnabledAt, savedAudioWait = null,
  silent = false, screenshots = true, nowMs = null, clock = Date.now, expectedLoseDate = null, expectedHistoryId = null, wait,
  semanticChatRoles = false, verifyFallbackSession, verifyLatestSession, repairProofErrors = false, roleInferenceClient, roleSessionContext,
  prejudgeCheckpoint, prejudgeCheckLease, prejudgeSttHooks,
}) {
  const durableScope = getRoleInferenceLedgerScope(getDurableRoleClientLedger(roleInferenceClient));
  const sessionScope = getRoleSessionContextScope(roleSessionContext);
  const roleCutoffMs = expectedLoseDate == null ? NaN : new Date(expectedLoseDate).getTime();
  const roleCutoff = Number.isFinite(roleCutoffMs) ? new Date(roleCutoffMs).toISOString() : null;
  const durableRole = semanticChatRoles === true && !!durableScope && !!sessionScope
    && durableScope.dealId === String(dealId) && durableScope.stageHistoryId === String(expectedHistoryId)
    && sessionScope.dealId === String(dealId) && sessionScope.stageHistoryId === String(expectedHistoryId)
    && roleCutoff !== null && durableScope.cutoff === roleCutoff && sessionScope.cutoff === roleCutoff;
  if (prejudgeCheckpoint !== undefined && (typeof prejudgeCheckpoint !== 'function'
      || typeof prejudgeCheckLease !== 'function' || expectedHistoryId === null || expectedLoseDate === null)) {
    throw new Error('Для сохранения материалов нужен подтверждённый переход');
  }
  // При staging разрешён лишь внутренний scope-проверенный verifier;
  // произвольный callback не доказывает принадлежность переписки сделке.
  if (prejudgeCheckpoint !== undefined && semanticChatRoles === true) {
    const scope = getRoleSessionContextScope(roleSessionContext);
    if ((silent !== true && !durableRole) || !scope || scope.dealId !== String(dealId) || scope.stageHistoryId !== String(expectedHistoryId)
        || scope.cutoff !== new Date(expectedLoseDate).toISOString()
        || verifyFallbackSession !== roleSessionContext.verify || verifyLatestSession !== roleSessionContext.verify) {
      throw new Error('Для сохранения ролей нужна проверенная сессия и журнал');
    }
  } else if (roleSessionContext !== undefined) {
    throw new Error('Контекст ролей допустим только при сохранении материалов');
  }
  if (prejudgeCheckpoint === undefined && prejudgeCheckLease !== undefined) throw new Error('Не задано сохранение материалов');
  if (prejudgeSttHooks !== undefined && (!prejudgeCheckpoint || typeof prejudgeSttHooks !== 'object'
      || typeof prejudgeSttHooks.beforeStt !== 'function' || typeof prejudgeSttHooks.afterStt !== 'function'
      || !supportsSttAttempts(transcribe))) throw new Error('Не подключены подтверждённые попытки STT');
  if (typeof repairProofErrors !== 'boolean' || (repairProofErrors && (silent !== true || semanticChatRoles !== true))) {
    throw new Error('Исправление доказательств доступно только в тихом ручном эксперименте');
  }
  if (verifyLatestSession !== undefined && (typeof verifyLatestSession !== 'function' || semanticChatRoles !== true
      || (silent !== true && !durableRole) || expectedHistoryId === null || expectedLoseDate === null)) {
    throw new Error('Подтверждение новой сессии доступно только для закреплённого тихого эксперимента');
  }
  if (verifyFallbackSession !== undefined && (semanticChatRoles !== true || (silent !== true && !durableRole))) {
    throw new Error('Проверка сессии доступна только в тихом ручном эксперименте');
  }
  if (verifyFallbackSession !== undefined && typeof verifyFallbackSession !== 'function') {
    throw new TypeError('Проверка сессии должна быть функцией');
  }
  if (semanticChatRoles === true && silent !== true && !durableRole) {
    throw new Error('Эксперимент определения ролей доступен только в тихом режиме');
  }
  if (roleInferenceClient !== undefined && (semanticChatRoles !== true || (silent !== true && !durableRole)
      || expectedHistoryId === null || expectedLoseDate === null || !getDurableRoleClientLedger(roleInferenceClient))) {
    throw new Error('Нужен подтверждённый клиент и переход для определения авторов');
  }
  if (typeof judgeSystemPrompt !== 'string' || !judgeSystemPrompt.trim()) {
    throw new Error('Не задан промпт судьи');
  }
  if (typeof clock !== 'function') throw new TypeError('Не заданы часы обработки');
  const startedAt = nowMs ?? clock();
  if (!Number.isFinite(startedAt)) throw new TypeError('Некорректное время обработки');
  const collected = await collectDeal({ client: bitrix, dealId, silent, now: startedAt, wait, expectedLoseDate, expectedHistoryId,
    requireCurrentHistory: true, verifyLatestSession, ...(durableRole ? { roleSessionContext } : {}) });
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
  // Новый переход не должен ждать записи разговоров, которые начались после
  // отказа. Сохранённые очереди читают прежний набор до отдельной миграции,
  // чтобы ранее отслеженный звонок не был ошибочно признан исчезнувшим.
  let temporal = null;
  if (savedAudioWait === null) {
    temporal = scopeCollectionAtLose(collected, { screenshots });
    if (temporal.error) return blockedTemporalScope(collected, null, temporal.error.source, temporal.error.reason);
  }
  const audioWait = planAudioWait({
    stageId: collected.deal_data.stage_id,
    callsComplete: collected._sources.calls.complete,
    calls: temporal ? temporal.collection.raw.calls : collected.raw.calls,
    loseDate: collected.deal_data.lose_date,
    enabledAt: audioWaitEnabledAt,
    saved: savedAudioWait,
    nowMs: evaluatedAt, silent, screenshots,
  });
  // Идентификатор кладётся в отдельную колонку вместе с очередью и переживает
  // перезапуск процесса; timestamp не является идентификатором перехода.
  if (audioWait.queue) audioWait.queue.origin_stage_history_id = String(collected.stage_history[0].ID);
  if (audioWait.action !== 'analyze') return { status: audioWait.action, collection: collected, audioWait };

  // audio-wait получает неизменённый полный набор, чтобы не повредить уже
  // сохранённые ожидания. Судье и распознаванию — только события до отказа.
  temporal ||= scopeCollectionAtLose(collected, { screenshots });
  if (temporal.error) return blockedTemporalScope(collected, audioWait, temporal.error.source, temporal.error.reason);
  const checkpoint = prejudgeCheckpoint === undefined ? null : async artifact => {
    try {
      const saved = await prejudgeCheckpoint({ dealId:Number(dealId), stageHistoryId:expectedHistoryId,
        loseDate:collected.deal_data.lose_date, artifact });
      if (saved?.saved !== true) throw new Error('Не подтверждено сохранение');
    } catch { throw new PrejudgeStageError(); }
  };
  let stageLeaseLost = false;
  const checkStageLease = async () => {
    if (stageLeaseLost) throw new PrejudgeStageError();
    try { await prejudgeCheckLease(); } catch { stageLeaseLost = true; throw new PrejudgeStageError(); }
  };
  const checkedLlm = checkpoint && typeof llm?.complete === 'function' ? { async complete(...args) {
    await checkStageLease();
    return llm.complete(...args);
  } } : llm;
  // Метка появляется до первого платного голосового/звонка. При аварийном
  // повторе очередь обнаружит её и не заплатит за те же фрагменты вслепую.
  if (checkpoint) {
    await checkpoint(prepareBeginArtifact({sttAttempts:prejudgeSttHooks !== undefined}));
    let rawArtifact;
    try { rawArtifact = prepareRawCollectionArtifact(temporal.collection); }
    catch { throw new PrejudgeStageError(); }
    await checkpoint(rawArtifact);
  }
  const transcribeAndCheckpoint = checkpoint && typeof transcribe === 'function' ? async request => {
    await checkStageLease();
    let response;
    try { response = await transcribe(request,prejudgeSttHooks); }
    catch (error) { if (error instanceof PrejudgeStageError) throw error; if (prejudgeSttHooks) throw new PrejudgeStageError(); throw error; }
    if (isLegacyEmptyTranscript(response)) {
      if (response.audio_sha256 != null && !verifiedAudioHash(response,request)) throw new PrejudgeStageError();
      return { ...response,transcription_coverage:{version:0,status:'unknown_legacy'} };
    }
    // Пустой успешный ответ сохраняем только как проверенную попытку: он не
    // становится ни тишиной, ни доказательством отсутствия разговора. Для него
    // подготовка требует привязку к байтам и непротиворечивое покрытие.
    if (response?.success === true && typeof response.formatted_dialog === 'string'
        && !ambiguousProcessingOnly(response)) {
      let artifact;
      try { artifact = prepareTranscriptArtifact(request, response,{allowEmpty:!response.formatted_dialog.trim()}); }
      catch { throw new PrejudgeStageError(); }
      await checkpoint(artifact);
    }
    return response;
  } : transcribe;
  let normalized;
  try {
    normalized = await normalizeCommunications({
      collection: temporal.collection, resolveFile, transcribeVoice: transcribeAndCheckpoint, screenshots, verifyFallbackSession,
      ...(durableRole ? { roleSessionContext } : {}),
      temporalCutoff: collected.deal_data.lose_date,
    });
  } catch (error) {
    if (error instanceof TemporalScopeError) return blockedTemporalScope(collected, audioWait, error.source, error.message);
    throw error;
  }
  normalized.deal_data.comm_stats.excluded_after_cutoff = temporal.excluded;
  normalized.deal_data._historical_scope_checked = true;
  if (checkpoint) {
    let artifact;
    try { artifact = prepareCommunicationsArtifact(Number(dealId), normalized.deal_data.communications, normalized.voice_failures); }
    catch { throw new PrejudgeStageError(); }
    await checkpoint(artifact);
  }
  let chatRoleInferenceStats = null;
  let chatRoleInferenceEvidence = null;
  let chatRoleInferenceMetadata = null;
  // Роли оцениваются только при явном подключении и подтверждённой сессии;
  // в рабочем обработчике отправку дополнительно защищает журнал попыток.
  if (semanticChatRoles === true) {
    const prerequisites = pgDecide({ sources: collected._sources, recognition: { voices: normalized.voice_failures } });
    if (prerequisites.block) return { status: 'blocked', collection: collected, audioWait, pipelineGate: prerequisites };
    // В ручном staging любая сессия, включая Wazzup с числовым ID,
    // должна быть подтверждена для конкретной сделки до отправки модели.
    const roleClient = roleInferenceClient ?? (checkpoint && checkedLlm
      ? { requireVerifiedSession: true, complete: (...args) => checkedLlm.complete(...args) }
      : llm);
    let inferred;
    try {
      inferred = await inferChatRoles({ communications: normalized.deal_data.communications, client: roleClient,
        cutoff: collected.deal_data.lose_date, dealId });
    } catch {
      // Исключение может последовать после POST, когда точный учёт недоступен.
      return { status:'error', collection:collected, audioWait,
        analysis:{pipeline_error:'Сбой определения авторов'}, chatRoleInferenceUnaccounted:true };
    }
    normalized.deal_data.communications = inferred.communications;
    chatRoleInferenceStats = inferred.stats;
    chatRoleInferenceEvidence = inferred.evidence;
    // Не предполагаем, что каждый LLM-клиент предоставляет статистику
    // физических запросов; отсутствие снимка означает неизвестный расход.
    try {
      const ledger = getDurableRoleClientLedger(roleClient), scope = getRoleInferenceLedgerScope(ledger);
      if (scope && scope.dealId === String(dealId) && scope.stageHistoryId === expectedHistoryId
          && scope.cutoff === new Date(collected.deal_data.lose_date).toISOString()) {
        chatRoleInferenceMetadata = sanitizeRoleInferenceMetadata(chatRoleInferenceStats,
          roleClient.snapshot()?.transport, chatRoleInferenceEvidence, {ledger});
      }
    } catch { chatRoleInferenceMetadata = null; }
  }
  const roleFields = () => chatRoleInferenceStats
    ? { chatRoleInferenceStats, chatRoleInferenceEvidence,
      ...(chatRoleInferenceMetadata ? { chatRoleInferenceMetadata } : {}),
      ...(!chatRoleInferenceMetadata && (chatRoleInferenceStats.model_calls > 0 || roleInferenceClient !== undefined)
        ? {chatRoleInferenceUnaccounted:true} : {}) } : {};
  try {
  const earlyGate = pgDecide({ sources: collected._sources, communications: normalized.deal_data.communications,
    recognition: { voices: normalized.voice_failures }, allowNonmaterialUnknown: semanticChatRoles === true });
  if (earlyGate.block) return { status: 'blocked', collection: collected, audioWait, pipelineGate: earlyGate,
    ...roleFields() };

  const calls = await transcribeCalls({ dealData: normalized.deal_data, transcribe: transcribeAndCheckpoint });
  const recognition = { calls: calls.transcription_errors, voices: normalized.voice_failures, screenshots: [] };
  const initialGate = pgDecide({ sources: collected._sources, recognition, communications: normalized.deal_data.communications,
    allowNonmaterialUnknown: semanticChatRoles === true });
  if (initialGate.block) return { status: 'blocked', collection: collected, audioWait, calls, pipelineGate: initialGate,
    ...roleFields() };

  const journalInput = { ...normalized.deal_data, communications: calls.communications, transcription_stats: calls.transcription_stats };
  const analytics = buildCommunicationAnalytics(buildJournal(journalInput), evaluatedAt);
  const screenshotResult = await processScreenshots({ base: analytics, resolveFile, downloadFile, client: checkedLlm });
  recognition.screenshots = screenshotResult.failures;
  const pipelineGate = pgDecide({ sources: collected._sources, recognition, communications: calls.communications,
    allowNonmaterialUnknown: semanticChatRoles === true });
  if (pipelineGate.block) return { status: 'blocked', collection: collected, audioWait, calls, pipelineGate,
    ...roleFields() };

  const prepared = assembleFacts(screenshotResult.output, judgeSystemPrompt);
  if (checkpoint) {
    let artifact;
    try { artifact = prepareJudgeInputArtifact(Number(dealId), calls.communications, prepared.facts_packet); }
    catch { throw new PrejudgeStageError(); }
    await checkpoint(artifact);
    // Судья должен видеть именно сохранённый пакет. Ссылки скрываются в обоих
    // направлениях, чтобы URL с webhook credential не остались в БД.
    prepared.facts_packet = artifact.payload.facts_packet;
    prepared.deal_card = prepared.facts_packet.deal_card;
    prepared.judge_request_body = { ...prepared.judge_request_body,
      messages:prepared.judge_request_body.messages.map((item,index) => index === 1
        ? { ...item, content:JSON.stringify(prepared.facts_packet,null,2) } : item) };
  }
  const sufficiency = dsEvaluate(prepared.facts_packet.facts);
  prepared._data_enough = sufficiency.enough;
  prepared._data_sufficiency = sufficiency;
  if (!sufficiency.enough) prepared.judge = dsInsufficientJudge(sufficiency);
  if (checkpoint) await checkStageLease();
  const analysis = await runAgents({
    prepared, pipelineGate, analytics: screenshotResult.output,
    screenshotStats: screenshotResult.output.screenshot_stats,
    writerSystemPrompt, client: checkedLlm, now: evaluatedAt, rejectUnknownRoleProof: semanticChatRoles === true,
    repairProofErrors, silent, semanticChatRoles,
  });
  return {
    status: analysis.pipeline_error ? 'error' : 'processed',
    collection: collected, dealData: normalized.deal_data, audioWait, calls, pipelineGate, analysis,
    ...roleFields(),
  };
  } catch (error) {
    if (error instanceof PrejudgeStageError) throw error;
    // После вызова ролей исключение следующих стадий не должно незаметно
    // терять безопасный учёт уже сделанных запросов. Без подтверждённой
    // метаинформации сохраняем прежний контракт исключения.
    if (!chatRoleInferenceMetadata && !(chatRoleInferenceStats?.model_calls > 0)
        && !(chatRoleInferenceStats && roleInferenceClient !== undefined)) throw error;
    return { status:'error', collection:collected, audioWait,
      analysis:{pipeline_error:'Сбой обработки данных сделки'}, ...roleFields() };
  }
}
