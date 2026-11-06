import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnoseOutcome } from '../../app/src/pilot/diagnostics.mjs';
import { createPilotRunner } from '../../app/src/pilot/index.mjs';

test('этап истории и HTTP-код выводятся фиксированными значениями', () => {
  const result = diagnoseOutcome({ status: 'error', collection: { _step: 'deal_or_history', _error: 'HTTP 403' } },
    { lastMethod: 'crm.stagehistory.list', httpStatus: 403 });
  assert.equal(result.category, 'history');
  assert.equal(result.last_bitrix_method, 'crm.stagehistory.list');
  assert.equal(result.http_status, 403);
  const unknown = diagnoseOutcome({ status: 'error', collection: { _step: 'deal_or_history', _error: 'PRIVATE-TOKEN' } },
    { lastMethod: 'PRIVATE-METHOD', httpStatus: 999999 });
  assert.equal(unknown.category, 'deal_or_history');
  assert.equal(unknown.last_bitrix_method, null);
  assert.equal(unknown.http_status, null);
  assert.equal(JSON.stringify(unknown).includes('PRIVATE'), false);
});

test('показываются только фиксированные неисправные источники', () => {
  const result = diagnoseOutcome({ status: 'error', collection: { _step: 'collect_incomplete',
    _sources: { calls: { complete: false, error: 'HTTP 503' }, comments: { complete: true },
      tasks: { complete: false, error: 'PRIVATE-CONTENT' }, secret: { complete: false } } } });
  assert.equal(result.category, 'collection');
  assert.deepEqual(result.failed_sources, ['calls', 'tasks']);
  assert.equal(result.http_status, 503);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('ошибки аудио и скриншотов передают только категории и счётчики', () => {
  const result = diagnoseOutcome({ status: 'blocked', pipelineGate: { kind: 'recognition', failures: [
    { kind: 'звонок', id: 'PRIVATE-ID', error: 'PRIVATE-ERROR' },
    { kind: 'голосовое' }, { kind: 'скриншот' }, { kind: 'PRIVATE-KIND' },
  ] } });
  assert.equal(result.category, 'recognition');
  assert.deepEqual(result.recognition_failures, { calls: 1, voices: 1, screenshots: 1, other: 1 });
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('судья, писатель и безопасный HTTP классифицируются без текста ошибки', () => {
  for (const [text, category, http] of [['Сбой судьи: Polza HTTP 429', 'judge', 429],
    ['Сбой писателя: Polza HTTP 503', 'writer', 503], ['Сбой судьи: PRIVATE-CONTENT', 'judge', null]]) {
    const result = diagnoseOutcome({ status: 'error', analysis: { pipeline_error: text } });
    assert.equal(result.category, category);
    assert.equal(result.http_status, http);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
  assert.equal(diagnoseOutcome({ status: 'exception' }).category, 'processing_exception');
  assert.equal(diagnoseOutcome({ status: 'unverified' }).category, 'audio_origin');
  assert.equal(diagnoseOutcome({ status: 'source_incomplete' }).category, 'audio_wait');
});

test('в реальном processDeal некорректная история классифицируется без её содержимого', async () => {
  const bitrix = { async request(method) {
    if (method === 'crm.deal.userfield.list') return { result: [{ LIST: [{ ID: '1', VALUE: 'Другая' }] }] };
    if (method === 'crm.deal.get') return { result: { ID: '42', STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: '65' } };
    if (method === 'crm.stagehistory.list') return { result: { items: [{ ID: 'PRIVATE-ID', STAGE_ID: 'C23:LOSE', CREATED_TIME: 'bad-date' }] } };
    throw new Error('Неожиданно');
  } };
  const runner = createPilotRunner({ bitrix, llm: { async complete() { throw new Error('Не вызывать'); } },
    async transcribe() { throw new Error('Не вызывать'); }, async downloadFile() { throw new Error('Не вызывать'); },
    judgeSystemPrompt: 'судья', writerSystemPrompt: 'писатель', clock: () => Date.parse('2026-11-05T00:00:00Z') });
  const result = await runner.run({ dealId: 42, baseline: { deal_id: 42, lose_date: '2026-11-04T00:00:00Z',
    audio_wait_enabled_at: '2026-11-01T00:00:00Z' } });
  assert.equal(result.status, 'error');
  assert.equal(result.diagnostic.category, 'history');
  assert.equal(result.diagnostic.last_bitrix_method, 'crm.stagehistory.list');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
