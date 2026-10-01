// Стенд судьи и писателя: один и тот же сохранённый вход, меняется только модель.
//
// Что важно по устройству:
// - вход берётся из bench/data/inputs (facts_packet ровно тот, что видел Opus);
// - запрос собирается так же, как его собирает нода agent-facts-assembler;
// - ответ судьи разбирает НАСТОЯЩИЙ код ноды agent-judge-parse (из резервной копии + патч W1),
//   поэтому Proof Validator и сборка writer_input работают как в проде;
// - в базу не пишем ничего, сырые ответы кладём в bench/data/raw (там цитаты клиентов);
// - каждый вызов идёт в журнал расходов, при достижении потолка прогон останавливается.
//
// Запуск:
//   node bench/run.mjs --model sol                  все сделки
//   node bench/run.mjs --model sol --deals 124101   одна сделка
//   node bench/run.mjs --model sol --limit 1        первая по списку
//   node bench/run.mjs --model sol --judge-only     без писателя
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BENCH = path.join(ROOT, 'bench');
const DATA = path.join(BENCH, 'data');
const BACKUP = path.join(ROOT, 'tmp', 'backup', 'GLQ2iuzRaCQZM7QU');
const LEDGER = path.join(DATA, 'ledger.json');

const CEILING_RUB = 360;          // потолок расходов на весь стенд (поднят 30.09 с 300)
const POLZA_URL = 'https://api.polza.ai/api/v1/chat/completions';

// ── модели ───────────────────────────────────────────────────────────────────
// Параметры Sol — из документа «Переход Отказов на GPT-6 Sol — опыт СПИН»:
// flex первым (иначе Polza шлёт обычному openai, в 2,1–2,5 раза дороже), запасной
// оставлен, чтобы разбор не падал; reasoning низкий (верхнеуровневый Polza игнорирует);
// max_tokens 16000, потому что рассуждения съедают часть лимита, а обрезанный JSON не разберётся;
// strict-схема — только у судьи, у писателя текст.
const MODELS = {
  sol: {
    id: 'openai/gpt-6-sol',
    judge: {
      provider: { order: ['openai/flex', 'openai'], allow_fallbacks: true },
      reasoning: { effort: 'low' },
      max_tokens: 16000,
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: JSON.parse(fs.readFileSync(path.join(BENCH, 'schema.judge.json'), 'utf8')) }
    },
    writer: {
      provider: { order: ['openai/flex', 'openai'], allow_fallbacks: true },
      reasoning: { effort: 'low' },
      max_tokens: 16000,
      temperature: 0
    }
  },
  // Опус — как в проде, на случай если понадобится перепрогон эталона.
  opus: {
    id: 'anthropic/claude-opus-4.7',
    judge: { max_tokens: 4000, temperature: 0 },
    writer: { max_tokens: 2500, temperature: 0.2 }
  }
};

// ── аргументы ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name, def = null) {
  const i = argv.indexOf('--' + name);
  return i === -1 ? def : argv[i + 1];
}
const flag = (name) => argv.includes('--' + name);

const modelKey = arg('model', 'sol');
const MODEL = MODELS[modelKey];
if (!MODEL) { console.error(`Неизвестная модель: ${modelKey}. Есть: ${Object.keys(MODELS).join(', ')}`); process.exit(1); }
const judgeOnly = flag('judge-only');
const dealsArg = arg('deals');
const limit = arg('limit') ? Number(arg('limit')) : null;
// Проверка проброса lose_reason до судьи, пока воркфлоу не правили.
const withLoseReason = flag('with-lose-reason');
// Промпт судьи: рабочий (Opus) или копия под модель.
const promptDir = arg('prompt-dir');
// Метка прогона: под ней ложатся сырые ответы и результаты, чтобы круги не затирали друг друга.
const TAG = arg('tag', modelKey);

// ── окружение ────────────────────────────────────────────────────────────────
function env() {
  const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const out = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const KEY = env().POLZA_API_KEY;
if (!KEY) { console.error('Нет POLZA_API_KEY в .env'); process.exit(1); }

const PRICES = JSON.parse(fs.readFileSync(path.join(BENCH, 'prices.json'), 'utf8'));
const PROMPTS = promptDir
  ? path.resolve(ROOT, promptDir)
  : path.join(ROOT, 'prototype', 'prompts');
const judgeFile = fs.existsSync(path.join(PROMPTS, 'judge.md'))
  ? path.join(PROMPTS, 'judge.md')
  : path.join(ROOT, 'prototype', 'prompts', 'judge_v2.7.md');
const writerFile = fs.existsSync(path.join(PROMPTS, 'writer.md'))
  ? path.join(PROMPTS, 'writer.md')
  : path.join(ROOT, 'prototype', 'prompts', 'writer_v2.5.md');
const JUDGE_PROMPT = fs.readFileSync(judgeFile, 'utf8');
const WRITER_PROMPT = fs.readFileSync(writerFile, 'utf8');
console.log(`Промпт судьи:   ${path.relative(ROOT, judgeFile)} (${JUDGE_PROMPT.length} символов)`);
console.log(`Промпт писателя: ${path.relative(ROOT, writerFile)} (${WRITER_PROMPT.length} символов)`);

const EXTRA_PATH = path.join(DATA, 'deal_extra.json');
const DEAL_EXTRA = (withLoseReason && fs.existsSync(EXTRA_PATH))
  ? JSON.parse(fs.readFileSync(EXTRA_PATH, 'utf8')) : null;
if (withLoseReason && !DEAL_EXTRA) { console.error('Нет bench/data/deal_extra.json — сначала node bench/fetch.mjs'); process.exit(1); }

// ── настоящий код ноды agent-judge-parse ─────────────────────────────────────
// Берём резервную копию и накладываем те же патчи, что ушли в n8n (patches.json).
function loadJudgeParse() {
  const file = path.join(BACKUP, 'agent-judge-parse.js');
  let code = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
  const patches = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'b45', 'patches.json'), 'utf8'))
    .filter(p => p.node === 'agent-judge-parse');
  const applied = [];
  for (const p of patches) {
    const hits = code.split(p.find).length - 1;
    if (hits !== 1) throw new Error(`патч ${p.id}: find встречается ${hits} раз (нужно ровно 1)`);
    code = code.replace(p.find, p.replace);
    applied.push(p.id);
  }
  return { code, applied };
}

// Запуск кода ноды с подменой n8n-контекста.
function runJudgeParse(code, llmResponse, assemblerOut, writerPrompt) {
  const nodes = {
    'agent-facts-assembler': assemblerOut,
    'Set: Writer System Prompt': { content: writerPrompt }
  };
  const $input = { first: () => ({ json: llmResponse }), all: () => [{ json: llmResponse }] };
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`код ноды просит неизвестную ноду: ${name}`);
    const json = nodes[name];
    return { first: () => ({ json }), item: { json }, all: () => [{ json }] };
  };
  const fn = new Function('$input', '$', '"use strict";' + code);
  return fn($input, $)[0].json;
}

// ── журнал расходов ──────────────────────────────────────────────────────────
function loadLedger() {
  if (!fs.existsSync(LEDGER)) return { ceiling_rub: CEILING_RUB, calls: [] };
  return JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
}
function saveLedger(l) { fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2), 'utf8'); }
const ledger = loadLedger();
const spent = () => ledger.calls.reduce((s, c) => s + (c.cost_rub || 0), 0);

// Кто ответил — видно только по цене: поле provider в ответе всегда openrouter.
function fallbackSuspect(modelId, usage, costRub) {
  const p = PRICES[modelId]?.flex;
  if (!p || !costRub) return null;
  const inTok = usage.prompt_tokens || 0, outTok = usage.completion_tokens || 0;
  const expected = (inTok * p.input + outTok * p.output) / 1e6;
  if (expected <= 0) return null;
  const ratio = costRub / expected;
  return { expected_flex_rub: +expected.toFixed(4), ratio: +ratio.toFixed(2), suspect: ratio > (PRICES[modelId].fallback_ratio_alarm || 1.6) };
}

async function callPolza({ dealId, role, body }) {
  const left = CEILING_RUB - spent();
  if (left <= 0) throw new Error(`Потолок ${CEILING_RUB} ₽ достигнут (потрачено ${spent().toFixed(2)} ₽) — прогон остановлен`);

  const t0 = Date.now();
  const r = await fetch(POLZA_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const ms = Date.now() - t0;
  const text = await r.text();
  if (!r.ok) throw new Error(`Polza ${r.status} (${ms} мс): ${text.slice(0, 500)}`);
  const resp = JSON.parse(text);

  const usage = resp.usage || {};
  const costRub = usage.cost_rub ?? null;
  const fb = fallbackSuspect(body.model, usage, costRub);

  ledger.calls.push({
    ts: new Date().toISOString(), deal_id: dealId, role, model: body.model,
    prompt_tokens: usage.prompt_tokens ?? null, completion_tokens: usage.completion_tokens ?? null,
    reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
    cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? null,
    cost_rub: costRub, duration_ms: ms,
    provider_field: resp.provider ?? null, finish_reason: resp.choices?.[0]?.finish_reason ?? null,
    fallback_check: fb
  });
  saveLedger(ledger);
  return { resp, usage, costRub, ms, fb };
}

// ── прогон одной сделки ──────────────────────────────────────────────────────
const { code: parseCode, applied } = loadJudgeParse();
console.log(`Код ноды agent-judge-parse: применены патчи [${applied.join(', ')}]`);

const index = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
let deals = index.map(d => d.deal_id);
if (dealsArg) deals = dealsArg.split(',').map(s => Number(s.trim()));
if (limit) deals = deals.slice(0, limit);

const outDir = path.join(DATA, 'raw', TAG);
fs.mkdirSync(outDir, { recursive: true });

console.log(`Модель: ${MODEL.id} | метка: ${TAG} | сделок: ${deals.length} | lose_reason в карточке: ${DEAL_EXTRA ? 'да' : 'нет'} | потрачено: ${spent().toFixed(2)} / ${CEILING_RUB} ₽\n`);

const results = [];
for (const dealId of deals) {
  const packet = JSON.parse(fs.readFileSync(path.join(DATA, 'inputs', `${dealId}.json`), 'utf8'));
  // Проброс причины отказа в карточку — так, как это сделает правка b4.5, когда её согласуют.
  if (DEAL_EXTRA && DEAL_EXTRA[dealId]) {
    const e = DEAL_EXTRA[dealId];
    packet.deal_card = { ...packet.deal_card, lose_reason: e.lose_reason, lose_date: e.lose_date, days_in_lost: e.days_in_lost };
  }
  const row = { deal_id: dealId };
  try {
    // Запрос судьи собираем как agent-facts-assembler: system + facts_packet целиком в user.
    const judgeBody = {
      model: MODEL.id,
      messages: [
        { role: 'system', content: JUDGE_PROMPT },
        { role: 'user', content: JSON.stringify(packet, null, 2) }
      ],
      ...MODEL.judge
    };
    const jc = await callPolza({ dealId, role: 'judge', body: judgeBody });
    row.judge_cost = jc.costRub; row.judge_ms = jc.ms;
    row.judge_finish = jc.resp.choices?.[0]?.finish_reason ?? null;
    row.fallback = jc.fb?.suspect ?? null;

    // Разбор — настоящим кодом ноды. Он же прогоняет Proof Validator.
    const assemblerOut = {
      deal_id: dealId, facts_packet: packet, deal_card: packet.deal_card,
      communications: [], journal_text: '', analytics_text: '', transcription_stats: {}
    };
    const parsed = runJudgeParse(parseCode, jc.resp, assemblerOut, WRITER_PROMPT);

    fs.writeFileSync(path.join(outDir, `${dealId}.judge.json`), JSON.stringify({
      request_params: { ...MODEL.judge, model: MODEL.id, response_format: MODEL.judge.response_format ? 'json_schema strict' : null },
      usage: jc.usage, cost_rub: jc.costRub, duration_ms: jc.ms, fallback_check: jc.fb,
      raw_content: jc.resp.choices?.[0]?.message?.content ?? null,
      parsed
    }, null, 2), 'utf8');

    if (parsed.error) { row.error = parsed.message; results.push(row); console.log(`  ${dealId}: ОШИБКА разбора — ${parsed.message}`); continue; }

    row.parse_method = parsed.judge_parse_method;
    row.verdict = parsed.judge.verdict;
    row.reason_class = parsed.judge.closure_reason_class;
    row.recoverable = parsed.judge.recoverable_level;
    row.misplaced = parsed.judge.misplaced;
    row.mistakes = (parsed.judge.manager_mistakes || []).length;
    row.signals = (parsed.judge.key_signals || []).length;
    row.risks = (parsed.judge.risk_factors || []).length;
    row.proof_errors = parsed.proof_errors_count;

    // Писатель: тело собрал сам код ноды, подменяем только модель и лимиты.
    if (!judgeOnly) {
      const wb = { ...parsed.writer_request_body, model: MODEL.id, ...MODEL.writer };
      const wc = await callPolza({ dealId, role: 'writer', body: wb });
      row.writer_cost = wc.costRub; row.writer_ms = wc.ms;
      row.writer_finish = wc.resp.choices?.[0]?.finish_reason ?? null;
      fs.writeFileSync(path.join(outDir, `${dealId}.writer.json`), JSON.stringify({
        request_params: { ...MODEL.writer, model: MODEL.id },
        usage: wc.usage, cost_rub: wc.costRub, duration_ms: wc.ms, fallback_check: wc.fb,
        raw_content: wc.resp.choices?.[0]?.message?.content ?? null
      }, null, 2), 'utf8');
    }

    row.total_cost = (row.judge_cost || 0) + (row.writer_cost || 0);
    console.log(`  ${dealId}: ${row.verdict} / ${row.reason_class} | ошибок ${row.mistakes} | ${(row.total_cost).toFixed(2)} ₽ | ${((row.judge_ms + (row.writer_ms || 0)) / 1000).toFixed(1)} с`);
  } catch (e) {
    row.error = e.message;
    console.log(`  ${dealId}: СБОЙ — ${e.message}`);
    if (e.message.includes('Потолок')) { results.push(row); break; }
  }
  results.push(row);
}

fs.writeFileSync(path.join(DATA, `results.${TAG}.json`), JSON.stringify(results, null, 2), 'utf8');
const sum = results.reduce((s, r) => s + (r.total_cost || 0), 0);
const ok = results.filter(r => !r.error);
console.log(`\nГотово: ${ok.length}/${results.length} без сбоев | ${sum.toFixed(2)} ₽ | средняя ${ok.length ? (sum / ok.length).toFixed(2) : '—'} ₽/сделка`);
console.log(`Всего на стенде потрачено: ${spent().toFixed(2)} / ${CEILING_RUB} ₽`);
