import { parseJudgeResponse } from './judge.mjs';
import { skipWriterComment, shouldRunWriter, parseWriterResponse } from './writer.mjs';
import { buildFinalOutput } from './final-output.mjs';
import { pgSafeReason } from '../rules/pipeline-gate.mjs';

function providerFailure(error) {
  return Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
    ? `Polza HTTP ${error.status}`
    : 'ошибка вызова модели';
}

function pipelineError(reason, prepared, { parsed, judgeResponse, writerResponse } = {}) {
  const judgeUsage = parsed?.judge_usage || judgeResponse?.usage || {};
  const writerUsage = writerResponse?.usage || {};
  const tokens = (value) => Number.isFinite(value) ? value : 0;
  return {
    deal_id: prepared?.deal_id || null,
    pipeline_error: reason,
    classification: null,
    multi_agent_analysis: null,
    llm_meta: {
      model: parsed?.judge_model || judgeResponse?.model || null,
      prompt_tokens: tokens(judgeUsage.prompt_tokens) + tokens(writerUsage.prompt_tokens),
      completion_tokens: tokens(judgeUsage.completion_tokens) + tokens(writerUsage.completion_tokens),
      total_tokens: tokens(judgeUsage.total_tokens) + tokens(writerUsage.total_tokens),
      warnings: parsed?.proof_warnings || [],
      writer_model: writerResponse?.model || null,
    },
    communications: prepared?.communications || [],
    journal_text: prepared?.journal_text || '',
    analytics_text: prepared?.analytics_text || '',
    full_prompt_text: '',
    comm_analytics: null,
    deal_card: prepared?.deal_card || {},
    transcription_stats: prepared?.transcription_stats || {},
    screenshot_stats: null,
    _block: 'judge_error_handled',
    _ready_for: 'supabase_error_row',
  };
}

/**
 * Запускает Judge и Writer после подтверждённой проверки полноты источников.
 * client.complete(body) возвращает уже разобранный ответ Polza и сам отвечает
 * за таймауты и повторы. При _data_enough=false клиент не вызывается.
 */
export async function runAgents({ prepared, pipelineGate, analytics, screenshotStats, writerSystemPrompt, client, now = Date.now() }) {
  if (pipelineGate?.block === true) {
    return {
      deal_id: prepared?.deal_id || null,
      pipeline_error: pgSafeReason(pipelineGate.pipeline_error || 'Проверка полноты источников не пройдена'),
      gate_kind: pipelineGate.kind || null,
      gate_failures: pipelineGate.failures || [],
      classification: null,
      multi_agent_analysis: null,
      communications: prepared?.communications || null,
      comm_analytics: analytics?.comm_analytics || null,
      journal_text: prepared?.journal_text || '',
      full_prompt_text: analytics?.full_prompt_text || '',
      _block: 'pipeline_gate_blocked',
    };
  }
  if (pipelineGate?.block !== false) {
    return pipelineError('Проверка полноты источников не пройдена', prepared);
  }
  if (!prepared || !prepared.facts_packet || !Array.isArray(prepared.facts_packet.facts)
    || !prepared.facts_packet.facts.every((fact) => fact && typeof fact === 'object' && !Array.isArray(fact))
    || typeof prepared._data_enough !== 'boolean' || !analytics) {
    return pipelineError('Сбой анализа: отсутствуют подготовленные факты или проверка достаточности данных', prepared);
  }
  let parsed;
  let judgeResponse;
  if (!prepared._data_enough) {
    if (prepared.judge?.verdict !== 'недостаточно_данных') {
      return pipelineError('Сбой анализа: отсутствует вердикт проверки достаточности данных', prepared);
    }
    try {
      parsed = parseJudgeResponse({ content: JSON.stringify(prepared.judge) }, prepared, writerSystemPrompt, now);
    } catch {
      return pipelineError('Сбой анализа: неверный формат подготовленных данных', prepared);
    }
    if (!parsed.error) {
      parsed.judge_model = prepared.judge_model || 'none (data-sufficiency gate)';
      parsed.judge_usage = prepared.judge_usage || {};
      parsed.proof_warnings = prepared.proof_warnings || [];
      parsed.proof_errors_count = prepared.proof_errors_count || 0;
      parsed._data_sufficiency = prepared._data_sufficiency;
    }
  } else {
    if (!client || typeof client.complete !== 'function' || !prepared.judge_request_body) {
      return pipelineError('Сбой судьи: клиент или подготовленный запрос отсутствует', prepared);
    }
    try {
      judgeResponse = await client.complete(prepared.judge_request_body, { role: 'judge' });
    } catch (error) {
      return pipelineError(`Сбой судьи: ${providerFailure(error)}`, prepared);
    }
    try {
      parsed = parseJudgeResponse(judgeResponse, prepared, writerSystemPrompt, now);
    } catch {
      return pipelineError('Сбой судьи: неверный формат ответа или подготовленных данных', prepared, { judgeResponse });
    }
  }

  if (parsed.error) return pipelineError(`Сбой судьи: ${parsed.message}`, prepared, { judgeResponse });
  let writerOutput;
  if (shouldRunWriter(parsed.judge)) {
    if (typeof writerSystemPrompt !== 'string' || !writerSystemPrompt.trim()) {
      return pipelineError('Сбой писателя: отсутствует промпт', prepared, { parsed });
    }
    if (!client || typeof client.complete !== 'function') return pipelineError('Сбой писателя: клиент отсутствует', prepared, { parsed });
    let response;
    try {
      response = await client.complete(parsed.writer_request_body, { role: 'writer' });
    } catch (error) {
      return pipelineError(`Сбой писателя: ${providerFailure(error)}`, prepared, { parsed });
    }
    writerOutput = parseWriterResponse(response, parsed);
    if (!writerOutput) return pipelineError('Сбой писателя: пустой ответ модели', prepared, { parsed, writerResponse: response });
  } else {
    writerOutput = {
      ...parsed,
      final_comment: skipWriterComment(parsed.judge),
      writer_model: null,
      writer_usage: null,
      _block: 'writer_skipped',
    };
  }
  return buildFinalOutput(writerOutput, analytics, screenshotStats);
}
