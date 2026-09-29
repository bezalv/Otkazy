// Выгрузка стенда: входы Judge (facts_packet) и эталонные ответы Opus по сделкам v2.5.
// Данные с цитатами клиентов кладём в bench/data/ — он вне git.
// Запуск: node bench/fetch.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'bench', 'data');

function env() {
  const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const out = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const E = env();
const SUPA = E.SUPABASE_URL, KEY = E.SUPABASE_PUBLISHABLE_KEY;
if (!SUPA || !KEY) { console.error('Нет SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY в .env'); process.exit(1); }

async function rest(query) {
  const r = await fetch(`${SUPA}/rest/v1/${query}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }
  });
  if (!r.ok) throw new Error(`REST ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Берём последний прогон v2.5 по каждой сделке.
const cols = ['deal_id', 'processed_at', 'prompt_version', 'judge_model', 'writer_model',
  'ai_verdict', 'ai_closure_reason_class', 'ai_final_comment', 'ai_facts_json', 'ai_judge_json',
  'ai_proof_warnings', 'ai_facts_count',
  'judge_prompt_tokens', 'judge_completion_tokens', 'writer_prompt_tokens', 'writer_completion_tokens'].join(',');

const rows = await rest(`lost_deal_analyses?prompt_version=eq.v2.5&select=${cols}&order=deal_id.asc,processed_at.desc`);

const seen = new Set();
const index = [];
for (const r of rows) {
  if (seen.has(r.deal_id)) continue;   // уже взяли более свежий прогон
  seen.add(r.deal_id);

  const packet = r.ai_facts_json;
  if (!packet || !packet.facts) { console.warn(`! ${r.deal_id}: нет facts_packet, пропускаю`); continue; }

  fs.writeFileSync(path.join(DATA, 'inputs', `${r.deal_id}.json`), JSON.stringify(packet, null, 2), 'utf8');

  const j = r.ai_judge_json || {};
  const golden = {
    deal_id: r.deal_id,
    processed_at: r.processed_at,
    prompt_version: r.prompt_version,
    judge_model: r.judge_model,
    writer_model: r.writer_model,
    judge: {
      verdict: j.verdict, verdict_reason_short: j.verdict_reason_short,
      closure_reason_class: j.closure_reason_class, exact_reason: j.exact_reason,
      misplaced: j.misplaced, correct_stage: j.correct_stage,
      recoverable_level: j.recoverable_level,
      manager_mistakes: j.manager_mistakes, key_signals: j.key_signals,
      risk_factors: j.risk_factors, questions_for_manager: j.questions_for_manager
    },
    final_comment: r.ai_final_comment,
    judge_usage: j.judge_usage || null,
    writer_usage: j.writer_usage || null,
    proof_warnings: r.ai_proof_warnings, proof_errors_count: j.proof_errors_count ?? null
  };
  fs.writeFileSync(path.join(DATA, 'golden', `${r.deal_id}.json`), JSON.stringify(golden, null, 2), 'utf8');

  index.push({
    deal_id: r.deal_id,
    processed_at: r.processed_at,
    verdict: r.ai_verdict,
    closure_reason_class: r.ai_closure_reason_class,
    facts: packet.facts.length,
    mistakes: (j.manager_mistakes || []).length,
    cutoff_source: packet.metrics?.cutoff_source ?? null,
    cutoff_at: packet.metrics?.cutoff_at ?? null,
    has_writer_text: !!(r.ai_final_comment && r.ai_final_comment.length > 100),
    judge_cost_rub: j.judge_usage?.cost_rub ?? null,
    writer_cost_rub: j.writer_usage?.cost_rub ?? null,
    input_chars: JSON.stringify(packet).length
  });
}

index.sort((a, b) => a.deal_id - b.deal_id);
fs.writeFileSync(path.join(DATA, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

console.log(`Сделок выгружено: ${index.length}`);
const byV = {}, byC = {};
for (const d of index) {
  byV[d.verdict] = (byV[d.verdict] || 0) + 1;
  byC[d.closure_reason_class] = (byC[d.closure_reason_class] || 0) + 1;
}
console.log('Вердикты:', byV);
console.log('Классы  :', byC);
const costs = index.filter(d => d.judge_cost_rub != null);
if (costs.length) {
  const sum = costs.reduce((s, d) => s + d.judge_cost_rub + (d.writer_cost_rub || 0), 0);
  console.log(`Цена Opus в базе: ${costs.length} сделок, сумма ${sum.toFixed(2)} ₽, средняя ${(sum / costs.length).toFixed(2)} ₽`);
} else {
  console.log('Цена Opus: cost_rub в judge_usage не найден');
}
console.table(index.map(d => ({
  deal: d.deal_id, verdict: d.verdict, class: d.closure_reason_class,
  facts: d.facts, mistakes: d.mistakes, text: d.has_writer_text ? 'да' : 'НЕТ',
  chars: d.input_chars, cost: d.judge_cost_rub
})));
