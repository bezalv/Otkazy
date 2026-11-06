import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addComposition, describeComposition, emptyComposition, PILOT_ACTORS, PILOT_SOURCES } from '../../app/src/pilot/composition.mjs';
import { compareWithBaseline } from '../../app/src/pilot/index.mjs';

test('состав фактов и разрешённые категории подсчитываются без содержимого', () => {
  const baseline = { ai_verdict: 'неправомерен', ai_reason_class: 'price', ai_facts_json: { facts: [
    { source: 'chat', actor: 'client', content: 'PRIVATE-CONTENT', author_name: 'PRIVATE-NAME' },
    { source: 'call_transcript', actor: 'manager', content: 'PRIVATE-CONTENT' },
    { source: 'PRIVATE-SOURCE', actor: 'PRIVATE-ACTOR', fact_id: 'PRIVATE-ID' },
  ] } };
  const current = { status: 'processed', analysis: { multi_agent_analysis: { verdict: 'правомерен',
    closure_reason_class: 'competitor', facts_packet: { facts: [
      { source: 'crm_comment', actor: 'manager', content: 'PRIVATE-CONTENT' },
      { source: 'call_event', actor: 'system', content: 'PRIVATE-CONTENT' },
    ] } } } };
  const summary = emptyComposition();
  addComposition(summary, describeComposition(current, baseline));
  assert.equal(summary.verdicts.previous['неправомерен'], 1);
  assert.equal(summary.verdicts.current['правомерен'], 1);
  assert.equal(summary.reason_classes.previous.price, 1);
  assert.equal(summary.reason_classes.current.competitor, 1);
  assert.equal(summary.facts.previous.available, 1);
  assert.equal(summary.facts.previous.total, 3);
  assert.equal(summary.facts.previous.by_source.chat, 1);
  assert.equal(summary.facts.previous.by_source.call_transcript, 1);
  assert.equal(summary.facts.previous.by_source.other, 1);
  assert.equal(summary.facts.previous.by_actor.client, 1);
  assert.equal(summary.facts.previous.by_actor.other, 1);
  assert.equal(summary.facts.current.total, 2);
  assert.equal(summary.facts.current.by_source.crm_comment, 1);
  assert.equal(summary.facts.current.by_actor.system, 1);
  assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
  assert.equal(compareWithBaseline(current, baseline).facts.exact, 'different');
});

test('недоступные и неизвестные enum безопасно различаются', () => {
  const summary = emptyComposition();
  const detail = describeComposition({ status: 'error' }, { ai_verdict: 'PRIVATE-VERDICT', ai_reason_class: 'PRIVATE-CLASS' });
  addComposition(summary, detail);
  assert.equal(summary.verdicts.previous.other, 1);
  assert.equal(summary.verdicts.current.unavailable, 1);
  assert.equal(summary.reason_classes.previous.other, 1);
  assert.equal(summary.reason_classes.current.unavailable, 1);
  assert.equal(summary.facts.previous.available, 0);
  assert.equal(summary.facts.current.available, 0);
  assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
});

test('подмена объекта состава не добавляет произвольные ключи и повреждённые счётчики', () => {
  const summary = emptyComposition();
  addComposition(summary, { previous_verdict: 'PRIVATE-VERDICT', current_verdict: '__proto__',
    previous_reason_class: 'PRIVATE-CLASS', current_reason_class: null,
    previous_facts: { total: 2, by_source: { chat: 2, 'PRIVATE-SOURCE': 1 }, by_actor: { client: 2 } },
    current_facts: { total: 1e20, by_source: {}, by_actor: {} }, 'PRIVATE-KEY': 'PRIVATE-CONTENT' });
  assert.equal(summary.verdicts.previous.other, 1);
  assert.equal(summary.verdicts.current.other, 1);
  assert.equal(summary.facts.previous.available, 0);
  assert.equal(summary.facts.current.available, 0);
  assert.deepEqual(Object.keys(summary.facts.previous.by_source), PILOT_SOURCES);
  assert.deepEqual(Object.keys(summary.facts.previous.by_actor), PILOT_ACTORS);
  assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
});
