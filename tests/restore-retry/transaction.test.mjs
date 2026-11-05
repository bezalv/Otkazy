import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobQueue } from '../../app/src/queue/index.mjs';

const action = { requestKey: 'nightly:2026-11-05:42', dealId: 42,
  loseDate: '2026-11-04T00:00:00Z', triggerType: 'nightly', silent: true, screenshots: true };

function fakePool({ failCommit = false, failWork = false, failRollback = false } = {}) {
  const commitError = new Error('commit connection lost');
  const workError = new Error('query failed');
  const rollbackError = new Error('rollback connection lost');
  const state = { released: false, releaseError: undefined, calls: [] };
  const client = {
    async query(sql) {
      state.calls.push(sql);
      if (sql === 'COMMIT' && failCommit) throw commitError;
      if (sql === 'ROLLBACK' && failRollback) throw rollbackError;
      if (sql.includes('pg_advisory_xact_lock') && failWork) throw workError;
      if (sql.includes('SELECT 1 FROM public.lost_processing_jobs')) return { rows: [] };
      if (sql.includes('WITH current_time_value')) return { rows: [{ instant: '2026-11-05T00:00:00Z', used: 0 }] };
      if (sql.includes('insert into public.lost_processing_jobs')) return { rows: [{ id: 'test' }] };
      return { rows: [] };
    },
    release(error) { state.released = true; state.releaseError = error; },
  };
  return { pool: { query() {}, async connect() { return client; } }, state, commitError, workError, rollbackError };
}

test('потеря ответа COMMIT помечает исход неизвестным и выбрасывает соединение', async () => {
  const { pool, state, commitError } = fakePool({ failCommit: true });
  await assert.rejects(createJobQueue(pool).enqueueNightlyBudgeted(action),
    error => /Неизвестен результат COMMIT/.test(error.message) && error.cause === commitError);
  assert.equal(state.releaseError, commitError);
  assert.ok(state.calls.includes('ROLLBACK'));
});

test('ошибка ROLLBACK выбрасывает соединение, исходная ошибка сохранена', async () => {
  const { pool, state, workError, rollbackError } = fakePool({ failWork: true, failRollback: true });
  await assert.rejects(createJobQueue(pool).enqueueNightlyBudgeted(action), error => error === workError);
  assert.equal(state.releaseError, rollbackError);
});

test('после успешной транзакции соединение остаётся пригодным к использованию', async () => {
  const { pool, state } = fakePool();
  assert.equal((await createJobQueue(pool).enqueueNightlyBudgeted(action)).created, true);
  assert.equal(state.released, true);
  assert.equal(state.releaseError, undefined);
});
