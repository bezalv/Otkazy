import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareWithBaseline, createPilotRunner, readonlyBitrix } from '../../app/src/pilot/index.mjs';
import { createPilotDependencies } from '../../app/src/pilot/dependencies.mjs';

const date = '2026-11-04T00:00:00Z';
const old = { deal_id: 42, lose_date: date, audio_wait_enabled_at: '2026-11-01T00:00:00Z',
  ai_verdict: 'недостаточно_данных', ai_reason_class: null, ai_facts_json: { facts: [] }, pipeline_error: null };

function mockBitrix(seen = []) {
  return { async request(method) {
    seen.push(method);
    if (method === 'crm.deal.userfield.list') return { result: [{ LIST: [{ ID: '1', VALUE: 'Другая' }] }] };
    if (method === 'crm.deal.get') return { result: { ID: '42', STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: '65', UF_CRM_1584703948317: '1' } };
    if (method === 'crm.stagehistory.list') return { result: { items: [{ ID: '101', STAGE_ID: 'C23:LOSE', CREATED_TIME: date }] } };
    if (['crm.activity.list', 'imopenlines.crm.chat.get', 'crm.timeline.comment.list'].includes(method)) return { result: [] };
    if (method === 'tasks.task.list') return { result: { tasks: [] } };
    throw new Error('Неожиданный метод');
  } };
}

function runner(bitrix = mockBitrix()) {
  return createPilotRunner({ bitrix, clock: () => Date.parse('2026-11-05T00:00:00Z'),
    judgeSystemPrompt: 'судья', writerSystemPrompt: 'писатель',
    llm: { async complete() { throw new Error('Модель не должна вызываться'); } },
    async transcribe() { throw new Error('Аудио не должно обрабатываться'); },
    async downloadFile() { throw new Error('Файлы не должны скачиваться'); },
    get pool() { throw new Error('Нет доступа к базе'); },
    get delivery() { throw new Error('Нет доступа к доставке'); },
  });
}

test('белый список блокирует запись и неизвестные методы до вызова адаптера', async () => {
  const seen = [];
  const reader = readonlyBitrix({ async request(method) { seen.push(method); return {}; } });
  for (const method of ['crm.timeline.comment.add', 'crm.deal.update', 'im.notify.system.add', 'event.bind',
    'CRM.DEAL.GET', 'crm.deal.get?x=1', 'disk.file.delete', 'batch', null]) {
    assert.throws(() => reader.request(method, {}), /запрещён/);
  }
  assert.deepEqual(seen, []);
  for (const method of ['crm.deal.userfield.list', 'crm.deal.get', 'crm.stagehistory.list', 'crm.activity.list',
    'crm.timeline.comment.list', 'imopenlines.crm.chat.get', 'imopenlines.session.history.get', 'tasks.task.list', 'disk.file.get']) {
    await reader.request(method, {});
  }
  assert.equal(seen.length, 9);
  assert.deepEqual(Object.keys(reader), ['request']);
  assert.equal(Object.isFrozen(reader), true);
});

test('ручной пилот вызывает чистый processDeal, не принимает доставку/БД и не раскрывает содержимое', async () => {
  const seen = [];
  const data = { ...old, secret_client_information: 'example-client-private-value' };
  const result = await runner(mockBitrix(seen)).run({ dealId: 42, baseline: data });
  assert.equal(result.status, 'processed');
  assert.equal(result.verdict, 'match');
  assert.equal(result.screenshots_enabled, true);
  assert.equal(result.limitations.includes('semantic_equivalence_not_established'), true);
  assert.equal(JSON.stringify(result).includes(data.secret_client_information), false);
  assert.ok(seen.includes('crm.deal.get'));
  assert.ok(seen.every(method => !/\.add$|\.update$|\.delete$|notify|bind/.test(method)));
});

test('разные или неполные факты обозначаются как отличие или недоступность', () => {
  const result = { status: 'processed', analysis: { multi_agent_analysis: { verdict: 'правомерен', closure_reason_class: 'price',
    facts_packet: { facts: [{ z: 2, a: 1 }] } } } };
  const baseline = { ai_verdict: 'неправомерен', ai_reason_class: 'price', ai_facts_json: { facts: [{ a: 1, z: 2 }] } };
  assert.deepEqual(compareWithBaseline(result, baseline).facts, { previous_count: 1, current_count: 1, exact: 'match' });
  assert.equal(compareWithBaseline(result, baseline).verdict, 'different');
  assert.equal(compareWithBaseline(result, baseline).reason_class, 'match');
  assert.equal(compareWithBaseline({ status: 'error' }, baseline).facts.exact, 'unavailable');
  assert.equal(compareWithBaseline(result, { ...baseline, ai_facts_json: null }).facts.exact, 'unavailable');
  assert.equal(compareWithBaseline(result, { ...baseline, ai_facts_json: { facts: [{ a: 2, z: 2 }] } }).facts.exact, 'different');
});

test('неизвестное происхождение ожидания останавливает пилот до сети', async () => {
  const seen = [];
  const result = await runner(mockBitrix(seen)).run({ dealId: 42, baseline: { ...old,
    saved_audio_wait: { state: 'waiting', lose_date: date, origin_stage_history_id: null } } });
  assert.equal(result.status, 'unverified');
  assert.equal(result.reason, 'audio_origin_missing');
  assert.deepEqual(seen, []);
});

test('неверная сделка или старая ошибка отклоняются до сети', async () => {
  const seen = [];
  await assert.rejects(runner(mockBitrix(seen)).run({ dealId: 43, baseline: old }), /эталон/);
  await assert.rejects(runner(mockBitrix(seen)).run({ dealId: 42, baseline: { ...old, pipeline_error: 'ошибка' } }), /эталон/);
  assert.deepEqual(seen, []);
});

test('конструирование реальных адаптеров не выполняет сетевые вызовы', () => {
  let requests = 0;
  const deps = createPilotDependencies({ bitrixBaseUrl: 'https://example.invalid/rest/1/test-token', polzaKey: 'test-only',
    sttUrl: 'http://127.0.0.1:45678', sttKey: 'test-only', tempRoot: process.cwd(),
    async fetchImpl() { requests++; throw new Error('сеть не должна вызываться'); } });
  assert.equal(requests, 0);
  assert.throws(() => deps.bitrix.request('crm.deal.update', {}), /запрещён/);
  assert.equal(requests, 0);
  deps.close();
});
