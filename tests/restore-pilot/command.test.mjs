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
