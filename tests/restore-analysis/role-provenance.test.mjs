import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { assembleFacts } from '../../app/src/analysis/facts-assembler.mjs';
import { processedRows } from '../../app/src/persistence/rows.mjs';

const prompt = readFileSync(new URL('../../app/prompts/judge.md', import.meta.url), 'utf8');

test('предположительная роль видна судье и сохраняется в JSON результата', () => {
  const prepared = assembleFacts({ deal_id: 10, communications: [
    { type: 'chat', role: 'Клиент', direction: 'incoming', author_name: 'Клиент',
      date: '2026-10-28T10:00:00Z', text: 'Нам не надо менять окно', _role_source: 'semantic_inference' },
    { type: 'chat', role: 'Менеджер', direction: 'outgoing', author_name: 'Менеджер',
      date: '2026-10-28T10:01:00Z', text: 'Поняла Вас, отменяю замер', _role_source: 'semantic_inference' },
    { type: 'chat', role: 'client', direction: 'incoming', author_name: 'Клиент',
      date: '2026-10-28T10:02:00Z', text: 'Спасибо' },
  ] }, prompt);
  const facts = prepared.facts_packet.facts;
  assert.equal(facts.length, 3);
  assert.equal(facts[0].actor, 'client');
  assert.equal(facts[0].role_source, 'semantic_inference');
  assert.equal(facts[1].actor, 'manager');
  assert.equal(facts[1].role_source, 'semantic_inference');
  assert.equal(facts[2].actor, 'client');
  assert.equal(Object.hasOwn(facts[2], 'role_source'), false);
  const sent = JSON.parse(prepared.judge_request_body.messages[1].content);
  assert.deepEqual(sent.facts, facts);

  const saved = processedRows({ multi_agent_analysis: { verdict: 'правомерен', facts_packet: prepared.facts_packet } },
    { deal_id: 10 }, []);
  assert.deepEqual(JSON.parse(saved.analysis.ai_facts_json).facts, facts);
  assert.deepEqual(JSON.parse(saved.analysis.ai_judge_json).facts_packet.facts, facts);
});

test('чужое значение источника роли не внедряется в факт; unknown не подменяется ролью', () => {
  const { facts_packet: { facts } } = assembleFacts({ communications: [
    { type: 'chat', role: 'client', direction: 'incoming', author_name: 'Клиент', text: 'Сообщение', _role_source: 'external_claim' },
    { type: 'chat', role: 'unknown', direction: 'outgoing', author_name: 'Участник чата', text: 'Ответ', _role_source: 'semantic_inference' },
  ] }, prompt);
  assert.equal(Object.hasOwn(facts[0], 'role_source'), false);
  assert.equal(facts[1].actor, 'unknown');
  assert.equal(facts[1].role_source, 'semantic_inference');
});

test('инструкция отличает смысловую оценку от установленного автора и сохраняет запрет на комментарии менеджера', () => {
  assert.match(prompt, /role_source=semantic_inference/);
  assert.match(prompt, /вероятностная оценка, а не техническое подтверждение автора/i);
  assert.match(prompt, /actor=unknown[^\n]*нельзя утверждать/i);
  assert.match(prompt, /Никогда не приписывай клиенту то, что есть только в crm_comment/i);
});
