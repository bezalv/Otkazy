import { parseJudgeResponse } from './judge.mjs';
import { skipWriterComment, shouldRunWriter, parseWriterResponse } from './writer.mjs';
import { buildFinalOutput } from './final-output.mjs';
import { pgSafeReason } from '../rules/pipeline-gate.mjs';

function providerFailure(error) {
  return Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
    ? `Polza HTTP ${error.status}`
    : 'ошибка вызова модели';
}

// Только для явно выбранного ручного опыта. Модель видит тот же facts_packet и
// свой предыдущий ответ, но не может менять исходные факты. Проверка ссылок
// остаётся формальной: она не доказывает смысловую верность свободного текста.
const REPAIR_INSTRUCTION = 'В предыдущем ответе найдены формальные ошибки ссылок на доказательства. '
  + 'Перепроверь каждое утверждение и каждый proof_fact_ids по исходному набору фактов. '
  + 'client_statement должен ссылаться на слова клиента из коммуникации, manager_statement — на слова менеджера, '
  + 'crm_comment — на CRM-комментарий, metric — только на существующую определённую метрику. '
  + 'Если утверждение не подтверждается ссылкой, исправь или удали его; раздели утверждения с разными типами доказательств. '
  + 'Не меняй факты и не придумывай источники. Самостоятельно пересмотри вердикт при необходимости. '
  + 'Верни полный исправленный JSON по прежней схеме.';
const USAGE_FIELDS = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
function addUsage(responses) {
  const total = Object.fromEntries(USAGE_FIELDS.map(key => [key, 0]));
  for (const response of responses) {
    if (!response?.usage || !USAGE_FIELDS.every(key => Number.isSafeInteger(response.usage[key]) && response.usage[key] >= 0)) return null;
    for (const key of USAGE_FIELDS) {
      total[key] += response.usage[key];
      if (!Number.isSafeInteger(total[key])) return null;
    }
  }
  return total;
}
function repairInfo(initial, status) {
  return { attempted:true, judge_calls:2, status, initial_errors:initial.proof_errors_count,
    initial_warnings:initial.proof_warnings || [], limitations:['formal_checks_only','free_text_not_validated'] };
}
// Дополнительные формальные проверки действуют только в ручном опыте.
// Для absence разрешены смешанные ссылки на факты и метрики: это прямо
// предусмотрено промптом. Эти проверки не оценивают смысл утверждения.
function strictProofChecks(parsed, prepared) {
  const warnings = [...(parsed.proof_warnings || [])];
  const facts = new Map((prepared.facts_packet?.facts || []).map(fact => [fact.fact_id, fact]));
  const metrics = prepared.facts_packet?.metrics || {};
  let extra = 0;
  function add(path, code, issue) { warnings.push({path, code, issue, severity:'error'}); extra++; }
  for (const category of ['manager_mistakes','key_signals','risk_factors']) {
    parsed.judge[category].forEach((item,index) => {
      const path=`${category}[${index}]`;
      if (item.proof_type !== 'absence' && item.proof_fact_ids.length === 0) {
        add(path,'proof_missing','Для этого типа утверждения не указано доказательство');
      }
      for (const ref of item.proof_fact_ids) {
        const metric=ref.startsWith('metric:');
        if ((item.proof_type === 'metric' && !metric)
            || (['client_statement','manager_statement','crm_comment'].includes(item.proof_type) && metric)) {
          add(path,'proof_type_mismatch','Тип доказательства не соответствует виду ссылки');
        }
        // Унаследованные свойства Object.prototype не являются метриками.
        // Обычный validateProofs уже ловит undefined; здесь добираем свойства,
        // которые существуют только на прототипе (constructor, toString).
        if (metric && !Object.hasOwn(metrics,ref.slice(7)) && metrics[ref.slice(7)] !== undefined) {
          add(path,'proof_missing_metric','Ссылка не относится к полям метрик');
        }
        if (metric && Object.hasOwn(metrics,ref.slice(7)) && metrics[ref.slice(7)] === null
            && !warnings.some(w => w.path === path && w.code === 'unknown_nonmaterial_metric_as_proof'
              && w.issue === `metric ${ref.slice(7)} не определена из-за неизвестного автора сообщения`)) {
          add(path,'proof_null_metric','Ссылка на неопределённую метрику');
        }
        const fact=metric ? null : facts.get(ref);
        if (fact?.actor === 'unknown' && ['client_statement','manager_statement'].includes(item.proof_type)
            && ['call_transcript','chat','chat_voice_transcript','screenshot_chat'].includes(fact.source)
            && fact.unknown_role_nonmaterial !== 'semantic_inference') {
          add(path,'proof_unknown_actor','Слова участника с неизвестной ролью нельзя приписывать стороне');
        }
      }
    });
  }
  return {...parsed,proof_warnings:warnings,proof_errors_count:parsed.proof_errors_count+extra};
}
function repairFailure(reason, prepared, initial, responses, corrected = null) {
  const parsed = corrected?.proof_warnings ? { ...initial, proof_warnings:[...(initial.proof_warnings || []), ...corrected.proof_warnings] } : initial;
  const result = pipelineError(reason, prepared, { parsed });
  const usage = addUsage(responses);
  result.llm_meta.proof_repair = repairInfo(initial, 'failed');
  result.llm_meta.judge_usage_complete = usage !== null && responses.length === 2;
  // Не считаем отсутствующий ответ бесплатным: попытка могла быть оплачена.
  if (!result.llm_meta.judge_usage_complete) for (const key of USAGE_FIELDS) result.llm_meta[key] = null;
  else for (const key of USAGE_FIELDS) result.llm_meta[key] = usage[key];
  return result;
}
function afterRepairFailure(reason, prepared, options, repaired) {
  const result = pipelineError(reason, prepared, options);
  if (repaired) {
    result.llm_meta.proof_repair = repairInfo(repaired.initial, 'corrected');
    result.llm_meta.judge_usage_complete = repaired.usage !== null;
    result.llm_meta.usage_complete = false;
    for (const key of USAGE_FIELDS) result.llm_meta[key] = null;
  }
  return result;
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
export async function runAgents({ prepared, pipelineGate, analytics, screenshotStats, writerSystemPrompt, client, now = Date.now(),
  rejectUnknownRoleProof = false, repairProofErrors = false, silent = false, semanticChatRoles = false }) {
  if (repairProofErrors === true && (silent !== true || semanticChatRoles !== true)) {
    throw new Error('Исправление доказательств доступно только в тихом ручном эксперименте');
  }
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
  let repaired = null;
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
  if (repairProofErrors === true) parsed = strictProofChecks(parsed, prepared);
  if (repairProofErrors === true && parsed.proof_errors_count > 0) {
    if (!prepared._data_enough || !judgeResponse || !Array.isArray(prepared.judge_request_body?.messages)) {
      return pipelineError('Сбой анализа: неподтверждённые ссылки судьи', prepared, { parsed, judgeResponse });
    }
    const initial = parsed, firstResponse = judgeResponse;
    const repairRequest = { ...prepared.judge_request_body, messages:[...prepared.judge_request_body.messages,
      { role:'assistant', content:JSON.stringify(initial.judge) }, { role:'user', content:REPAIR_INSTRUCTION }] };
    let secondResponse;
    try { secondResponse = await client.complete(repairRequest, { role:'judge' }); }
    catch { return repairFailure('Сбой анализа: не удалось повторно проверить ссылки судьи', prepared, initial, [firstResponse]); }
    let corrected;
    try { corrected = parseJudgeResponse(secondResponse, prepared, writerSystemPrompt, now); }
    catch { return repairFailure('Сбой анализа: неверный повторный ответ судьи', prepared, initial, [firstResponse,secondResponse]); }
    // parseJudgeResponse поддерживает извлечение объекта регуляркой для
    // совместимости с n8n. В повторном ответе требуем JSON целиком.
    const complete = secondResponse?.choices?.[0]?.finish_reason === 'stop';
    if (!corrected.error && complete && corrected.judge_parse_method === 'direct') corrected = strictProofChecks(corrected, prepared);
    if (corrected.error || !complete || corrected.judge_parse_method !== 'direct' || corrected.proof_errors_count > 0) {
      return repairFailure('Сбой анализа: ссылки судьи остались неподтверждёнными', prepared, initial, [firstResponse,secondResponse], corrected);
    }
    repaired = { initial, responses:[firstResponse,secondResponse], usage:addUsage([firstResponse,secondResponse]) };
    corrected.judge_usage = repaired.usage;
    parsed = corrected;
    judgeResponse = secondResponse;
  }
  // В эксперименте короткая реакция с неизвестным автором не может стать
  // доказанной репликой стороны или основанием по неопределённой метрике.
  // Проверяем до вызова писателя; прежнюю политику остальных ошибок не меняем.
  if (rejectUnknownRoleProof === true && (parsed.proof_warnings || []).some((warning) =>
    ['unknown_nonmaterial_as_statement', 'unknown_nonmaterial_metric_as_proof'].includes(warning.code))) {
    return afterRepairFailure('Сбой анализа: судья использовал данные с неизвестным автором как подтверждённое доказательство',
      prepared, { parsed, judgeResponse }, repaired);
  }
  let writerOutput;
  if (shouldRunWriter(parsed.judge)) {
    if (typeof writerSystemPrompt !== 'string' || !writerSystemPrompt.trim()) {
      return afterRepairFailure('Сбой писателя: отсутствует промпт', prepared, { parsed }, repaired);
    }
    if (!client || typeof client.complete !== 'function') return afterRepairFailure('Сбой писателя: клиент отсутствует', prepared, { parsed }, repaired);
    let response;
    try {
      response = await client.complete(parsed.writer_request_body, { role: 'writer' });
    } catch (error) {
      return afterRepairFailure(`Сбой писателя: ${providerFailure(error)}`, prepared, { parsed }, repaired);
    }
    writerOutput = parseWriterResponse(response, parsed);
    if (!writerOutput) return afterRepairFailure('Сбой писателя: пустой ответ модели', prepared, { parsed, writerResponse: response }, repaired);
  } else {
    writerOutput = {
      ...parsed,
      final_comment: skipWriterComment(parsed.judge),
      writer_model: null,
      writer_usage: null,
      _block: 'writer_skipped',
    };
  }
  const output = buildFinalOutput(writerOutput, analytics, screenshotStats);
  if (repaired) {
    output.multi_agent_analysis.proof_repair = repairInfo(repaired.initial, 'corrected');
    output.multi_agent_analysis.judge_usage = repaired.usage;
    output.llm_meta.judge_usage_complete = repaired.usage !== null;
    // Учитываем отсутствие статистики писателя, если он действительно вызывался.
    const writerCalled = shouldRunWriter(parsed.judge);
    const writerUsage = writerCalled ? addUsage([{ usage:writerOutput.writer_usage }]) : Object.fromEntries(USAGE_FIELDS.map(key=>[key,0]));
    const totalUsage = repaired.usage && writerUsage ? addUsage([{usage:repaired.usage},{usage:writerUsage}]) : null;
    output.llm_meta.usage_complete = totalUsage !== null;
    for (const key of USAGE_FIELDS) output.llm_meta[key] = totalUsage?.[key] ?? null;
  }
  return output;
}
