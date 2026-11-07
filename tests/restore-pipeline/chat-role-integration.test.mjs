import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processDeal } from '../../app/src/process-deal.mjs';
import { runJob } from '../../app/src/worker/run-job.mjs';

const LOSE = '2026-11-04T12:00:00Z';
const NOW = Date.parse('2026-11-05T00:00:00Z');
const baseMessages = () => ({
  1: { id: 1, senderid: 55, date: '2026-11-04T10:00:00Z', text: '=== Исходящее сообщение ===\nМожем предложить вам замену окна.' },
  2: { id: 2, senderid: 55, date: '2026-11-04T10:01:00Z', text: 'Нет, спасибо, мы уже заказали окна в другом месте.' },
});

function fixture({ messages = baseMessages(), enabled = true, response = 'ok', incomplete = false } = {}) {
  const calls = { roles: 0, judge: 0, stt: 0, requests: [], roleBody: null, judgeBody: null };
  const bitrix = { async request(method, body) {
    if (method === 'crm.deal.userfield.list') return { result: [{ LIST: [{ ID: '1', VALUE: 'Другая' }] }] };
    if (method === 'crm.deal.get') return { result: { ID: '42', STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: '65', UF_CRM_1584703948317: '1' } };
    if (method === 'crm.stagehistory.list') return { result: { items: [{ ID: '101', STAGE_ID: 'C23:LOSE', CREATED_TIME: LOSE }] } };
    if (method === 'crm.activity.list' && body.filter.PROVIDER_ID === 'IMOPENLINES_SESSION') return { result: [{ ASSOCIATED_ENTITY_ID: '80' }] };
    if (method === 'imopenlines.crm.chat.get') return { result: [{ CHAT_ID: 100, CONNECTOR_ID: 'wazzup', CONNECTOR_TITLE: 'wazzup' }] };
    if (method === 'imopenlines.session.history.get') return { result: { chat: { 100: {} }, users: { 55: { connector: true } }, message: messages, files: {} } };
    if (method === 'crm.activity.list') return { result: [] };
    if (method === 'crm.timeline.comment.list') { if (incomplete) throw new Error('source incomplete'); return { result: [] }; }
    if (method === 'tasks.task.list') return { result: { tasks: [] } };
    throw new Error(`Unexpected method ${method}`);
  } };
  const llm = { async complete(body, options = {}) {
    calls.requests.push(options.role);
    if (options.role === 'chat-role-inference') {
      calls.roles++; calls.roleBody = body;
      if (response === 'error') throw new Error('TEST ERROR');
      if (response === 'bad-json') return { choices: [{ finish_reason: 'stop', message: { content: '{' } }] };
      const entries = JSON.parse(body.messages[1].content).messages;
      const roles = entries.map((item, i) => {
        const role = i === 0 ? 'manager' : response === 'unknown' ? 'unknown' : 'client';
        return { id: item.id, role, impact: role === 'unknown' ? 'material_or_unclear' : 'not_applicable' };
      });
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ roles }) } }] };
    }
    if (options.role === 'judge') {
      calls.judge++; calls.judgeBody = body;
      const judge = { verdict: 'правомерен', verdict_reason_short: 'Клиент отказался', recoverable_level: null,
        closure_reason_class: 'competitor', misplaced: false, correct_stage: null, exact_reason: 'Клиент уже заказал окна.',
        manager_mistakes: [], key_signals: [], risk_factors: [], questions_for_manager: [] };
      return { choices: [{ message: { content: JSON.stringify(judge) } }] };
    }
    throw new Error(`Unexpected model role ${options.role}`);
  } };
  const args = { dealId: 42, bitrix, llm, semanticChatRoles: enabled, nowMs: NOW, wait: async () => {},
    silent: true, audioWaitEnabledAt: '2026-11-01T00:00:00Z', judgeSystemPrompt: 'Тестовый промпт', writerSystemPrompt: 'Тест писателя',
    resolveFile: async () => ({ name: 'voice.ogg', url: 'https://example.invalid/voice.ogg' }),
    transcribe: async () => { calls.stt++; return { success: true, formatted_dialog: 'Участник чата: Я уже заказал окна в другом месте' }; },
  };
  return { args, calls };
}

test('выключенный режим оставляет защиту и модель не вызывается', async () => {
  const { args, calls } = fixture({ enabled: false });
  const result = await processDeal(args);
  assert.equal(result.status, 'blocked'); assert.equal(result.pipelineGate.kind, 'author_ambiguous');
  assert.equal(calls.roles, 0); assert.equal(calls.judge, 0);
});

test('ручной эксперимент передаёт судье контекстную роль с происхождением', async () => {
  const { args, calls } = fixture();
  const result = await processDeal(args);
  assert.equal(result.status, 'processed'); assert.equal(calls.roles, 1); assert.equal(calls.judge, 1);
  assert.equal(result.chatRoleInferenceStats.model_calls, 1);
  assert.equal(result.chatRoleInferenceStats.usage, null);
  assert.equal(result.chatRoleInferenceEvidence[0].messages[1].predicted_role, 'client');
  assert.doesNotMatch(JSON.stringify(result.chatRoleInferenceEvidence), /окна|wazzup/);
  const packet = JSON.parse(calls.judgeBody.messages[1].content);
  const inferred = packet.facts.find(f => f.content.includes('уже заказали окна'));
  assert.equal(inferred.actor, 'client'); assert.equal(inferred.role_source, 'semantic_inference');
  assert.equal(result.analysis.multi_agent_analysis.facts_packet.facts.find(f => f.fact_id === inferred.fact_id).role_source, 'semantic_inference');
});

function neutralFixture(badProof = null) {
  const texts = [
    'Добрый день, нужно поставить две створки на готовое окно. Сможете?',
    '👍', '👍',
    '=== Исходящее сообщение ===\nМы можем предложить только полную замену окна.',
    'Сколько будет стоить заменить такое окно?',
    '=== Исходящее сообщение ===\nСтоимость назовём после замера специалиста.',
    'Нам уже не нужно менять окно, другие варианты у нас есть.',
    '=== Исходящее сообщение ===\nПоняла вас, отменяю выезд специалиста.',
  ];
  const messages = Object.fromEntries(texts.map((text, i) => [i + 1, {
    id: i + 1, senderid: 55, date: `2026-11-04T10:0${i}:00Z`, text,
  }]));
  const { args, calls } = fixture({ messages });
  calls.writer = 0;
  args.llm = { async complete(body, options = {}) {
    if (options.role === 'chat-role-inference') {
      calls.roles++;
      const entries = JSON.parse(body.messages[1].content).messages;
      const expected = ['client', 'unknown', 'unknown', 'manager', 'client', 'manager', 'client', 'manager'];
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ roles: entries.map((entry, i) => ({
        id: entry.id, role: expected[i], impact: expected[i] === 'unknown' ? 'not_material' : 'not_applicable',
      })) }) } }] };
    }
    if (options.role === 'judge') {
      calls.judge++; calls.judgeBody = body;
      const packet = JSON.parse(body.messages[1].content);
      const neutral = packet.facts.find(f => f.unknown_role_nonmaterial === 'semantic_inference');
      const refs = badProof === 'fact' ? [neutral.fact_id] : badProof === 'metric' ? ['metric:chats_client'] : [];
      const judge = { verdict: 'правомерен', verdict_reason_short: 'Клиент отказался', recoverable_level: null,
        closure_reason_class: 'other', misplaced: false, correct_stage: null, exact_reason: 'Клиент отказался от замены.',
        manager_mistakes: badProof ? [{ mistake: 'Ошибка', proof_type: badProof === 'metric' ? 'metric' : 'client_statement', proof_fact_ids: refs }] : [],
        key_signals: [], risk_factors: [], questions_for_manager: [] };
      return { choices: [{ message: { content: JSON.stringify(judge) } }] };
    }
    if (options.role === 'writer') { calls.writer++; throw new Error('Писатель не должен вызываться'); }
    throw new Error('Неожиданная модель');
  } };
  return { args, calls };
}

test('две неизвестные реакции в дальнейшем диалоге не становятся клиентом и не блокируют эксперимент', async () => {
  const { args, calls } = neutralFixture();
  const result = await processDeal(args);
  assert.equal(result.status, 'processed');
  assert.equal(result.chatRoleInferenceStats.nonmaterial_unknown, 2);
  const packet = JSON.parse(calls.judgeBody.messages[1].content);
  const reactions = packet.facts.filter(f => f.unknown_role_nonmaterial === 'semantic_inference');
  assert.equal(reactions.length, 2);
  assert.ok(reactions.every(f => f.actor === 'unknown' && f.content === '👍'));
  assert.equal(packet.metrics.chats_client, null);
  assert.ok(result.analysis.multi_agent_analysis.proof_warnings.some(w => w.code === 'unknown_nonmaterial_present'));
});

test('ошибочная ссылка на реакцию или неопределённую метрику останавливает анализ до писателя', async () => {
  for (const proof of ['fact', 'metric']) {
    const { args, calls } = neutralFixture(proof);
    const result = await processDeal(args);
    assert.equal(result.status, 'error', proof);
    assert.match(result.analysis.pipeline_error, /неизвестным автором/, proof);
    assert.equal(calls.writer, 0, proof);
  }
});

test('unknown, сбой модели и некорректный JSON оставляют защиту и не запускают судью', async () => {
  for (const response of ['unknown', 'error', 'bad-json']) {
    const { args, calls } = fixture({ response }); const result = await processDeal(args);
    assert.equal(result.status, 'blocked', response); assert.equal(result.pipelineGate.kind, 'author_ambiguous', response);
    assert.equal(result.chatRoleInferenceStats.model_calls, 1, response);
    if (response === 'unknown') assert.equal(result.chatRoleInferenceEvidence[0].messages[1].predicted_role, 'unknown');
    else assert.deepEqual(result.chatRoleInferenceEvidence, []);
    assert.equal(calls.roles, 1, response); assert.equal(calls.judge, 0, response); assert.equal(result.analysis, undefined, response);
  }
});

test('голосовое транскрибируется отдельно, но модель ролей и судья не запускаются', async () => {
  const messages = baseMessages(); messages[2] = { id: 2, senderid: 55, date: '2026-11-04T10:01:00Z', text: '', params: { FILE_ID: [7] } };
  const { args, calls } = fixture({ messages }); const result = await processDeal(args);
  assert.equal(calls.stt, 1); assert.equal(calls.roles, 0); assert.equal(calls.judge, 0);
  assert.equal(result.status, 'blocked'); assert.equal(result.pipelineGate.kind, 'author_ambiguous');
});

test('неполный источник не вызывает модель ролей', async () => {
  const { args, calls } = fixture({ incomplete: true }); const result = await processDeal(args);
  assert.notEqual(result.status, 'processed'); assert.equal(calls.roles, 0); assert.equal(calls.judge, 0);
});

test('текст после даты отказа не передаётся модели и оставляет защиту', async () => {
  const messages = baseMessages(); messages[3] = { id: 3, senderid: 55, date: '2026-11-04T13:00:00Z', text: 'ПОЗДНЕЕ_СООБЩЕНИЕ' };
  const { args, calls } = fixture({ messages }); const result = await processDeal(args);
  assert.equal(calls.roles, 1); assert.doesNotMatch(JSON.stringify(calls.roleBody), /ПОЗДНЕЕ_СООБЩЕНИЕ/);
  assert.equal(result.status, 'blocked'); assert.equal(result.pipelineGate.kind, 'author_ambiguous'); assert.equal(calls.judge, 0);
});

test('эксперимент не запускается через очередь, записывающее хранилище или доставку', async () => {
  const { args, calls } = fixture({ response: 'unknown' }); let delivered = 0, saved = 0;
  const job = { id: 'job', lease_token: 'lease', deal_id: 42, lose_date: LOSE, trigger_type: 'manual', silent: true };
  await assert.rejects(runJob({ job, queue: { async renew() { return true; } }, loadAudioWait: async () => null,
    processOptions: args, delivery: async () => { delivered++; }, store: {
      async loadResumableResult() { return null; }, async persistResult() { saved++; return { status: 'error', needsExternalActions: false }; },
    },
  }), /без записи и доставки/);
  assert.equal(calls.roles, 0); assert.equal(calls.judge, 0); assert.equal(saved, 0); assert.equal(delivered, 0);
});

test('эксперимент отвергает нетихий вызов до сбора и модели', async () => {
  const { args, calls } = fixture(); args.silent = false;
  await assert.rejects(processDeal(args), /только в тихом режиме/);
  assert.equal(calls.roles, 0); assert.equal(calls.judge, 0);
});
