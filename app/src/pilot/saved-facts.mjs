import { assembleFacts } from '../analysis/facts-assembler.mjs';
import { dsEvaluate, dsInsufficientJudge } from '../rules/data-sufficiency.mjs';
import { runAgents } from '../agents/index.mjs';

const VERDICTS = new Set(['правомерен', 'неправомерен', 'недостаточно_данных']);
const CLASSES = new Set(['price', 'competitor', 'no_need', 'no_money', 'timing', 'manager_dropped', 'customer_unreachable', 'regulatory', 'other']);
const safeValue = (value, allowed) => allowed.has(value) ? value : null;
const match = (left, right) => left == null || right == null ? 'unavailable' : left === right ? 'match' : 'different';

/**
 * Проверяет текущую ветку судьи/писателя на уже сохранённом пакете фактов.
 * Вход содержит данные сделки: не журналировать его или ответ модели.
 * Адаптер client может вызвать платную Polza только при явном вызове этой функции.
 */
export async function replaySavedFacts({ packet, golden, judgeSystemPrompt, writerSystemPrompt, client, now = Date.now() }) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)
      || !Array.isArray(packet.facts) || !packet.facts.every(f => f && typeof f === 'object' && !Array.isArray(f))
      || !packet.metrics || typeof packet.metrics !== 'object' || Array.isArray(packet.metrics)
      || !packet.deal_card || typeof packet.deal_card !== 'object' || Array.isArray(packet.deal_card)
      || !golden?.judge || typeof golden.judge !== 'object' || !VERDICTS.has(golden.judge.verdict)
      || typeof judgeSystemPrompt !== 'string' || !judgeSystemPrompt.trim()
      || typeof writerSystemPrompt !== 'string' || !writerSystemPrompt.trim()
      || !client || typeof client.complete !== 'function' || !Number.isFinite(now)) throw new TypeError('Некорректный вход сохранённого эталона');

  try {
    // Шаблон и схема запроса берутся из текущего кода, а не старого bench.
    const prepared = assembleFacts({ communications: [], comm_analytics: {} }, judgeSystemPrompt);
    prepared.facts_packet = packet;
    prepared.deal_card = packet.deal_card;
    prepared.judge_request_body.messages[1].content = JSON.stringify(packet, null, 2);
    const sufficiency = dsEvaluate(packet.facts);
    prepared._data_enough = sufficiency.enough;
    prepared._data_sufficiency = sufficiency;
    if (!sufficiency.enough) prepared.judge = dsInsufficientJudge(sufficiency);
    const calls = { judge: 0, writer: 0 };
    const controlledClient = { async complete(body, options) {
      if (!options || !['judge', 'writer'].includes(options.role)) throw new Error('Некорректная роль');
      calls[options.role]++;
      return client.complete(body, options);
    } };
    const result = await runAgents({ prepared, pipelineGate: { block: false },
      analytics: { comm_analytics: packet.metrics, full_prompt_text: '' },
      screenshotStats: null, writerSystemPrompt, client: controlledClient, now });
    const previous = safeValue(golden.judge.verdict, VERDICTS);
    const current = safeValue(result?.multi_agent_analysis?.verdict, VERDICTS);
    const previousClass = safeValue(golden.judge.closure_reason_class, CLASSES);
    const currentClass = safeValue(result?.multi_agent_analysis?.closure_reason_class, CLASSES);
    return {
      scope: 'saved_facts_only', status: result.pipeline_error ? 'error' : current ? 'processed' : 'unknown',
      verdict: { previous, current, comparison: match(previous, current) },
      reason_class: { previous: previousClass, current: currentClass, comparison: match(previousClass, currentClass) },
      facts_count: packet.facts.length, model_calls: calls,
      proof_errors_count: Number.isSafeInteger(result?.multi_agent_analysis?.proof_errors_count)
        ? result.multi_agent_analysis.proof_errors_count : null,
      limitations: ['old_fixture_version', 'collection_and_transcription_not_tested',
        'saved_facts_not_regenerated', 'model_responses_are_nondeterministic', 'semantic_equivalence_not_established'],
    };
  } catch { throw new Error('Не удалось проверить сохранённый эталон'); }
}
