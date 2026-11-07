import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCommunicationAnalytics } from '../../app/src/analysis/communication-analytics.mjs';
import { parseJudgeResponse } from '../../app/src/agents/judge.mjs';
import { buildFinalOutput } from '../../app/src/agents/final-output.mjs';
import { processedRows } from '../../app/src/persistence/rows.mjs';

const now = Date.parse('2026-11-07T12:00:00Z');
const input = () => ({ deal_id: 10, lose_date: '2026-11-06T10:00:00Z', communications: [
  { type: 'chat', role: 'Клиент', direction: 'incoming', text: 'Подскажите, сколько стоит замер?', date: '2026-11-06T09:00:00Z' },
  { type: 'chat', role: 'unknown', direction: 'unknown', text: '👍', date: '2026-11-06T09:01:00Z',
    _wazzup_author_ambiguous: true, _unknown_role_nonmaterial: 'semantic_inference' },
  { type: 'chat', role: 'Менеджер', direction: 'outgoing', text: 'Замер проводится бесплатно.', date: '2026-11-06T09:02:00Z' },
] });
function response(signals) { return { model: 'mock', choices: [{ message: { content: JSON.stringify({
  verdict: 'правомерен', verdict_reason_short: 'Отказ', closure_reason_class: 'other', recoverable_level: null,
  misplaced: false, correct_stage: null, exact_reason: 'Причина', manager_mistakes: [], key_signals: signals,
  risk_factors: [], questions_for_manager: [],
}) } }] }; }
const signal = (proof_fact_ids, proof_type) => ({ signal: 'Основание', proof_type, proof_fact_ids });
const fact = { fact_id: 'f001', source: 'chat', actor: 'unknown', content: '👍', unknown_role_nonmaterial: 'semantic_inference' };

test('неизвестный автор сохраняет неопределённость зависимых метрик и текста', () => {
  const data = input(); data.full_prompt_text = 'Краткое описание\n\n=== ХРОНОЛОГИЧЕСКИЙ ЖУРНАЛ СОБЫТИЙ ===\n\nУчастник чата: 👍';
  const result = buildCommunicationAnalytics(data, now);
  const metrics = result.comm_analytics;
  assert.equal(metrics.chat_unknown_nonmaterial.count, 1);
  assert.equal(metrics.chat_unknown_nonmaterial.source, 'semantic_inference');
  for (const key of metrics.chat_unknown_nonmaterial.affected_metrics) assert.equal(metrics[key], null, key);
  assert.equal(metrics.chats_total, 3);
  assert.equal(metrics.chats_unknown, 1);
  assert.equal(metrics.chats_unanswered_by_client, true);
  assert.match(result.analytics_text, /авторы сторон частично неизвестны/);
  assert.match(result.analytics_text, /Initiative: неизвестно/);
  assert.doesNotMatch(result.analytics_text, /Initiative: manager \d+%/);
  assert.match(result.full_prompt_text, /авторы сторон частично неизвестны/);
  assert.match(result.full_prompt_text, /Initiative: неизвестно/);
  assert.doesNotMatch(result.full_prompt_text, /Chats: 3 \(manager:/);
  assert.doesNotMatch(result.full_prompt_text, /Last (?:client|manager) msg:/);
  assert.doesNotMatch(result.full_prompt_text, /Initiative: manager \d+%/);
  const saved = processedRows({ multi_agent_analysis: { verdict: 'правомерен', facts_packet: { facts: [fact], metrics, deal_card: {} } }, comm_analytics: metrics }, { deal_id: 10 }, []);
  assert.equal(JSON.parse(saved.analysis.ai_facts_json).facts[0].actor, 'unknown');
  assert.equal(JSON.parse(saved.deal.comm_analytics).chat_unknown_nonmaterial.count, 1);
});

test('неизвестная сторона последнего сообщения не превращается в оба false', () => {
  const data = input(); data.communications.push({ type: 'chat', role: 'unknown', direction: 'unknown', text: '👍',
    date: '2026-11-06T09:03:00Z', _wazzup_author_ambiguous: true, _unknown_role_nonmaterial: 'semantic_inference' });
  const result = buildCommunicationAnalytics(data, now);
  const metrics = result.comm_analytics;
  assert.equal(metrics.chats_unanswered_by_manager, null);
  assert.equal(metrics.chats_unanswered_by_client, null);
  assert.ok(metrics.chat_unknown_nonmaterial.affected_metrics.includes('chats_unanswered_by_manager'));
  assert.doesNotMatch(result.full_prompt_text, /Last msg from (?:client|manager)/);
});

test('неизвестный автор и null-метрика не могут использоваться как доказательство', () => {
  const metrics = buildCommunicationAnalytics(input(), now).comm_analytics;
  const proofs = [signal(['f001'], 'client_statement'), signal(['f001'], 'manager_statement'),
    signal(['f001'], 'absence'), signal(['f001'], 'metric'), signal(['f001'], 'crm_comment'),
    signal(['metric:chats_client'], 'metric')];
  const prepared = { deal_id: 10, facts_packet: { facts: [fact], metrics, deal_card: {} } };
  const parsed = parseJudgeResponse(response(proofs), prepared, 'Промпт', now);
  assert.equal(parsed.proof_errors_count, 6);
  assert.equal(parsed.proof_warnings.filter(w => w.code === 'unknown_nonmaterial_as_statement' && w.severity === 'error').length, 5);
  assert.equal(parsed.proof_warnings.filter(w => w.code === 'unknown_nonmaterial_metric_as_proof' && w.severity === 'error').length, 1);
  assert.ok(parsed.proof_warnings.some(w => w.code === 'unknown_nonmaterial_present'));
  const output = buildFinalOutput({ ...parsed, final_comment: 'Отказ' }, { comm_analytics: metrics, full_prompt_text: '' }, null);
  const saved = processedRows(output, { deal_id: 10 }, []);
  const warnings = JSON.parse(saved.analysis.ai_proof_warnings);
  assert.ok(warnings.some(w => w.code === 'unknown_nonmaterial_as_statement'));
  assert.ok(warnings.some(w => w.code === 'unknown_nonmaterial_metric_as_proof'));
});

test('предупреждение о неизвестном авторе сохраняется и без доказательных ссылок', () => {
  const prepared = { deal_id: 10, facts_packet: { facts: [fact], metrics: {}, deal_card: {} } };
  const parsed = parseJudgeResponse(response([]), prepared, 'Промпт', now);
  assert.equal(parsed.proof_errors_count, 0);
  assert.ok(parsed.proof_warnings.some(w => w.code === 'unknown_nonmaterial_present'));
});

test('обычный неизвестный автор в звонке сохраняет прежнюю warning-политику', () => {
  const mono = { fact_id: 'f002', source: 'call_transcript', actor: 'unknown', content: 'Алло' };
  const parsed = parseJudgeResponse(response([signal(['f002'], 'client_statement')]),
    { deal_id: 10, facts_packet: { facts: [mono], metrics: {}, deal_card: {} } }, 'Промпт', now);
  assert.equal(parsed.proof_errors_count, 0);
  assert.equal(parsed.proof_warnings[0].severity, 'warning');
  assert.equal(parsed.proof_warnings[0].code, undefined);
});
