import test from 'node:test';
import assert from 'node:assert/strict';
import { managerCommentGuard } from '../../app/src/agents/manager-comment-guard.mjs';
import { runAgents } from '../../app/src/agents/index.mjs';
import { collectDeal } from '../../app/src/collect/index.mjs';

const comment = { fact_id: 'f001', source: 'crm_comment', actor: 'manager', content: 'Клиент заказал окна у конкурента.' };
const client = { fact_id: 'f002', source: 'chat', actor: 'client', content: 'Я уже заказал окна в другом месте.' };
const judge = { verdict: 'правомерен', verdict_reason_short: 'Клиент выбрал конкурента', recoverable_level: null,
  closure_reason_class: 'competitor', misplaced: false, correct_stage: null, exact_reason: 'Клиент заказал у конкурента.',
  manager_mistakes: [], key_signals: [], risk_factors: [], questions_for_manager: [] };
const response = value => ({ model: 'openai/gpt-6-sol', choices: [{ message: { content: JSON.stringify(value) } }] });

test('причина клиента не устанавливается только по комментарию менеджера', () => {
  assert.deepEqual(managerCommentGuard(judge, [comment]), { block: true, reason: 'client_refusal_without_client_words' });
  assert.equal(managerCommentGuard({ ...judge, closure_reason_class: 'other' }, [comment]).block, true);
  assert.equal(managerCommentGuard({ ...judge, closure_reason_class: 'other', verdict_reason_short: 'Клиент сказал, что передумал.' }, [comment]).block, true);
  for (const cls of ['price', 'competitor', 'no_need', 'no_money', 'timing']) {
    assert.equal(managerCommentGuard({ ...judge, closure_reason_class: cls,
      verdict_reason_short: 'Закрыто правомерно', exact_reason: 'Причина указана в CRM.' }, [comment]).block, true, cls);
  }
});

test('неподтверждённый отказ останавливается до писателя и не выдаёт вердикт', async () => {
  for (const facts of [[comment], [comment, { ...client, content: 'Здравствуйте!' }]]) {
    let calls = 0;
    const result = await runAgents({ prepared: { deal_id: 42, facts_packet: { facts, metrics: {} },
    deal_card: {}, communications: [], journal_text: '', analytics_text: '', transcription_stats: {},
    judge_request_body: { model: 'openai/gpt-6-sol' }, _data_enough: true },
    pipelineGate: { block: false }, analytics: {}, writerSystemPrompt: 'Промпт',
    client: { async complete() { calls++; return response({ ...judge, manager_mistakes: [
      { mistake: 'Ошибка', proof_type: 'crm_comment', proof_fact_ids: ['f001'] },
    ] }); } } });
    assert.equal(calls, 1);
    assert.equal(result.multi_agent_analysis, null);
    assert.match(result.pipeline_error, /отказ клиента не подтверждён/);
  }
});

test('непустая прямая реплика клиента допускает дальнейшую проверку судьёй', () => {
  assert.equal(managerCommentGuard(judge, [comment, client]).block, false);
  assert.equal(managerCommentGuard(judge, [comment, { ...client, actor: 'unknown' }]).block, true);
  assert.equal(managerCommentGuard(judge, [comment, { ...client, content: '   ' }]).block, true);
  assert.equal(managerCommentGuard(judge, [comment, { ...client, source: 'crm_comment' }]).block, true);
});

test('одно лишь приветствие клиента не подтверждает отказ из комментария менеджера', () => {
  for (const content of ['Здравствуйте', '  ЗДРАВСТВУЙТЕ!  ', 'Добрый день.', 'Добрый вечер', 'Доброе утро', 'Алло?', 'Привет…']) {
    assert.deepEqual(managerCommentGuard(judge, [comment, { ...client, content }]),
      { block: true, reason: 'client_refusal_without_client_words' }, content);
  }
  assert.equal(managerCommentGuard(judge, [comment, { ...client, content: 'Здравствуйте' },
    { ...client, fact_id: 'f003', content: 'Добрый день!' }]).block, true);
  for (const content of ['Нет', 'Дорого', 'Не надо', 'Я уже заказал', 'Здравствуйте, нет',
    'Здравствуйте, подскажите цену', 'Алло, заказывать не буду']) {
    assert.equal(managerCommentGuard(judge, [comment, { ...client, content }]).block, false, content);
  }
  assert.equal(managerCommentGuard(judge, [comment, { ...client, content: 'Привет' }, client]).block, false);
});

test('приветствие не меняет недозвон или подтверждённый технический отказ', () => {
  const greeting = { ...client, content: 'Здравствуйте!' };
  const unreachable = { ...judge, closure_reason_class: 'customer_unreachable',
    verdict_reason_short: 'Клиент не отвечает на обращения', exact_reason: 'Попытки дозвона подтверждены метриками.' };
  assert.equal(managerCommentGuard(unreachable, [comment, greeting]).block, false);
  const factory = { ...comment, content: 'Производство отказало: технически невозможно изготовление.' };
  const internal = { ...judge, closure_reason_class: 'other', verdict_reason_short: 'Технический отказ производства',
    exact_reason: 'Производство не может изготовить конструкцию.' };
  assert.equal(managerCommentGuard(internal, [factory, greeting]).block, false);
});

test('недозвон по метрикам и подтверждённый технический отказ завода не отсекаются', () => {
  const unreachable = { ...judge, closure_reason_class: 'customer_unreachable',
    verdict_reason_short: 'Клиент не отвечает на обращения', exact_reason: 'Попытки дозвона подтверждены метриками.' };
  assert.equal(managerCommentGuard(unreachable, [comment]).block, false);
  const factory = { ...comment, content: 'Производство отказало: технически невозможно изготовление.' };
  const internal = { ...judge, closure_reason_class: 'other', verdict_reason_short: 'Технический отказ производства',
    exact_reason: 'Производство не может изготовить конструкцию.' };
  assert.equal(managerCommentGuard(internal, [factory]).block, false);
  assert.equal(managerCommentGuard({ ...internal, exact_reason:
    'Клиент сообщил о старом доме, производство отказало технически.' }, [factory]).block, false);
  assert.deepEqual(managerCommentGuard(internal, [comment]), { block: true, reason: 'factory_refusal_without_fact' });
  assert.deepEqual(managerCommentGuard({ ...internal, lose_reason: 'Отказано заводом' }, [comment]),
    { block: true, reason: 'factory_refusal_without_fact' });
  assert.equal(managerCommentGuard(internal, [{ ...comment, content: 'Плохие перекрытия, монтаж технически невозможен.' }]).block, false);
  for (const content of ['Производство не отказало, техническая возможность есть.',
    'Завод не отказал.', 'Отказа завода не было.', 'Это не засыпной дом.', 'Дом не засыпной.',
    'Клиент отказался, завод может изготовить.', 'Завод может изготовить, клиент отказался.',
    'Мы не производим такое?', 'Что с заказом? Мы не производим такое?']) {
    assert.deepEqual(managerCommentGuard(internal, [{ ...comment, content }]),
      { block: true, reason: 'factory_refusal_without_fact' }, content);
  }
  assert.equal(managerCommentGuard(internal, [{ ...comment, content:
    'Не производим такое? Завод отказал технически.' }]).block, false);
});

test('фраза об интерпретации менеджера не считается прямой речью клиента', () => {
  const unclear = { ...judge, verdict: 'недостаточно_данных', closure_reason_class: 'other',
    verdict_reason_short: 'Нет подтверждения',
    exact_reason: 'Менеджер указал, что клиент отказался; прямого подтверждения нет.' };
  assert.equal(managerCommentGuard(unclear, [comment]).block, false);
  for (const exact_reason of ['Нет подтверждения, что клиент отказался.', 'Нельзя утверждать, что клиент отказался.',
    'Не доказано, что клиент заказал у конкурента.']) {
    assert.equal(managerCommentGuard({ ...unclear, exact_reason }, [comment]).block, false, exact_reason);
  }
  assert.equal(managerCommentGuard({ ...unclear, verdict: 'правомерен', exact_reason:
    'Менеджер указал, что клиент отказался. Клиент заказал окна у конкурента.' }, [comment]).block, true);
  assert.equal(managerCommentGuard({ ...unclear, verdict: 'правомерен', exact_reason:
    'Менеджер указал, что клиент отказался, но клиент купил у конкурента.' }, [comment]).block, true);
});

test('дубль по причине 3297 пропускается до сбора общения и вызова судьи', async () => {
  const methods = [];
  const bitrix = { async request(method) {
    methods.push(method);
    if (method === 'crm.deal.userfield.list') return { result: [{ LIST: [{ ID: '3297', VALUE: 'Дубль' }] }] };
    if (method === 'crm.deal.get') return { result: { ID: '42', STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: '65', UF_CRM_1584703948317: '3297' } };
    if (method === 'crm.stagehistory.list') return { result: { items: [{ STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] } };
    throw new Error('Нельзя собирать общение дубля');
  } };
  const result = await collectDeal({ client: bitrix, dealId: 42, now: Date.parse('2026-11-05T00:00:00Z'), wait: async () => {} });
  assert.equal(result._status, 'skipped_by_reason');
  assert.equal(result._skip_reason_key, 'дубль');
  assert.equal(methods.includes('crm.activity.list'), false);
});
