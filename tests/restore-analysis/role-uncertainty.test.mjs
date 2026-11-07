import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCommunicationAnalytics } from '../../app/src/analysis/communication-analytics.mjs';
import { parseJudgeResponse } from '../../app/src/agents/judge.mjs';
import { buildFinalOutput } from '../../app/src/agents/final-output.mjs';
import { processedRows } from '../../app/src/persistence/rows.mjs';

const now = Date.parse('2026-11-07T12:00:00Z');
const base = { deal_id: 10, lose_date: '2026-11-06T10:00:00Z', communications: [
  { type: 'chat', role: 'Клиент', direction: 'incoming', text: 'Клиент написал ответ', date: '2026-11-06T09:00:00Z' },
  { type: 'chat', role: 'Менеджер', direction: 'outgoing', text: 'Мы уточним возможность', date: '2026-11-06T09:01:00Z' },
] };
const roleSource = input => structuredClone(input);

function response(proofs) {
  return { model: 'mock', choices: [{ message: { content: JSON.stringify({
    verdict: 'правомерен', verdict_reason_short: 'Отказ', closure_reason_class: 'other',
    recoverable_level: null, misplaced: false, correct_stage: null, exact_reason: 'Причина',
    manager_mistakes: [], key_signals: proofs, risk_factors: [], questions_for_manager: [],
  }) } }] };
}
const signal = (ids, proof_type = 'client_statement') => ({ signal: 'Причина', proof_type, proof_fact_ids: ids });

test('метрики и текст явно отмечают число смысловых ролей и сохраняются в JSON', () => {
  const input = roleSource(base);
  input.communications[0]._role_source = 'semantic_inference';
  const result = buildCommunicationAnalytics(input, now);
  const info = result.comm_analytics.chat_role_inference;
  assert.equal(info.source, 'semantic_inference');
  assert.equal(info.count, 1);
  assert.ok(info.affected_metrics.includes('chats_client'));
  assert.ok(info.affected_metrics.includes('chats_unanswered_by_manager'));
  assert.ok(info.affected_metrics.includes('initiative_manager_pct'));
  assert.ok(info.affected_metrics.includes('max_gap_who'));
  assert.ok(!info.affected_metrics.includes('calls_total'));
  assert.ok(result.comm_analytics.data_quality_warnings.some(s => /оценены по контексту/.test(s)));
  assert.match(result.analytics_text, /метрики сторон являются предположительными/);
  assert.match(result.full_prompt_text, /метрики сторон являются предположительными/);
  const packet = { facts: [], metrics: result.comm_analytics, deal_card: {} };
  const saved = processedRows({ multi_agent_analysis: { verdict: 'правомерен', facts_packet: packet }, comm_analytics: result.comm_analytics }, { deal_id: 10 }, []);
  assert.deepEqual(JSON.parse(saved.deal.comm_analytics).chat_role_inference, info);
  assert.deepEqual(JSON.parse(saved.analysis.ai_facts_json).metrics.chat_role_inference, info);
});

test('обычные данные не получают новых полей или предупреждений', () => {
  const result = buildCommunicationAnalytics(roleSource(base), now);
  assert.equal(Object.hasOwn(result.comm_analytics, 'chat_role_inference'), false);
  assert.ok(!result.comm_analytics.data_quality_warnings.some(s => /оценены по контексту/.test(s)));
  assert.doesNotMatch(result.analytics_text, /метрики сторон являются предположительными/);
});

test('ссылка на семантический факт и зависимую метрику получает предупреждение, но не ошибку', () => {
  const input = roleSource(base);
  input.communications[0]._role_source = 'semantic_inference';
  const { comm_analytics: metrics } = buildCommunicationAnalytics(input, now);
  const facts = [{ fact_id: 'f001', source: 'chat', actor: 'client', role_source: 'semantic_inference', content: 'Отказ' }];
  const prepared = { deal_id: 10, facts_packet: { facts, metrics, deal_card: {} } };
  const parsed = parseJudgeResponse(response([signal(['f001']), signal(['metric:chats_client'], 'metric')]), prepared, 'Промпт', now);
  assert.equal(parsed.proof_errors_count, 0);
  assert.equal(parsed.proof_warnings.length, 3);
  assert.ok(parsed.proof_warnings.every(w => w.severity === 'warning'));
  assert.ok(parsed.proof_warnings.some(w => /предположительно по контексту/.test(w.issue)));
  assert.ok(parsed.proof_warnings.some(w => /зависит от ролей/.test(w.issue)));
  const output = buildFinalOutput({ ...parsed, final_comment: 'Отказ' }, { comm_analytics: metrics, full_prompt_text: '' }, null);
  const saved = processedRows(output, { deal_id: 10 }, []);
  assert.deepEqual(JSON.parse(saved.analysis.ai_proof_warnings), parsed.proof_warnings);
  assert.deepEqual(JSON.parse(saved.analysis.ai_judge_json).proof_warnings, parsed.proof_warnings);
});

test('общая отметка о предположительных ролях сохраняется даже без ссылок судьи', () => {
  const facts = [{ fact_id: 'f001', source: 'chat', actor: 'client', role_source: 'semantic_inference', content: 'Отказ' }];
  const metrics = {};
  const parsed = parseJudgeResponse(response([]), { deal_id: 10, facts_packet: { facts, metrics, deal_card: {} } }, 'Промпт', now);
  assert.equal(parsed.proof_errors_count, 0);
  assert.ok(parsed.proof_warnings.some(w => w.path === 'facts_packet' && w.severity === 'warning'));
  const output = buildFinalOutput({ ...parsed, final_comment: 'Отказ' }, { comm_analytics: metrics, full_prompt_text: '' }, null);
  const saved = processedRows(output, { deal_id: 10 }, []);
  assert.ok(JSON.parse(saved.analysis.ai_proof_warnings).some(w => w.path === 'facts_packet'));
});

test('предупреждение о предположении не скрывает ошибку стороны или отсутствующую метрику', () => {
  const facts = [{ fact_id: 'f001', source: 'chat', actor: 'manager', role_source: 'semantic_inference', content: 'Ответ' }];
  const metrics = { chat_role_inference: { affected_metrics: ['missing'] } };
  const parsed = parseJudgeResponse(response([signal(['f001']), signal(['metric:missing'], 'metric')]),
    { deal_id: 10, facts_packet: { facts, metrics, deal_card: {} } }, 'Промпт', now);
  assert.equal(parsed.proof_errors_count, 2);
  assert.ok(parsed.proof_warnings.some(w => w.severity === 'warning' && /предположительно/.test(w.issue)));
  assert.ok(parsed.proof_warnings.some(w => w.severity === 'error' && /actor=manager/.test(w.issue)));
  assert.ok(parsed.proof_warnings.some(w => w.severity === 'error' && /не существует/.test(w.issue)));
});
