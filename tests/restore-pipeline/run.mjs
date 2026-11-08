import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processDeal } from '../../app/src/process-deal.mjs';
import { runJob } from '../../app/src/worker/run-job.mjs';

const nowMs = Date.parse('2026-11-05T00:00:00Z');
function fixture(overrides = {}) {
  const bitrix = { async request(method, body) {
    if (method === 'crm.deal.userfield.list') return { result: [{ LIST: [{ ID: '1', VALUE: 'Другая' }] }] };
    if (method === 'crm.deal.get') return { result: { ID: '42', STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: '65', UF_CRM_1584703948317: '1' } };
    if (method === 'crm.stagehistory.list') return { result: { items: [{ ID: '101', STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] } };
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

test('комментарий доходит до судьи, но не доказывает слова клиента', async () => {
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
  assert.equal(result.status, 'error');
  assert.equal(result.analysis.multi_agent_analysis, null);
  assert.match(result.analysis.pipeline_error, /отказ клиента не подтверждён/);
  assert.equal(calls, 1);
});

function withChat(args, connector, messages) {
  const original = args.bitrix.request;
  args.bitrix.request = async (method, body) => {
    if (method === 'crm.activity.list' && body.filter.PROVIDER_ID === 'IMOPENLINES_SESSION') return { result: [{ ASSOCIATED_ENTITY_ID: '80' }] };
    if (method === 'imopenlines.crm.chat.get') return { result: [{ CHAT_ID: 100, CONNECTOR_ID: connector, CONNECTOR_TITLE: connector }] };
    if (method === 'imopenlines.session.history.get') return { result: {
      sessionId: 80, chatId: 100,
      chat: { 100: {} }, users: { 55: { connector: true, name: 'Wazzup App' } }, message: messages, files: {},
    } };
    return original(method, body);
  };
  return args;
}

test('неоднозначный автор Wazzup блокирует вердикт и доставку, ошибка сохраняется', async () => {
  const args = withChat(fixture(), 'wazzup', {
    1: { id: 1, senderid: 55, text: '=== Исходящее сообщение, автор: Иван (Иван Иванов) ===\nМы вам перезвоним' },
    2: { id: 2, senderid: 55, text: 'Сообщение без указания стороны' },
  });
  let llmCalls = 0, deliveries = 0, stored;
  args.llm = { async complete() { llmCalls++; throw new Error('Модель вызвана'); } };
  const job = { id: 'job', lease_token: 'lease', deal_id: 42, lose_date: '2026-11-04T00:00:00Z', trigger_type: 'manual', silent: false };
  const outcome = await runJob({ job, queue: { async renew() { return true; } }, loadAudioWait: async () => null,
    processOptions: args, delivery: async () => { deliveries++; },
    store: {
      async loadResumableResult() { return null; },
      async persistResult(result) { stored = result; return { status: result._status, needsExternalActions: result._status === 'processed' }; },
    },
  });
  assert.equal(outcome.status, 'error');
  assert.equal(stored._status, 'error');
  assert.match(stored._error, /автор сообщения чата/);
  assert.equal(llmCalls, 0);
  assert.equal(deliveries, 0);
});

test('явное исходящее Wazzup и обычный Wappi не блокируются ограничением автора', async () => {
  for (const [connector, text] of [['wazzup', '=== Исходящее сообщение, автор: Иван (Иван Иванов) ===\nХорошо'], ['wappi', 'Да']]) {
    const result = await processDeal(withChat(fixture(), connector, { 1: { id: 1, senderid: 55, text } }));
    assert.equal(result.status, 'processed', connector);
    assert.equal(result.pipelineGate.block, false, connector);
  }
});

test('неизвестный коннектор при неопределённом авторе блокирует вызов судьи', async () => {
  for (const missingMetadata of [false, true]) {
    let llmCalls = 0;
    const args = withChat(fixture(), '', { 1: { id: 1, senderid: 55, text: 'Мы заказали окна в другом месте' } });
    if (missingMetadata) {
      const request = args.bitrix.request;
      args.bitrix.request = async (method, body) => method === 'imopenlines.crm.chat.get' ? { result: [] } : request(method, body);
    }
    args.llm = { async complete() { llmCalls++; throw new Error('Модель вызвана'); } };
    const result = await processDeal(args);
    assert.equal(result.status, 'blocked');
    assert.equal(result.pipelineGate.kind, 'chat_connector_unknown');
    assert.equal(llmCalls, 0);
  }
});

test('неоднозначное голосовое Wazzup блокируется и при успешной, и при неудачной расшифровке', async () => {
  for (const succeeds of [true, false]) {
    let sttCalls = 0;
    const args = withChat(fixture({
      resolveFile: async () => ({ name: 'voice.ogg', url: 'https://example.test/voice.ogg' }),
      transcribe: async () => {
        sttCalls++;
        if (!succeeds) throw new Error('Ошибка STT');
        return { success: true, formatted_dialog: 'Участник чата: Есть вопрос по заказу' };
      },
    }), 'wazzup', {
      1: { id: 1, senderid: 55, text: '=== Исходящее сообщение, автор: Иван (Иван Иванов) ===\nХорошо' },
      2: { id: 2, senderid: 55, text: '', params: { FILE_ID: [7] } },
    });
    const result = await processDeal(args);
    assert.equal(sttCalls, 1);
    assert.equal(result.status, 'blocked');
    assert.equal(result.pipelineGate.kind, 'author_ambiguous');
    assert.equal(result.analysis, undefined);
  }
});

test('противоречивый тип известного голосового Wappi не допускает вердикт', async () => {
  let llmCalls=0,sttCalls=0;
  const args=withChat(fixture({resolveFile:async()=>({NAME:'photo.jpg',TYPE:'image',DOWNLOAD_URL:'https://example.test/file'}),
    transcribe:async()=>{sttCalls++;return {success:true,formatted_dialog:'текст'};}}),'wappi',{
    1:{id:1,senderid:55,text:'Клиент подробно сообщил о своём решении отказаться',params:{FILE_ID:[7]}},
  });
  const original=args.bitrix.request;
  args.bitrix.request=async(method,body)=>{
    const response=await original(method,body);
    if(method==='imopenlines.session.history.get')return {...response,result:{...response.result,
      files:{7:{id:7,type:'audio',name:'voice.ogg'}}}};
    return response;
  };
  args.llm={async complete(){llmCalls++;throw Error('Модель не должна вызываться');}};
  const result=await processDeal(args);
  assert.equal(result.status,'blocked');assert.equal(result.pipelineGate.kind,'recognition');
  assert.equal(result.analysis,undefined);assert.equal(llmCalls,0);assert.equal(sttCalls,0);
});
