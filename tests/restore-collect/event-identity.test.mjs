import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectDeal } from '../../app/src/collect/index.mjs';
import { processDeal } from '../../app/src/process-deal.mjs';

const NOW = Date.parse('2026-11-05T00:00:00Z');
const EXPECTED = '2026-11-04T00:00:00Z';
const first = { ID: '101', STAGE_ID: 'C23:LOSE', CREATED_TIME: EXPECTED };
const second = { ID: '100', STAGE_ID: 'C23:NEW', CREATED_TIME: '2026-11-03T00:00:00Z' };

function fixture(pages, { reason = '3297' } = {}) {
  const calls = [];
  const client = { async request(method, body) {
    calls.push(method);
    if (method === 'crm.deal.userfield.list') return { result: [{ LIST: [{ ID: reason, VALUE: reason === '3297' ? 'дубль' : 'Другая' }] }] };
    if (method === 'crm.deal.get') return { result: { ID: '42', STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: '65', UF_CRM_1584703948317: reason } };
    if (method === 'crm.stagehistory.list') return pages(body);
    if (method === 'crm.activity.list' || method === 'crm.timeline.comment.list' || method === 'imopenlines.crm.chat.get') return { result: [] };
    if (method === 'tasks.task.list') return { result: { tasks: [] } };
    throw new Error('Неожиданный метод');
  } };
  return { client, calls };
}

async function collect(pages, options = {}) {
  const { client, calls } = fixture(pages);
  const result = await collectDeal({ client, dealId: 42, expectedHistoryId: '101', expectedLoseDate: EXPECTED,
    now: NOW, wait: async () => {}, ...options });
  return { result, calls };
}

test('подтверждённые ID и дата допускают технический пропуск', async () => {
  const { result } = await collect(() => ({ result: { items: [first, second] }, total: 2 }));
  assert.equal(result._status, 'skipped_by_reason');
});

test('совпадающее время в разных поясах не подтверждает порядок переходов', async () => {
  for (const stage of ['C23:NEW', 'C23:LOSE']) {
    const { result, calls } = await collect(() => ({ result: { items: [first,
      { ID: '100', STAGE_ID: stage, CREATED_TIME: '2026-11-04T07:00:00+07:00' }] }, total: 2 }));
    assert.equal(result._status, 'error');
    assert.equal(calls.includes('crm.activity.list'), false);
  }
});

test('совпадение времени на границе страниц обнаруживается после чтения второй страницы', async () => {
  const seen = [];
  const { result } = await collect(body => {
    seen.push(body.start);
    return body.start === 0 ? { result: { items: [first] }, total: 2, next: 1 }
      : { result: { items: [{ ...second, CREATED_TIME: '2026-11-04T07:00:00+07:00' }] }, total: 2 };
  });
  assert.deepEqual(seen, [0, 1]);
  assert.equal(result._status, 'error');
});

test('ранее объявленный размер истории проверяется даже если total исчез на последней странице', async () => {
  const { result } = await collect(body => body.start === 0
    ? { result: { items: [first] }, total: 3, next: 1 }
    : { result: { items: [second] } });
  assert.equal(result._status, 'error');
});

test('ошибка, неполная страница, повтор ID и нарушение сортировки блокируют анализ', async () => {
  for (const page of [
    { result: { items: [first] }, total: 2 },
    { result: { items: [first, { ...second, ID: '101' }] }, total: 2 },
    { result: { items: [first, { ...second, CREATED_TIME: '2026-11-06T00:00:00Z' }] }, total: 2 },
    { result: { items: [first, { ...second, CREATED_TIME: 'bad' }] }, total: 2 },
    { result: { items: [first, { ...second, CREATED_TIME: '2026-11-03T00:00:00.000500Z' }] }, total: 2 },
    { result: { items: [{ ...first, CREATED_TIME: '2026-11-04T00:00:00.000500Z' }, second] }, total: 2 },
    { result: { items: [first] }, next: 50 },
    { result: { items: [{ ...first, STAGE_ID: 'C23:NEW' }, second] }, total: 2 },
  ]) {
    const { result, calls } = await collect(() => page);
    assert.equal(result._status, 'error');
    assert.equal(calls.includes('crm.activity.list'), false);
  }
});

test('обновившийся переход не обрабатывается как прежний, а неизвестный ID не считается успешным', async () => {
  const newer = { ...first, ID: '102', CREATED_TIME: '2026-11-04T01:00:00Z' };
  const obsolete = await collect(() => ({ result: { items: [newer, first, second] }, total: 3 }));
  assert.equal(obsolete.result._status, 'obsolete_transition');
  const unknown = await collect(() => ({ result: { items: [{ ...first, ID: '102' }, second] }, total: 2 }));
  assert.equal(unknown.result._status, 'error');
});

test('processDeal не превращает неоднозначную историю в разбор или комментарий', async () => {
  const { client, calls } = fixture(() => ({ result: { items: [first, { ...second, CREATED_TIME: EXPECTED }] } }));
  const result = await processDeal({ bitrix: client, dealId: 42, expectedHistoryId: '101', expectedLoseDate: EXPECTED,
    judgeSystemPrompt: 'prompt', nowMs: NOW, wait: async () => {} });
  assert.equal(result.status, 'error');
  assert.equal(result.analysis, undefined);
  assert.equal(calls.includes('crm.activity.list'), false);
});

test('подтверждённое событие проходит полный конвейер с недостаточными данными', async () => {
  const { client } = fixture(() => ({ result: { items: [first, second] }, total: 2 }), { reason: '1' });
  const result = await processDeal({ bitrix: client, dealId: 42, expectedHistoryId: '101', expectedLoseDate: EXPECTED,
    judgeSystemPrompt: 'Промпт судьи', writerSystemPrompt: 'Промпт писателя', nowMs: NOW, wait: async () => {},
    audioWaitEnabledAt: '2026-11-01T00:00:00Z', llm: { async complete() { throw new Error('Модель не должна вызываться'); } } });
  assert.equal(result.status, 'processed');
  assert.equal(result.analysis.multi_agent_analysis.verdict, 'недостаточно_данных');
});

test('свежий переход после ожидания повторно проверяет ID, а не только дату', async () => {
  let reads = 0;
  const current = { ...first, CREATED_TIME: '2026-11-04T23:59:00Z' };
  const { client, calls } = fixture(() => ({ result: { items: [++reads === 1 ? current : { ...current, ID: '102' }, second] } }), { reason: '1' });
  const result = await collectDeal({ client, dealId: 42, expectedHistoryId: '101', expectedLoseDate: current.CREATED_TIME, now: NOW, wait: async () => {} });
  assert.equal(result._status, 'error');
  assert.equal(calls.includes('crm.activity.list'), false);
});
