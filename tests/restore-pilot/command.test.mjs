import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSelectedIds, runPilotCommand } from '../../app/src/pilot/command.mjs';

const env = { DATABASE_URL: 'postgresql://u:PRIVATE-PASSWORD@localhost:5432/test',
  BITRIX_REST_BASE: 'https://example.invalid/rest/1/PRIVATE-TOKEN', POLZA_API_KEY: 'PRIVATE-POLZA-KEY' };

test('разрешены только 1–5 разных явно указанных ID', () => {
  assert.deepEqual(parseSelectedIds(['1', '42']), [1, 42]);
  for (const bad of [[], ['1', '1'], ['0'], ['1 OR 1=1'], ['../1'], ['2147483648'], ['1', '2', '3', '4', '5', '6']]) {
    assert.throws(() => parseSelectedIds(bad));
  }
});

test('пилот закрывает пул до аудио, обрабатывает только выбранные ID и возвращает только агрегаты', async () => {
  const events = [];
  const output = await runPilotCommand({ ids: ['1', '2'], env,
    async makePool() { return { on() {}, async connect() { throw new Error('Тест не должен обращаться к сети'); },
      async end() { events.push('database_closed'); } }; },
    async readBaselines(_pool, { dealIds }) { events.push('read_only_baselines'); return {
      audio_wait_enabled_at: '2026-01-01T00:00:00Z', baselines: dealIds.map(deal_id => ({ deal_id, private: 'PRIVATE-COMMUNICATION' })),
    }; },
    async readPrompts() { return { judgeSystemPrompt: 'судья', writerSystemPrompt: 'писатель' }; },
    async startService() { events.push('stt_started'); return { address: 'http://127.0.0.1:1', key: 'key', tempRoot: 'test',
      async close() { events.push('stt_closed'); } }; },
    makeDependencies() { return { close() { events.push('deps_closed'); } }; },
    makeRunner() { return { async run({ dealId, screenshots, baseline }) {
      assert.equal(screenshots, true);
      assert.equal(baseline.audio_wait_enabled_at, '2026-01-01T00:00:00Z');
      events.push(`run_${dealId}`);
      return { status: 'processed', verdict: dealId === 1 ? 'match' : 'different', reason_class: 'match', facts: { exact: 'different' } };
    } }; },
  });
  assert.deepEqual(events, ['read_only_baselines', 'database_closed', 'stt_started', 'run_1', 'run_2', 'deps_closed', 'stt_closed']);
  assert.deepEqual(output.verdict, { match: 1, different: 1, unavailable: 0 });
  assert.deepEqual(output.reason_class, { match: 2, different: 0, unavailable: 0 });
  assert.equal(output.statuses.processed, 2);
  assert.ok(output.limitations.includes('legacy_origin_unverified'));
  assert.ok(output.limitations.includes('current_card_may_have_changed'));
  assert.equal(output.composition.verdicts.previous.unavailable, 2);
  assert.equal(output.composition.verdicts.current.unavailable, 2);
  assert.equal(output.composition.facts.previous.available, 0);
  assert.equal(JSON.stringify(output).includes('PRIVATE'), false);
});

test('ошибка или неизвестное происхождение останавливают дальнейшие платные вызовы', async () => {
  const executed = [];
  let stopped = false;
  const result = await runPilotCommand({ ids: ['1', '2'], env,
    async makePool() { return { on() {}, async connect() {}, async end() {} }; },
    async readBaselines() { return { audio_wait_enabled_at: '2026-01-01T00:00:00Z', baselines: [{ deal_id: 1 }, { deal_id: 2 }] }; },
    async readPrompts() { return {}; },
    async startService() { return { async close() { stopped = true; } }; },
    makeDependencies() { return { close() {} }; },
    makeRunner() { return { async run({ dealId }) { executed.push(dealId); return { status: 'unverified', reason: 'PRIVATE-CONTENT' }; } }; },
  });
  assert.deepEqual(executed, [1]);
  assert.equal(result.attempted, 1);
  assert.equal(result.statuses.unverified, 1);
  assert.equal(stopped, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE-CONTENT'), false);
});

test('исключение анализа даёт закрытый корректный агрегат без текста исключения', async () => {
  const result = await runPilotCommand({ ids: ['1'], env,
    async makePool() { return { on() {}, async connect() {}, async end() {} }; },
    async readBaselines() { return { audio_wait_enabled_at: '2026-01-01T00:00:00Z', baselines: [{ deal_id: 1 }] }; },
    async readPrompts() { return {}; }, async startService() { return { async close() {} }; },
    makeDependencies() { return { close() {} }; },
    makeRunner() { return { async run() { throw new Error('PRIVATE-EXCEPTION'); } }; },
  });
  assert.equal(result.statuses.error, 1);
  assert.equal(result.attempted, 1);
  assert.equal(result.verdict.unavailable, 1);
  assert.equal(result.reason_class.unavailable, 1);
  assert.equal(result.exact_facts.unavailable, 1);
  assert.equal(result.diagnostics.categories.processing_exception, 1);
  assert.equal(result.service_closed, true);
  assert.equal(result.composition.verdicts.previous.unavailable, 1);
  assert.equal(result.composition.verdicts.current.unavailable, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('ресурс STT закрывается, даже если закрытие адаптеров завершилось ошибкой', async () => {
  let stopped = false;
  await assert.rejects(runPilotCommand({ ids: ['1'], env,
    async makePool() { return { on() {}, async connect() {}, async end() {} }; },
    async readBaselines() { return { audio_wait_enabled_at: '2026-01-01T00:00:00Z', baselines: [{ deal_id: 1 }] }; },
    async readPrompts() { return {}; },
    async startService() { return { async close() { stopped = true; } }; },
    makeDependencies() { return { close() { throw new Error('ошибка закрытия'); } }; },
    makeRunner() { return { async run() { return { status: 'processed' }; } }; },
  }), /закрытия/);
  assert.equal(stopped, true);
});

test('дедлайн отменяет зависшую обработку и подтверждает закрытие STT только после close', async () => {
  const events = [];
  const output = await runPilotCommand({ ids: ['1'], env, deadlineMs: 35, closeGraceMs: 200,
    async makePool() { return { on() {}, async connect() {}, async end() { events.push('db_closed'); } }; },
    async readBaselines() { return { audio_wait_enabled_at: '2026-01-01T00:00:00Z', baselines: [{ deal_id: 1 }] }; },
    async readPrompts() { return {}; },
    async startService({ signal }) { assert.equal(signal.aborted, false); return { async close() { events.push('stt_closed'); } }; },
    makeDependencies({ signal }) { assert.equal(signal.aborted, false); return { close() { events.push('deps_closed'); } }; },
    makeRunner({ signal }) { return { run() { return new Promise((_, reject) => {
      signal.addEventListener('abort', () => { events.push('network_aborted'); reject(new Error('aborted')); }, { once: true });
    }); } }; },
  });
  assert.equal(output.status, 'deadline');
  assert.equal(output.service_closed, true);
  assert.deepEqual(events, ['db_closed', 'network_aborted', 'deps_closed', 'stt_closed']);
});

test('дедлайн включает чтение эталонов и не запускает STT после отмены', async () => {
  let sttStarted = false, poolClosed = false;
  const output = await runPilotCommand({ ids: ['1'], env, deadlineMs: 25, closeGraceMs: 200,
    async makePool() { return { on() {}, async connect() {}, async end() { poolClosed = true; } }; },
    async readBaselines() { return new Promise(() => {}); },
    async startService() { sttStarted = true; throw new Error('не должен запускаться'); },
  });
  assert.equal(output.status, 'deadline');
  assert.equal(output.service_state, 'not_started');
  assert.equal(Object.hasOwn(output, 'service_closed'), false);
  assert.equal(sttStarted, false);
  assert.equal(poolClosed, true);
});

test('отмена во время запуска STT не выдаёт неподтверждённый маркер', async () => {
  let aborted = false;
  const output = await runPilotCommand({ ids: ['1'], env, deadlineMs: 30, closeGraceMs: 200,
    async makePool() { return { on() {}, async connect() {}, async end() {} }; },
    async readBaselines() { return { audio_wait_enabled_at: '2026-01-01T00:00:00Z', baselines: [{ deal_id: 1 }] }; },
    async readPrompts() { return {}; },
    async startService({ signal }) { return new Promise((_, reject) => signal.addEventListener('abort', () => {
      aborted = true; reject(new Error('aborted'));
    }, { once: true })); },
  });
  assert.equal(aborted, true);
  assert.equal(output.status, 'deadline');
  assert.equal(output.service_state, 'startup_not_confirmed');
  assert.equal(Object.hasOwn(output, 'service_closed'), false);
});

test('ошибка или зависание close не дают ложного маркера закрытого STT', async () => {
  for (const close of [async () => { throw new Error('группа ffmpeg ещё работает'); }, async () => new Promise(() => {})]) {
    await assert.rejects(runPilotCommand({ ids: ['1'], env, deadlineMs: 100, closeGraceMs: 25,
      async makePool() { return { on() {}, async connect() {}, async end() {} }; },
      async readBaselines() { return { audio_wait_enabled_at: '2026-01-01T00:00:00Z', baselines: [{ deal_id: 1 }] }; },
      async readPrompts() { return {}; }, async startService() { return { close }; },
      makeDependencies() { return { close() {} }; },
      makeRunner() { return { async run() { return { status: 'processed' }; } }; },
    }), error => error.code === 'PILOT_CLEANUP_UNKNOWN');
  }
});

test('непрекратившийся анализ не объявляется безопасно завершённым даже после закрытия STT', async () => {
  let closed = false;
  await assert.rejects(runPilotCommand({ ids: ['1'], env, deadlineMs: 30, closeGraceMs: 25,
    async makePool() { return { on() {}, async connect() {}, async end() {} }; },
    async readBaselines() { return { audio_wait_enabled_at: '2026-01-01T00:00:00Z', baselines: [{ deal_id: 1 }] }; },
    async readPrompts() { return {}; }, async startService() { return { async close() { closed = true; } }; },
    makeDependencies() { return { close() {} }; },
    makeRunner() { return { async run() { return new Promise(() => {}); } }; },
  }), error => error.code === 'PILOT_CLEANUP_UNKNOWN');
  assert.equal(closed, true);
});

test('агрегатор отвергает подставленные строки и допускает только безопасную диагностику', async () => {
  const output = await runPilotCommand({ ids: ['1'], env,
    async makePool() { return { on() {}, async connect() {}, async end() {} }; },
    async readBaselines() { return { audio_wait_enabled_at: '2026-01-01T00:00:00Z', baselines: [{ deal_id: 1 }] }; },
    async readPrompts() { return {}; }, async startService() { return { async close() {} }; },
    makeDependencies() { return { close() {} }; },
    makeRunner() { return { async run() { return { status: 'error', diagnostic: { category: 'history',
      last_bitrix_method: 'crm.stagehistory.list', http_status: 403, failed_sources: ['calls', 'PRIVATE'],
      recognition_failures: { calls: 2, other: 'PRIVATE' }, detail: 'PRIVATE-CONTENT' } }; } }; },
  });
  assert.equal(output.diagnostics.categories.history, 1);
  assert.equal(output.diagnostics.last_bitrix_methods['crm.stagehistory.list'], 1);
  assert.equal(output.diagnostics.http_statuses['403'], 1);
  assert.equal(output.diagnostics.failed_sources.calls, 1);
  assert.equal(output.diagnostics.recognition_failures.calls, 2);
  assert.equal(JSON.stringify(output).includes('PRIVATE'), false);
});
