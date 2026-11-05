import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processDeal } from '../../app/src/process-deal.mjs';

const nowMs = Date.parse('2026-11-05T00:00:00Z');
function fixture(overrides = {}) {
  const bitrix = { async request(method, body) {
    if (method === 'crm.deal.userfield.list') return { result: [{ LIST: [{ ID: '1', VALUE: 'Другая' }] }] };
    if (method === 'crm.deal.get') return { result: { ID: '42', STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: '65', UF_CRM_1584703948317: '1' } };
    if (method === 'crm.stagehistory.list') return { result: { items: [{ STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] } };
    if (method === 'crm.activity.list' || method === 'imopenlines.crm.chat.get' || method === 'crm.timeline.comment.list') return { result: [] };
    if (method === 'tasks.task.list') return { result: { tasks: [] } };
    throw new Error(`Неожиданный метод ${method}`);
  } };
  return {
    dealId: 42, bitrix, nowMs, wait: async () => {}, audioWaitEnabledAt: '2026-11-01T00:00:00Z',
    judgeSystemPrompt: 'Промпт судьи', writerSystemPrompt: 'Промпт писателя',
    llm: { async complete() { throw new Error('Модель не должна вызываться'); } },
    ...overrides,
  };
}

test('пустая сделка проходит без модели с вердиктом недостаточно данных', async () => {
  const result = await processDeal(fixture());
  assert.equal(result.status, 'processed');
  assert.equal(result.analysis.multi_agent_analysis.verdict, 'недостаточно_данных');
  assert.equal(result.analysis.multi_agent_analysis.data_sufficiency.enough, false);
});

test('неполный источник блокирует разбор до модели', async () => {
  const args = fixture();
  const original = args.bitrix.request;
  args.bitrix.request = async (method, body) => {
    if (method === 'crm.timeline.comment.list') throw new Error('неполные данные');
    return original(method, body);
  };
  const result = await processDeal(args);
  assert.equal(result.status, 'error');
  assert.equal(result.collection._sources.comments.complete, false);
  assert.equal(result.analysis, undefined);
});

test('неизвестная дата включения ожидания не запускает модель', async () => {
  const result = await processDeal(fixture({ audioWaitEnabledAt: null }));
  assert.equal(result.status, 'source_incomplete');
  assert.equal(result.audioWait.reason, 'audio_wait_dates_missing');
});

test('старое событие не запускает разбор нового перехода в отказ', async () => {
  const result = await processDeal(fixture({ expectedLoseDate: '2026-11-03T00:00:00Z' }));
  assert.equal(result.status, 'obsolete_transition');
  assert.equal(result.analysis, undefined);
});

test('история старше ожидаемого перехода остаётся техническим сбоем', async () => {
  const result = await processDeal(fixture({ expectedLoseDate: '2026-11-05T00:00:00Z' }));
  assert.equal(result.status, 'error');
  assert.match(result.collection._error, /История стадий/);
});

test('ожидание поздней записи останавливает разбор до внешних вызовов', async () => {
  const args = fixture();
  const original = args.bitrix.request;
  args.bitrix.request = async (method, body) => {
    if (method === 'crm.activity.list' && body.filter.TYPE_ID) return { result: [{
      ID: '99', PROVIDER_ID: 'VOXIMPLANT_CALL', COMPLETED: 'Y',
      CREATED: '2026-11-04T00:01:00Z', START_TIME: '2026-11-04T00:01:00Z',
      END_TIME: '2026-11-04T00:02:00Z', FILES: [],
    }] };
    return original(method, body);
  };
  const result = await processDeal(args);
  assert.equal(result.status, 'waiting');
  assert.deepEqual(result.audioWait.queue.pending_calls, ['99']);
  assert.equal(result.analysis, undefined);
});

test('звонок, завершившийся во время сбора, оценивается по актуальному времени', async () => {
  const initial = Date.parse('2026-11-05T00:00:00Z');
  let clockCalls = 0;
  const args = fixture({ nowMs: null, clock: () => clockCalls++ === 0 ? initial : initial + 180000 });
  const original = args.bitrix.request;
  args.bitrix.request = async (method, body) => {
    if (method === 'crm.activity.list' && body.filter.TYPE_ID) return { result: [{
      ID: '99', PROVIDER_ID: 'VOXIMPLANT_CALL', COMPLETED: 'Y',
      CREATED: '2026-11-05T00:01:00Z', START_TIME: '2026-11-05T00:01:00Z',
      END_TIME: '2026-11-05T00:02:00Z', FILES: [],
    }] };
    return original(method, body);
  };
  const result = await processDeal(args);
  assert.equal(result.status, 'waiting');
  assert.deepEqual(result.audioWait.queue.pending_calls, ['99']);
  assert.equal(result.audioWait.queue.first_seen_at, '2026-11-05T00:03:00.000Z');
});

test('ошибка скриншота блокирует судью', async () => {
  const args = fixture({ resolveFile: async () => { throw new Error('file not available'); } });
  const original = args.bitrix.request;
  args.bitrix.request = async (method, body) => {
    if (method === 'crm.timeline.comment.list') return { result: [{
      ID: 1, AUTHOR_ID: 65, CREATED: '2026-11-03T00:00:00Z', COMMENT: 'Подробное содержательное замечание менеджера',
      FILES: { 1: { id: 1, type: 'image', date: '2026-11-03T00:00:00Z' } },
    }] };
    return original(method, body);
  };
  const result = await processDeal(args);
  assert.equal(result.status, 'blocked');
  assert.equal(result.pipelineGate.kind, 'recognition');
  assert.equal(result.analysis, undefined);
});

test('содержательный комментарий доходит до судьи через все проверки', async () => {
  let calls = 0;
  const judge = {
    verdict: 'правомерен', verdict_reason_short: 'Клиент отказался', recoverable_level: null,
    closure_reason_class: 'other', misplaced: false, correct_stage: null,
    exact_reason: 'Клиент отказался.', manager_mistakes: [], key_signals: [],
    risk_factors: [], questions_for_manager: [],
  };
  const args = fixture({ llm: { async complete() {
    calls++;
    return { model: 'openai/gpt-6-sol', choices: [{ message: { content: JSON.stringify(judge) } }] };
  } } });
  const original = args.bitrix.request;
  args.bitrix.request = async (method, body) => {
    if (method === 'crm.timeline.comment.list') return { result: [{
      ID: 1, AUTHOR_ID: 65, CREATED: '2026-11-03T00:00:00Z',
      COMMENT: 'Клиент сообщил, что уже заказал окна в другом месте.', FILES: {},
    }] };
    return original(method, body);
  };
  const result = await processDeal(args);
  assert.equal(result.status, 'processed');
  assert.equal(result.analysis.multi_agent_analysis.verdict, 'правомерен');
  assert.equal(calls, 1);
});
