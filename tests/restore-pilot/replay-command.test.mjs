import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSavedReplayClient, runSavedReplayCommand } from '../../app/src/pilot/replay-command.mjs';

const env = Object.freeze({ DATABASE_URL: 'postgresql://u:PRIVATE-PASSWORD@localhost:5432/test', POLZA_API_KEY: 'PRIVATE-POLZA-KEY' });
const packet = { facts: [{ fact_id: 'F1', source: 'chat', actor: 'client', content: 'PRIVATE-FACT' }], metrics: {}, deal_card: {} };
const baseline = { deal_id: 42, analysis_id: '2021', ai_verdict: 'неправомерен', ai_reason_class: 'manager_dropped', ai_facts_json: packet,
  processed_at: '2026-11-01T08:04:41.827Z', ai_judge_json: { PRIVATE: 'PRIVATE-JUDGE' }, private: 'PRIVATE-BASELINE' };
const modelResult = { scope: 'saved_facts_only', status: 'processed',
  verdict: { previous: 'неправомерен', current: 'правомерен', comparison: 'different' },
  reason_class: { previous: 'manager_dropped', current: 'price', comparison: 'different' },
  facts_count: 1, model_calls: { judge: 1, writer: 1 }, proof_errors_count: 0,
  limitations: ['saved_facts_not_regenerated'], private: 'PRIVATE-MODEL-OUTPUT' };

function stub(overrides = {}) {
  const events = [];
  const args = { id: '42', analysisId: '2021', env,
    async makePool() { events.push('pool_created'); return { on() {}, async connect() { throw new Error('NO-NETWORK'); },
      async end() { events.push('pool_closed'); } }; },
    async readBaselines(_pool, { dealIds }) { assert.deepEqual(dealIds, [42]); events.push('baseline_read'); return { baselines: [baseline] }; },
    async readPrompts() { return { judgeSystemPrompt: 'судья', writerSystemPrompt: 'писатель' }; },
    makeClient({ apiKey, signal }) { assert.equal(apiKey, env.POLZA_API_KEY); assert.equal(signal.aborted, false); events.push('client_created'); return {}; },
    async replay({ packet: received, golden, client }) {
      assert.equal(events.includes('pool_closed'), true, 'БД закрывается до обращения к модели');
      assert.equal(received, packet);
      assert.equal(golden.judge.verdict, 'неправомерен');
      assert.equal(golden.judge.closure_reason_class, 'manager_dropped');
      assert.deepEqual(client, {});
      events.push('model_called'); return modelResult;
    },
    ...overrides,
  };
  return { args, events };
}

test('требуется один явно указанный ID; неправильный ввод не открывает БД', async () => {
  for (const id of [undefined, null, '', '0', '01', '1,2', '1 OR 1=1', '../1', '2147483648', ['1', '2']]) {
    let touched = false;
    await assert.rejects(runSavedReplayCommand(stub({ id, async makePool() { touched = true; throw new Error('NO-NETWORK'); } }).args));
    assert.equal(touched, false);
  }
});

test('эталон читается один раз, пул закрывается до модели; вывод только безопасные enum и числа', async () => {
  const { args, events } = stub();
  const result = await runSavedReplayCommand(args);
  assert.deepEqual(events, ['pool_created', 'baseline_read', 'pool_closed', 'client_created', 'model_called']);
  assert.equal(result.status, 'processed');
  assert.equal(result.resources_closed, true);
  assert.deepEqual(result.verdict, modelResult.verdict);
  assert.deepEqual(result.reason_class, modelResult.reason_class);
  assert.equal(result.facts_count, 1);
  assert.deepEqual(result.model_calls, { judge: 1, writer: 1 });
  assert.equal(result.proof_errors_count, 0);
  assert.ok(Array.isArray(result.limitations));
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(result).includes('42'), false);
});

test('ошибочный эталон не запускает модель и соединение закрывается', async () => {
  const { args, events } = stub({ async readBaselines() { return { baselines: [{ ...baseline, deal_id: 43 }] }; } });
  const result = await runSavedReplayCommand(args);
  assert.equal(result.status, 'error');
  assert.equal(result.resources_closed, true);
  assert.ok(events.includes('pool_closed'));
  assert.equal(events.includes('model_called'), false);
});

test('сменившийся ID эталонного разбора не запускает модель', async () => {
  const { args, events } = stub({ async readBaselines() { return { baselines: [{ ...baseline, analysis_id: '2022' }] }; } });
  const result = await runSavedReplayCommand(args);
  assert.equal(result.status, 'error');
  assert.equal(result.resources_closed, true);
  assert.ok(events.includes('pool_closed'));
  assert.equal(events.includes('model_called'), false);
});

test('некорректный ID эталона не открывает БД', async () => {
  for (const analysisId of [undefined, '', '0', '01', '2021,2', '9223372036854775808', 2021]) {
    let touched = false;
    await assert.rejects(runSavedReplayCommand(stub({ analysisId, async makePool() { touched = true; } }).args));
    assert.equal(touched, false);
  }
});

test('поток HTTP-ошибки Polza закрывается перед повтором', async () => {
  const signal = new AbortController().signal;
  let requests = 0, cancelled = 0, unknown = 0;
  const client = createSavedReplayClient({ apiKey: 'mock', signal, wait: async () => {},
    onCleanupUnknown() { unknown++; },
    async fetchImpl() { requests++; return { ok: false, status: 429, body: { async cancel() { cancelled++; } } }; },
  });
  await assert.rejects(client.complete({}));
  assert.equal(requests, 2);
  assert.equal(cancelled, 2);
  assert.equal(unknown, 0);
});

test('ошибка закрытия тела Polza не выдаёт marker закрытых ресурсов', async () => {
  const { args } = stub({
    makeClient({ apiKey, signal, onCleanupUnknown }) {
      return createSavedReplayClient({ apiKey, signal, onCleanupUnknown, wait: async () => {},
        async fetchImpl() { return { ok: false, status: 500, body: { async cancel() { throw new Error('PRIVATE-ERROR'); } } }; } });
    },
    async replay({ client }) { await client.complete({}).catch(() => {}); return modelResult; },
  });
  await assert.rejects(runSavedReplayCommand(args), error => error?.code === 'REPLAY_CLEANUP_UNKNOWN'
    && !String(error.message).includes('PRIVATE'));
});

test('сырой текст исключения БД не попадает наружу; пул закрывается', async () => {
  const { args, events } = stub({ async readBaselines() { throw new Error('PRIVATE-COMMUNICATION'); } });
  const result = await runSavedReplayCommand(args);
  assert.equal(result.status, 'error');
  assert.equal(result.resources_closed, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.ok(events.includes('pool_closed'));
});

test('таймаут отменяет модель и даёт marker только после завершения задачи', async () => {
  const events = [];
  const { args } = stub({ deadlineMs: 30, closeGraceMs: 200,
    makeClient({ signal }) { return { signal }; },
    replay({ client }) { return new Promise((_, reject) => client.signal.addEventListener('abort', () => {
      events.push('aborted'); reject(new Error('PRIVATE-ABORT'));
    }, { once: true })); },
  });
  const result = await runSavedReplayCommand(args);
  assert.equal(result.status, 'deadline');
  assert.equal(result.resources_closed, true);
  assert.deepEqual(events, ['aborted']);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('незавершившийся после отмены запрос не получает marker очистки', async () => {
  const { args } = stub({ deadlineMs: 30, closeGraceMs: 25, replay() { return new Promise(() => {}); } });
  await assert.rejects(runSavedReplayCommand(args), error => error?.code === 'REPLAY_CLEANUP_UNKNOWN');
});

test('ошибка или зависание закрытия БД не выдаёт marker и не запускает модель', async () => {
  for (const end of [async () => { throw new Error('PRIVATE-CLOSE'); }, async () => new Promise(() => {})]) {
    const { args, events } = stub({ deadlineMs: 100, closeGraceMs: 25,
      async makePool() { return { on() {}, async connect() {}, end }; } });
    await assert.rejects(runSavedReplayCommand(args), error => error?.code === 'REPLAY_CLEANUP_UNKNOWN');
    assert.equal(events.includes('model_called'), false);
  }
});

test('неизвестные категории, вложенные данные и лишние поля ответа модели не выводятся', async () => {
  const { args } = stub({ async replay() { return { ...modelResult, status: 'PRIVATE-STATUS',
    verdict: { previous: 'PRIVATE-VERDICT', current: 'правомерен', comparison: 'PRIVATE-CONTENT' },
    reason_class: { previous: 'PRIVATE-CLASS', current: 'price', comparison: 'PRIVATE-CONTENT' },
    model_calls: { judge: 1, writer: 1, message: 'PRIVATE-CONTENT' },
    limitations: ['PRIVATE-CONTENT'], detail: packet }; } });
  const result = await runSavedReplayCommand(args);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.resources_closed, true);
});

test('пул, созданный после дедлайна, закрывается до подтверждения результата', async () => {
  let poolClosed = false, modelCalled = false;
  const { args } = stub({ deadlineMs: 15, closeGraceMs: 200,
    async makePool() { await new Promise(resolve => setTimeout(resolve, 45)); return { on() {}, async connect() {}, async end() { poolClosed = true; } }; },
    async replay() { modelCalled = true; return modelResult; },
  });
  const result = await runSavedReplayCommand(args);
  assert.equal(result.status, 'deadline');
  assert.equal(result.resources_closed, true);
  assert.equal(poolClosed, true);
  assert.equal(modelCalled, false);
});

test('незавершившееся чтение БД и чтение промптов не выдают ложный marker', async () => {
  for (const blocked of ['database', 'prompts']) {
    const { args } = stub({ deadlineMs: 15, closeGraceMs: 25,
      async readBaselines() { return blocked === 'database' ? new Promise(() => {}) : { baselines: [baseline] }; },
      async readPrompts() { return blocked === 'prompts' ? new Promise(() => {}) : {}; },
    });
    await assert.rejects(runSavedReplayCommand(args), error => error?.code === 'REPLAY_CLEANUP_UNKNOWN');
  }
});

test('исключение модели маскируется после закрытия БД', async () => {
  const { args, events } = stub({ async replay() { throw new Error('PRIVATE-MODEL-ERROR'); } });
  const result = await runSavedReplayCommand(args);
  assert.equal(result.status, 'error');
  assert.equal(result.resources_closed, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.ok(events.includes('pool_closed'));
});
