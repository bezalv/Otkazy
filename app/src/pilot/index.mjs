import { processDeal } from '../process-deal.mjs';
import { diagnoseOutcome } from './diagnostics.mjs';
import { describeComposition } from './composition.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// Методы перечислены явно: запрещённые вызовы не доходят даже до адаптера.
const READ_METHODS = new Set([
  'crm.deal.userfield.list', 'crm.deal.get', 'crm.stagehistory.list',
  'crm.activity.list', 'crm.timeline.comment.list', 'imopenlines.crm.chat.get',
  'imopenlines.session.history.get', 'imopenlines.v2.Session.list', 'tasks.task.list', 'disk.file.get',
]);
const VERDICTS = new Set(['правомерен', 'неправомерен', 'недостаточно_данных']);

/** Единственный интерфейс Битрикса, доступный функции пилота. */
export function readonlyBitrix(client) {
  if (!client || typeof client.request !== 'function') throw new TypeError('Не задан клиент чтения Битрикса');
  return Object.freeze({
    request(method, body, options) {
      if (typeof method !== 'string' || !READ_METHODS.has(method)) throw new Error('Метод Битрикса запрещён в пилоте');
      return client.request(method, body, options);
    },
  });
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

function factsPacket(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.facts)) return null;
  return value.facts;
}

function compareValue(previous, current) {
  return previous == null || current == null ? 'unavailable' : previous === current ? 'match' : 'different';
}

/** Только структурное сравнение; одинаковый вердикт не доказывает одинаковую методологию. */
export function compareWithBaseline(result, baseline) {
  if (!result || typeof result !== 'object' || !baseline || typeof baseline !== 'object') throw new TypeError('Нет результата сравнения');
  const current = result.analysis?.multi_agent_analysis;
  const oldFacts = factsPacket(baseline.ai_facts_json);
  const newFacts = factsPacket(current?.facts_packet);
  let exact = 'unavailable';
  if (oldFacts && newFacts) {
    try { exact = canonical(oldFacts) === canonical(newFacts) ? 'match' : 'different'; }
    catch { exact = 'unavailable'; }
  }
  return {
    status: typeof result.status === 'string' ? result.status : 'unknown',
    verdict: compareValue(VERDICTS.has(baseline.ai_verdict) ? baseline.ai_verdict : null,
      VERDICTS.has(current?.verdict) ? current.verdict : null),
    reason_class: compareValue(typeof baseline.ai_reason_class === 'string' ? baseline.ai_reason_class : null,
      typeof current?.closure_reason_class === 'string' ? current.closure_reason_class : null),
    facts: { previous_count: oldFacts?.length ?? null, current_count: newFacts?.length ?? null, exact },
    limitations: ['historical_inputs_may_have_changed', 'historical_transition_not_verified',
      'model_responses_are_nondeterministic', 'semantic_equivalence_not_established'],
  };
}

/**
 * Вызов одной явно выбранной сделки, без БД, очереди, доставки и HTTP-сервера.
 * Адаптеры LLM/медиа должны быть доверенными; это не песочница для чужого кода.
 */
export function createPilotRunner({ bitrix, llm, transcribe, downloadFile,
  judgeSystemPrompt, writerSystemPrompt, clock = Date.now, signal }) {
  readonlyBitrix(bitrix); // Проверка зависимости до выполнения.
  if (!llm || typeof llm.complete !== 'function' || typeof transcribe !== 'function'
      || typeof downloadFile !== 'function' || typeof clock !== 'function'
      || typeof judgeSystemPrompt !== 'string' || !judgeSystemPrompt.trim()
      || typeof writerSystemPrompt !== 'string' || !writerSystemPrompt.trim()) throw new TypeError('Неполные зависимости пилота');

  return Object.freeze({
    async run({ dealId, baseline, screenshots = true }) {
      signal?.throwIfAborted();
      const id = Number(dealId);
      if (!Number.isSafeInteger(id) || id <= 0 || !baseline || Number(baseline.deal_id) !== id
          || typeof screenshots !== 'boolean' || baseline.pipeline_error != null || !baseline.lose_date
          || !Number.isFinite(new Date(baseline.lose_date).getTime())) throw new TypeError('Некорректный эталон пилота');
      const saved = baseline.saved_audio_wait ?? null;
      const sameDate = saved?.lose_date && new Date(saved.lose_date).getTime() === new Date(baseline.lose_date).getTime();
      const terminal = ['done', 'expired', 'cancelled'].includes(saved?.state);
      // Историческое ожидание без ID невозможно надёжно связать с переходом.
      if ((saved?.state === 'waiting' || (terminal && sameDate)) && (typeof saved.origin_stage_history_id !== 'string'
          || !/^[1-9]\d{0,29}$/.test(saved.origin_stage_history_id))) {
        return { status: 'unverified', reason: 'audio_origin_missing', diagnostic: diagnoseOutcome({ status: 'unverified' }),
          composition: describeComposition(null, baseline), limitations: ['manual_review_required'] };
      }
      const trace = { lastMethod: null, httpStatus: null };
      const reader = readonlyBitrix({ request(method, body, options) {
        trace.lastMethod = method;
        trace.httpStatus = null;
        try {
          return Promise.resolve(bitrix.request(method, body, options)).catch(error => {
            trace.httpStatus = Number.isInteger(error?.status) ? error.status : null;
            throw error;
          });
        } catch (error) {
          trace.httpStatus = Number.isInteger(error?.status) ? error.status : null;
          throw error;
        }
      } });
      try {
        const result = await processDeal({
          dealId: id, bitrix: reader, llm, transcribe, downloadFile,
          resolveFile: fileId => reader.request('disk.file.get', { id: fileId }),
          judgeSystemPrompt, writerSystemPrompt, audioWaitEnabledAt: baseline.audio_wait_enabled_at,
          savedAudioWait: terminal ? { ...saved, _recheck_terminal: true } : saved,
          silent: true, screenshots, clock, expectedLoseDate: baseline.lose_date,
          expectedHistoryId: sameDate ? saved.origin_stage_history_id : null,
          ...(signal ? { wait: ms => delay(ms, undefined, { signal }) } : {}),
        });
        signal?.throwIfAborted();
        return { ...compareWithBaseline(result, baseline), diagnostic: diagnoseOutcome(result, trace),
          composition: describeComposition(result, baseline), screenshots_enabled: screenshots };
      } catch {
        signal?.throwIfAborted();
        return { status: 'error', diagnostic: diagnoseOutcome({ status: 'exception' }),
          verdict: 'unavailable', reason_class: 'unavailable', facts: { previous_count: null, current_count: null, exact: 'unavailable' },
          composition: describeComposition(null, baseline),
          screenshots_enabled: screenshots, limitations: ['manual_review_required'] };
      }
    },
  });
}
