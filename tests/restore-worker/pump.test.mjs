import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerPump } from '../../app/src/worker/pump.mjs';

test('такт восстанавливает очередь и проверяет конфигурацию до захвата', async () => {
  const calls = [];
  const pump = createWorkerPump({ pool: {}, queue: {}, processOptions: {}, operations: {
    recover: async () => { calls.push('recover'); }, schedule: async () => { calls.push('schedule'); return []; },
    getEnabledAt: async () => { calls.push('config'); throw new Error('нет конфигурации'); },
    claim: async () => { calls.push('claim'); },
  } });
  await assert.rejects(pump.tick(), /конфигурации/);
  assert.deepEqual(calls, ['recover', 'schedule', 'config']);
});

test('один такт берёт не более одного задания и передаёт дату активации', async () => {
  const jobs = [{ id: 'one' }, { id: 'two' }];
  const pump = createWorkerPump({ pool: {}, queue: {}, processOptions: {}, operations: {
    recover: async () => 0, schedule: async () => [{}, {}], getEnabledAt: async () => '2026-11-01T00:00:00Z',
    claim: async () => jobs.shift(), execute: async args => ({ id: args.job.id, enabled: args.processOptions.audioWaitEnabledAt }),
  } });
  assert.deepEqual(await pump.tick(), { status: 'handled', enqueued: 2, result: { id: 'one', enabled: '2026-11-01T00:00:00Z' } });
  assert.equal(jobs.length, 1);
});

test('параллельный вызов того же обработчика не захватывает вторую сделку', async () => {
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const pump = createWorkerPump({ pool: {}, queue: {}, processOptions: {}, operations: {
    recover: async () => { await gate; }, schedule: async () => [], getEnabledAt: async () => 'x', claim: async () => null,
  } });
  const first = pump.tick();
  assert.equal((await pump.tick()).status, 'busy');
  unblock();
  assert.equal((await first).status, 'idle');
});
