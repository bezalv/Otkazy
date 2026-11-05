import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { runAgents } from '../../app/src/agents/index.mjs';
import { parseJudgeResponse } from '../../app/src/agents/judge.mjs';
import { skipWriterComment } from '../../app/src/agents/writer.mjs';
import { buildJournal } from '../../app/src/analysis/journal.mjs';
import { buildCommunicationAnalytics } from '../../app/src/analysis/communication-analytics.mjs';
import { assembleFacts } from '../../app/src/analysis/facts-assembler.mjs';
import { dsEvaluate, dsInsufficientJudge } from '../../app/src/rules/data-sufficiency.mjs';
import { pgDecide, pgInitMarks, pgMarkComplete } from '../../app/src/rules/pipeline-gate.mjs';

const now = new Date('2026-10-19T00:00:00Z');
const writerPrompt = 'Тестовый промпт писателя';
const backupDir = resolve('tmp/backup/GLQ2iuzRaCQZM7QU');
const snapshots = {
  judge: resolve(backupDir, 'agent-judge-parse-2026-10-19.js'),
  skip: resolve(backupDir, 'skip-writer-2026-10-19.js'),
  writer: resolve(backupDir, 'agent-writer-parse-2026-10-19.js'),
  final: resolve(backupDir, 'final-output-2026-10-19.js'),
};
const analytics = { full_prompt_text: 'Журнал', journal_stats: { total_events: 1 }, comm_analytics: { cutoff_at: '2026-10-15T00:00:00Z' } };
const factsPacket = {
  deal_card: { deal_id: 1 },
  facts: [{ fact_id: 'f001', source: 'chat', actor: 'client', content: 'Нужны окна' }],
  metrics: { cutoff_at: '2026-10-15T00:00:00Z', last_contact_days_before_lose: 2 },
};
const prepared = {
  deal_id: 1, facts_packet: factsPacket, deal_card: factsPacket.deal_card,
  communications: [], journal_text: 'Журнал', analytics_text: 'Метрики', transcription_stats: {},
  judge_request_body: { model: 'openai/gpt-6-sol' }, _data_enough: true,
};
const judge = {
  verdict: 'правомерен', verdict_reason_short: 'Клиент отказался', recoverable_level: null,
  closure_reason_class: 'other', misplaced: false, correct_stage: null, exact_reason: 'Клиент отказался.',
  manager_mistakes: [], key_signals: [], risk_factors: [], questions_for_manager: [],
};
const answer = (value) => ({ model: 'openai/gpt-6-sol', usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }, choices: [{ message: { content: JSON.stringify(value) } }] });
const writerAnswer = { model: 'openai/gpt-6-sol', usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }, choices: [{ message: { content: 'Подробный разбор' } }] };

function snapshot(path, input, nodes = {}) {
  const code = readFileSync(path, 'utf8');
  const getNode = (name) => ({ first: () => ({ json: nodes[name] }), item: { json: nodes[name] } });
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now.getTime(); }
  }
  return new Function('$input', '$', 'Date', code)({ first: () => ({ json: input }) }, getNode, FixedDate)[0].json;
}

const baseArgs = { prepared, pipelineGate: { block: false }, analytics, screenshotStats: { total: 0 }, writerSystemPrompt: writerPrompt, now };

test('парсер и финальный результат совпадают с исходными нодами для правомерного отказа', { skip: !Object.values(snapshots).every(existsSync) }, async () => {
  const response = answer(judge);
  const oldJudge = snapshot(snapshots.judge, response, { 'agent-facts-assembler': prepared, 'Set: Writer System Prompt': { content: writerPrompt } });
  const parsed = parseJudgeResponse(response, prepared, writerPrompt, now);
  assert.deepStrictEqual(parsed, oldJudge);
  const skipped = snapshot(snapshots.skip, oldJudge);
  const expected = snapshot(snapshots.final, skipped, { 'b4.5 Comm Analytics': analytics, 'screenshots-parse': { screenshot_stats: baseArgs.screenshotStats } });
  let calls = 0;
  const actual = await runAgents({ ...baseArgs, client: { async complete() { calls++; return response; } } });
  assert.equal(calls, 1);
  assert.deepStrictEqual(actual, expected);
});

test('необязательные для старого парсера три поля могут отсутствовать', { skip: !existsSync(snapshots.judge) }, async () => {
  const { recoverable_level, correct_stage, questions_for_manager, ...oldShape } = judge;
  const response = answer(oldShape);
  const expected = snapshot(snapshots.judge, response, { 'agent-facts-assembler': prepared, 'Set: Writer System Prompt': { content: writerPrompt } });
  const parsed = parseJudgeResponse(response, prepared, writerPrompt, now);
  assert.deepStrictEqual(parsed, expected);
  const result = await runAgents({ ...baseArgs, client: { async complete() { return response; } } });
  assert.equal(result.multi_agent_analysis.verdict, 'правомерен');
});

test('неправомерный отказ запускает писателя и совпадает с исходными нодами', { skip: !Object.values(snapshots).every(existsSync) }, async () => {
  const response = answer({ ...judge, verdict: 'неправомерен', recoverable_level: 'высокий' });
  const oldJudge = snapshot(snapshots.judge, response, { 'agent-facts-assembler': prepared, 'Set: Writer System Prompt': { content: writerPrompt } });
  const oldWriter = snapshot(snapshots.writer, writerAnswer, { 'agent-judge-parse': oldJudge });
  const expected = snapshot(snapshots.final, oldWriter, { 'b4.5 Comm Analytics': analytics, 'screenshots-parse': { screenshot_stats: baseArgs.screenshotStats } });
  const bodies = [];
  const actual = await runAgents({ ...baseArgs, client: { async complete(body) { bodies.push(body); return bodies.length === 1 ? response : writerAnswer; } } });
  assert.equal(bodies.length, 2);
  assert.deepStrictEqual(bodies[1], oldJudge.writer_request_body);
  assert.deepStrictEqual(actual, expected);
});

test('блокировка полноты предотвращает вызовы обеих моделей', async () => {
  let calls = 0;
  const result = await runAgents({ ...baseArgs, pipelineGate: { block: true, pipeline_error: 'сбор неполный' }, client: { async complete() { calls++; } } });
  assert.equal(calls, 0);
  assert.equal(result.pipeline_error, 'сбор неполный');
  assert.equal(result.multi_agent_analysis, null);
});

test('неподтверждённый gate и отсутствующая проверка достаточности закрывают вход', async () => {
  let calls = 0;
  const client = { async complete() { calls++; } };
  const noGate = await runAgents({ ...baseArgs, pipelineGate: undefined, client });
  const noSufficiency = await runAgents({ ...baseArgs, prepared: { ...prepared, _data_enough: undefined }, client });
  assert.ok(noGate.pipeline_error);
  assert.ok(noSufficiency.pipeline_error);
  assert.equal(calls, 0);
});

test('отсечка достаточности не вызывает модель и сохраняет показатели', async () => {
  const ds = { enough: false, missing: ['данных'] };
  const dsJudge = { ...judge, verdict: 'недостаточно_данных', data_sufficiency: ds };
  const gated = { ...prepared, _data_enough: false, _data_sufficiency: ds, judge: dsJudge, judge_model: 'none (data-sufficiency gate)', judge_usage: {}, proof_warnings: [], proof_errors_count: 0 };
  let calls = 0;
  const result = await runAgents({ ...baseArgs, prepared: gated, client: { async complete() { calls++; } } });
  assert.equal(calls, 0);
  assert.equal(result.multi_agent_analysis.verdict, 'недостаточно_данных');
  assert.deepStrictEqual(result.multi_agent_analysis.data_sufficiency, ds);
  assert.equal(result.llm_meta.model, 'none (data-sufficiency gate)');
});

test('отсечка достаточности проходит без промпта писателя', async () => {
  const ds = { enough: false, missing: ['данных'] };
  const gated = {
    ...prepared,
    _data_enough: false,
    _data_sufficiency: ds,
    judge: { ...judge, verdict: 'недостаточно_данных', data_sufficiency: ds },
  };
  let calls = 0;
  const result = await runAgents({ ...baseArgs, prepared: gated, writerSystemPrompt: undefined, client: { async complete() { calls++; } } });
  assert.equal(calls, 0);
  assert.equal(result.multi_agent_analysis.verdict, 'недостаточно_данных');
});

test('правомерный отказ без ошибок проходит без промпта писателя', async () => {
  let calls = 0;
  const result = await runAgents({ ...baseArgs, writerSystemPrompt: undefined, client: { async complete() { calls++; return answer(judge); } } });
  assert.equal(calls, 1);
  assert.equal(result.multi_agent_analysis.verdict, 'правомерен');
});

test('при необходимости писателя отсутствие промпта блокирует разбор', async () => {
  let calls = 0;
  const result = await runAgents({ ...baseArgs, writerSystemPrompt: undefined, client: { async complete() { calls++; return answer({ ...judge, verdict: 'неправомерен' }); } } });
  assert.equal(calls, 1);
  assert.match(result.pipeline_error, /промпт/);
  assert.equal(result.multi_agent_analysis, null);
  assert.equal(result.llm_meta.total_tokens, 13);
});

for (const [name, response] of [
  ['пустой ответ', {}],
  ['битый JSON', { content: '{broken' }],
  ['нет обязательных полей', { content: JSON.stringify({ verdict: 'правомерен' }) }],
  ['неизвестный вердикт', answer({ ...judge, verdict: 'неизвестен' })],
  ['неизвестный тип причины', answer({ ...judge, closure_reason_class: 'fake' })],
  ['неверная форма доказательств', answer({ ...judge, risk_factors: [{ factor: 'x', proof_type: 'absence', proof_fact_ids: [123] }] })],
]) {
  test(`${name} становится ошибкой процесса без писателя`, async () => {
    let calls = 0;
    const result = await runAgents({ ...baseArgs, client: { async complete() { calls++; return response; } } });
    assert.equal(calls, 1);
    assert.ok(result.pipeline_error);
    assert.equal(result.multi_agent_analysis, null);
  });
}

for (const changed of [{ recoverable_level: 'низкий' }, { manager_mistakes: [{ mistake: 'Ошибка', proof_type: 'absence', proof_fact_ids: [] }] }]) {
  test(`дополнительное условие запуска писателя ${Object.keys(changed)[0]}`, async () => {
    let calls = 0;
    const result = await runAgents({ ...baseArgs, client: { async complete() { calls++; return calls === 1 ? answer({ ...judge, ...changed }) : writerAnswer; } } });
    assert.equal(calls, 2);
    assert.equal(result.multi_agent_analysis.final_comment, 'Подробный разбор');
  });
}

test('ошибка или пустой ответ писателя не превращается в завершённый разбор', async () => {
  for (const writerResult of [{}, new Error('секрет в тексте ошибки')]) {
    let calls = 0;
    const result = await runAgents({ ...baseArgs, client: { async complete() { calls++; if (calls === 1) return answer({ ...judge, verdict: 'неправомерен' }); if (writerResult instanceof Error) throw writerResult; return writerResult; } } });
    assert.equal(calls, 2);
    assert.ok(result.pipeline_error);
    assert.equal(result.multi_agent_analysis, null);
    assert.equal(result.llm_meta.total_tokens, 13);
    assert.equal(JSON.stringify(result).includes('секрет в тексте ошибки'), false);
  }
});

test('при некорректном ответе судьи сохраняются уже потраченные токены', async () => {
  const result = await runAgents({ ...baseArgs, client: { async complete() { return { content: 'bad', usage: { total_tokens: 100 } }; } } });
  assert.ok(result.pipeline_error);
  assert.equal(result.llm_meta.total_tokens, 100);
});

test('текст пропуска писателя совпадает с исходником правил', () => {
  const source = readFileSync('prototype/lib/skip-writer-comment.js', 'utf8');
  const original = new Function(`${source}\nreturn buildSkipWriterComment;`)();
  const values = [judge, { ...judge, verdict: 'недостаточно_данных' }, { ...judge, verdict: 'неправомерен' }, {}, { verdict: 'недостаточно_данных', exact_reason: 'Очень длинное пояснение. Другое предложение.' }];
  for (const value of values) assert.equal(skipWriterComment(value), original(value));
});

test('proof validator различает неизвестного говорящего и битую ссылку', () => {
  const packet = { ...prepared, facts_packet: { ...factsPacket, facts: [{ fact_id: 'f001', source: 'call_transcript', actor: 'unknown' }] } };
  const value = { ...judge, key_signals: [
    { signal: 'Слова', proof_type: 'client_statement', proof_fact_ids: ['f001'] },
    { signal: 'Нет факта', proof_type: 'client_statement', proof_fact_ids: ['f999'] },
    { signal: 'Нет метрики', proof_type: 'metric', proof_fact_ids: ['metric:missing'] },
  ] };
  const result = parseJudgeResponse(answer(value), packet, writerPrompt, now);
  assert.equal(result.proof_errors_count, 2);
  assert.deepStrictEqual(result.proof_warnings.map((warning) => warning.severity), ['warning', 'error', 'error']);
});

test('журнал, метрики, факты, гейты и судья совместимы на одном мок-входе', async () => {
  const input = {
    deal_id: 42,
    lose_date: '2026-10-18T12:00:00Z',
    communications: [{ type: 'chat', role: 'client', direction: 'incoming', date: '2026-10-17T12:00:00Z', text: 'Спасибо, пока заказ откладываю' }],
  };
  const metrics = buildCommunicationAnalytics(buildJournal(input), now);
  const facts = assembleFacts(metrics, 'Промпт судьи');
  const sufficiency = dsEvaluate(facts.facts_packet.facts);
  const marks = pgInitMarks();
  for (const source of ['calls', 'openlines', 'comments', 'tasks']) pgMarkComplete(marks, source, 1);
  const gate = pgDecide({ sources: marks, recognition: {} });
  assert.equal(gate.block, false);
  assert.equal(sufficiency.enough, true);
  let calls = 0;
  const result = await runAgents({
    prepared: { ...facts, _data_enough: sufficiency.enough, _data_sufficiency: sufficiency },
    pipelineGate: gate, analytics: metrics, writerSystemPrompt: writerPrompt, now,
    client: { async complete(body) { calls++; assert.equal(body.messages[0].content, 'Промпт судьи'); return answer(judge); } },
  });
  assert.equal(calls, 1);
  assert.equal(result.multi_agent_analysis.verdict, 'правомерен');
  assert.equal(result.multi_agent_analysis.facts_packet.facts[0].actor, 'client');
  assert.equal(result._ready_for, 'supabase');
});

test('настоящий гейт достаточности создаёт вердикт без вызова модели', async () => {
  const metrics = buildCommunicationAnalytics(buildJournal({ deal_id: 43, communications: [] }), now);
  const facts = assembleFacts(metrics, 'Промпт судьи');
  const ds = dsEvaluate(facts.facts_packet.facts);
  const marks = pgInitMarks();
  for (const source of ['calls', 'openlines', 'comments', 'tasks']) pgMarkComplete(marks, source, 1);
  const gate = pgDecide({ sources: marks, recognition: {} });
  let calls = 0;
  const result = await runAgents({
    prepared: { ...facts, _data_enough: ds.enough, _data_sufficiency: ds, judge: dsInsufficientJudge(ds) },
    pipelineGate: gate, analytics: metrics, writerSystemPrompt: writerPrompt, now,
    client: { async complete() { calls++; } },
  });
  assert.equal(calls, 0);
  assert.equal(result.multi_agent_analysis.verdict, 'недостаточно_данных');
  assert.equal(result.multi_agent_analysis.data_sufficiency.enough, false);
});
