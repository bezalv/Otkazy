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

test('только известная окончательная блокировка передаёт причину для остановки аудио', () => {
  for (const kind of ['author_ambiguous', 'chat_connector_unknown']) {
    const outcome = { status: 'blocked', pipelineGate: { kind, final: true, pipeline_error: 'проверка' } };
    const result = toPersistenceResult(job, outcome, '101');
    assert.equal(result._status, 'error');
    assert.equal(result.error_kind, kind);
    assert.equal(result.audio_origin_stage_history_id, '101');
    assert.equal(toPersistenceResult(job, { ...outcome, pipelineGate: { ...outcome.pipelineGate, final: false } }).error_kind, undefined);
  }
  assert.equal(toPersistenceResult(job, { status: 'blocked', pipelineGate: { kind: 'recognition', final: true } }).error_kind, undefined);
});

test('задание ожидания передаёт для сохранения проверенный исходный переход и окончательную ошибку', async () => {
  const localJob = { ...job, trigger_type: 'audio_wait', request_key: 'audio-wait:test' };
  const waiting = { state: 'waiting', lose_date: job.lose_date, origin_stage_history_id: '101', _scheduled_request_key: localJob.request_key };
  const { calls, args } = deps({ job: localJob, loadAudioWait: async () => waiting,
    process: async options => {
      assert.equal(options.expectedHistoryId, '101');
      return { status: 'blocked', pipelineGate: { kind: 'author_ambiguous', final: true, pipeline_error: 'проверка' } };
    }, delivery: async () => assert.fail('доставки при ошибке нет'),
  });
  assert.equal((await runJob(args)).status, 'error');
  assert.equal(calls[0].error_kind, 'author_ambiguous');
  assert.equal(calls[0].audio_origin_stage_history_id, '101');
});

test('ручной и ночной повтор могут переоценить отменённое ожидание аудио', async () => {
  for (const trigger of ['manual', 'nightly']) {
    const terminal = { state: 'cancelled', lose_date: job.lose_date, origin_stage_history_id: '101' };
    let processed = false;
    const { args } = deps({ job: { ...job, trigger_type: trigger }, loadAudioWait: async () => terminal,
      queue: { async renew() { return true; }, async finishObsoleteNightly() { return false; } },
      process: async options => { processed = true; assert.equal(options.savedAudioWait._recheck_terminal, true); return { status: 'skipped' }; },
    });
    assert.equal((await runJob(args)).status, 'skipped');
    assert.equal(processed, true);
    assert.equal(terminal._recheck_terminal, undefined);
  }
});

test('только ручной и ночной повтор переоценивают завершённую очередь, не меняя её', async () => {
  for (const trigger of ['manual', 'nightly', 'live', 'audio_wait']) {
    const terminal = { state: 'expired', lose_date: job.lose_date, origin_stage_history_id: '101' };
    let processed = false;
    const localJob = { ...job, trigger_type: trigger,
      ...(trigger === 'live' ? { request_key: 'bitrix24:deal-stage-history:101' } : {}) };
    const { calls, args } = deps({ job: localJob, loadAudioWait: async () => terminal,
      queue: { async renew() { return true; }, async finishObsoleteNightly() { return false; },
        async finishObsoleteAudioCheck() { return true; } },
      process: async options => {
        processed = true;
        assert.equal(options.savedAudioWait._recheck_terminal === true, trigger === 'manual' || trigger === 'nightly');
        return { status: 'skip', audioWait: { reason: 'audio_wait_terminal_recordings_missing' } };
      } });
    const result = await runJob(args);
    assert.equal(terminal._recheck_terminal, undefined);
    if (trigger === 'audio_wait') {
      assert.equal(result.status, 'obsolete');
      assert.equal(processed, false);
      assert.equal(calls.length, 0);
    } else {
      assert.equal(processed, true);
      assert.equal(result.status, 'skipped');
      assert.equal(calls[0]._status, 'skipped');
    }
  }
});

test('устаревший переход завершается без технического сбоя нового отказа', async () => {
  let finished = false;
  const { calls, args } = deps({ queue: { async renew() { return true; }, async finishObsoleteTransition() { finished = true; return true; } },
    process: async () => ({ status: 'obsolete_transition' }) });
  assert.equal((await runJob(args)).status, 'obsolete');
  assert.equal(finished, true);
  assert.equal(calls.length, 0);
});

test('идентификатор события передаётся обработчику, ручные задания сохраняют прежний контракт', async () => {
  for (const [request_key, trigger_type, expected] of [
    ['bitrix24:deal-stage-history:101', 'live', '101'],
    ['bitrix24:deal-stage-history:101', 'backfill', '101'],
    ['manual:42:1', 'manual', null],
  ]) {
    let seen;
    const { args } = deps({ job: { ...job, request_key, trigger_type }, process: async options => { seen = options.expectedHistoryId; return { status: 'skipped' }; } });
    await runJob(args);
    assert.equal(seen, expected);
  }
});

test('повреждённый ключ живого события не запускает анализ', async () => {
  let called = false;
  const { args, calls } = deps({ job: { ...job, request_key: 'bitrix24:deal-stage-history:no', trigger_type: 'live' },
    process: async () => { called = true; } });
  assert.equal((await runJob(args)).status, 'error');
  assert.equal(called, false);
  assert.equal(calls[0]._status, 'error');
});
