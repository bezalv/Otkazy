import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCommunicationAnalytics } from '../../app/src/analysis/communication-analytics.mjs';
import { parseJudgeResponse } from '../../app/src/agents/judge.mjs';
import { runAgents } from '../../app/src/agents/index.mjs';

const now = Date.parse('2026-02-15T00:00:00Z');
const at = day => new Date(Date.UTC(2026, 0, 1 + day)).toISOString();
const chat = (day, role = 'client', extra = {}) => ({ type: 'chat', date: at(day), role,
  direction: role === 'manager' ? 'outgoing' : role === 'client' ? 'incoming' : 'unknown',
  text: role === 'unknown' ? '👍' : 'Содержательное сообщение', ...extra });
const markedReaction = day => chat(day, 'unknown', { _unknown_role_nonmaterial: 'semantic_inference', _wazzup_author_ambiguous: true });
const analytics = communications => buildCommunicationAnalytics({ deal_id: 10, lose_date: at(30), communications }, now);

function response(metric) {
  return { choices: [{ message: { content: JSON.stringify({
    verdict: 'правомерен', verdict_reason_short: 'Отказ', closure_reason_class: 'other', recoverable_level: null,
    misplaced: false, correct_stage: null, exact_reason: 'Причина', manager_mistakes: [],
    key_signals: [{ signal: 'Основание', proof_type: 'metric', proof_fact_ids: [`metric:${metric}`] }],
    risk_factors: [], questions_for_manager: [],
  }) } }] };
}

test('реакция может разделить разрыв: динамика неизвестна, факт и обычные показатели сохранены', () => {
  const content = [chat(0, 'manager'), chat(10, 'client'), chat(12, 'manager'), chat(14, 'client')];
  const original = analytics(content);
  const ordinary = analytics([...content, chat(5, 'unknown')]);
  assert.equal(original.comm_analytics.max_gap_days, 10);
  assert.equal(ordinary.comm_analytics.max_gap_days, 5);
  const events = [...content, markedReaction(5)];
  const result = analytics(events), metrics = result.comm_analytics;
  assert.equal(result.communications, events);
  assert.equal(metrics.chats_total, 5);
  assert.equal(metrics.chats_unknown, 1);
  for (const field of ['max_gap_days', 'max_gap_period', 'trend']) {
    assert.equal(metrics[field], null, field);
    assert.ok(metrics.chat_unknown_nonmaterial.affected_metrics.includes(field), field);
  }
  assert.match(result.analytics_text, /Max gap: неизвестно/);
  assert.match(result.analytics_text, /Trend: неизвестно/);
  assert.doesNotMatch(result.analytics_text, /Max gap: \d+ days/);
  assert.doesNotMatch(result.analytics_text, /Trend: (?:stable|increasing|decreasing|pulsating|unknown)/);
  assert.equal(original.comm_analytics.cutoff_at, metrics.cutoff_at);
  assert.equal(original.comm_analytics.cutoff_source, metrics.cutoff_source);
});

test('реакция может изменить тренд: обычный путь и неизменённая старая отсечка остаются прежними', () => {
  const content = [chat(0, 'client'), chat(2, 'manager'), chat(3, 'client'), chat(4, 'manager')];
  assert.equal(analytics(content).comm_analytics.trend, 'increasing');
  assert.equal(analytics([...content, chat(1, 'unknown')]).comm_analytics.trend, 'stable');
  const input = [...content, markedReaction(1)];
  const result = analytics(input);
  assert.equal(result.comm_analytics.trend, null);
  const later = [...input, chat(35, 'manager')];
  const shifted = analytics(later).comm_analytics;
  assert.equal(shifted.cutoff_at, at(35));
  assert.equal(shifted.cutoff_source, 'lose_date');
  assert.equal(shifted.trend, null);
  // Обычный неизвестный автор или неподтверждённый маркер не меняет поведение.
  const unmarked = analytics([...content, chat(1, 'unknown', { _unknown_role_nonmaterial: 'other' })]);
  assert.equal(unmarked.comm_analytics.trend, 'stable');
  assert.equal(unmarked.comm_analytics.chat_unknown_nonmaterial, undefined);
});

test('судья не может сослаться на неопределённые показатели, писатель не вызывается', async () => {
  const metrics = analytics([chat(0), markedReaction(1), chat(2, 'manager'), chat(3), chat(4, 'manager')]).comm_analytics;
  for (const metric of ['max_gap_days', 'max_gap_period', 'trend']) {
    const prepared = { deal_id: 10, _data_enough: true, judge_request_body: {},
      facts_packet: { facts: [], metrics, deal_card: {} } };
    const parsed = parseJudgeResponse(response(metric), prepared, 'Промпт', now);
    assert.equal(parsed.proof_errors_count, 1);
    assert.ok(parsed.proof_warnings.some(w => w.code === 'unknown_nonmaterial_metric_as_proof' && w.severity === 'error'));
    const calls = [];
    const out = await runAgents({ prepared, pipelineGate: { block: false }, analytics: { comm_analytics: metrics },
      writerSystemPrompt: 'Промпт', now, rejectUnknownRoleProof: true, client: { async complete(body, options) {
        calls.push(options.role); return response(metric);
      } } });
    assert.deepEqual(calls, ['judge']);
    assert.ok(out.pipeline_error);
    assert.equal(out.multi_agent_analysis, null);
  }
});
