import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replaySavedFacts } from '../../app/src/pilot/saved-facts.mjs';

const judge = { verdict: 'правомерен', verdict_reason_short: 'Клиент отказался', recoverable_level: null,
  closure_reason_class: 'other', misplaced: false, correct_stage: null, exact_reason: 'Клиент отказался.',
  manager_mistakes: [], key_signals: [], risk_factors: [], questions_for_manager: [] };
const packet = { deal_card: { title: 'PRIVATE-CONTENT' }, metrics: {},
  facts: [{ fact_id: 'F1', actor: 'client', source: 'chat', content: 'Клиент сообщил содержательную причину отказа.' }] };
const options = { packet, golden: { judge }, judgeSystemPrompt: 'судья', writerSystemPrompt: 'писатель', now: 1700000000000 };

test('текущий судья получает сохранённый пакет, а итог не раскрывает его содержимое', async () => {
  const roles = [];
  const result = await replaySavedFacts({ ...options, client: { async complete(body, meta) {
    roles.push(meta.role);
    assert.deepEqual(JSON.parse(body.messages[1].content), packet);
    return { model: 'mock', choices: [{ message: { content: JSON.stringify(judge) } }] };
  } } });
  assert.deepEqual(roles, ['judge']);
  assert.equal(result.scope, 'saved_facts_only');
  assert.equal(result.verdict.comparison, 'match');
  assert.equal(result.facts_count, 1);
  assert.equal(result.limitations.includes('collection_and_transcription_not_tested'), true);
  assert.equal(JSON.stringify(result).includes('PRIVATE-CONTENT'), false);
  assert.equal(JSON.stringify(result).includes(packet.facts[0].content), false);
});

test('порог данных отсекает пустой пакет до модели', async () => {
  let count = 0;
  const result = await replaySavedFacts({ ...options, packet: { ...packet, facts: [] },
    client: { async complete() { count++; throw new Error('Модель не должна вызываться'); } } });
  assert.equal(count, 0);
  assert.equal(result.status, 'processed');
  assert.equal(result.verdict.current, 'недостаточно_данных');
  assert.equal(result.model_calls.judge, 0);
});

test('ошибка модели не раскрывает её текст', async () => {
  const result = await replaySavedFacts({ ...options, client: { async complete() { throw new Error('PRIVATE-TOKEN'); } } });
  assert.equal(result.status, 'error');
  assert.equal(JSON.stringify(result).includes('PRIVATE-TOKEN'), false);
});

test('невалидный сохранённый эталон отвергается до вызова модели', async () => {
  let count = 0;
  await assert.rejects(replaySavedFacts({ ...options, packet: { facts: null }, client: { async complete() { count++; } } }), /эталона/);
  assert.equal(count, 0);
});
