import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runJob, toPersistenceResult } from '../../app/src/worker/run-job.mjs';

const job = { id: 'job', lease_token: 'lease', deal_id: 42, lose_date: '2026-11-01T00:00:00Z', silent: false, screenshots: true };
function deps(overrides = {}) {
  const calls = [];
  return { calls, args: {
    job, queue: { async renew() { return true; } }, loadAudioWait: async () => null,
    store: {
      async loadResumableResult() { return null; },
      async persistResult(result) { calls.push(result); return { status: result._status, needsExternalActions: false }; },
    },
    ...overrides,
  } };
}

test('сбой нормализации сохраняется как технический сбой', async () => {
  const { calls, args } = deps({ process: async () => { throw new Error('секретные данные'); } });
  const result = await runJob(args);
  assert.equal(result.status, 'error');
  assert.equal(calls[0]._status, 'error');
  assert.doesNotMatch(calls[0]._error, /секретные данные/);
});

test('потеря аренды до сохранения не пишет результат', async () => {
  let n = 0;
  const { calls, args } = deps({ queue: { async renew() { return ++n === 1; } }, process: async () => ({ status: 'skipped' }) });
  await assert.rejects(runJob(args), /аренда/i);
  assert.equal(calls.length, 0);
});

test('после найденного анализа модель повторно не вызывается', async () => {
  const saved = { analysisId: 3, result: {} };
  const { calls, args } = deps({
    store: { async loadResumableResult() { return saved; }, async persistResult() { assert.fail('запись не нужна'); } },
    process: async () => assert.fail('повторный разбор не нужен'),
    delivery: async ({ saved: found }) => ({ status: 'delivered', analysisId: found.analysisId }),
  });
  assert.deepEqual(await runJob(args), { status: 'delivered', analysisId: 3 });
  assert.equal(calls.length, 0);
});

test('ожидание и истечение записи передаются в хранилище разными исходами', () => {
  const queue = { lose_date: job.lose_date };
  assert.equal(toPersistenceResult(job, { status: 'waiting', audioWait: { queue } })._status, 'waiting_audio');
  const expired = toPersistenceResult(job, { status: 'expired', collection: { deal_data: {} }, audioWait: { queue, classification: {}, multi_agent_analysis: { verdict: 'недостаточно_данных' } } });
  assert.equal(expired._status, 'processed');
  assert.equal(expired.audio_wait_expired, true);
});

test('неизвестное состояние не становится успешным разбором', () => {
  assert.equal(toPersistenceResult(job, { status: 'unexpected' })._status, 'error');
});
