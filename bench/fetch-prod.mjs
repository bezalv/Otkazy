// Выгрузка разборов, сделанных продом после переключения на Sol (prompt_version = v2.6-sol).
// Нужна для слепой проверки на настоящих текстах: bench/blind-test.mjs --from-db
// Запуск: node bench/fetch-prod.mjs [--version v2.6-sol]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'bench', 'data');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const VERSION = arg('version', 'v2.6-sol');

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
const r = await fetch(`${E.SUPABASE_URL}/rest/v1/lost_deal_analyses?prompt_version=eq.${VERSION}` +
  `&select=deal_id,processed_at,judge_model,writer_model,ai_verdict,ai_closure_reason_class,ai_final_comment,ai_judge_json` +
  `&order=processed_at.desc`, { headers: { apikey: E.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${E.SUPABASE_PUBLISHABLE_KEY}` } });
if (!r.ok) { console.error(`REST ${r.status}: ${(await r.text()).slice(0, 300)}`); process.exit(1); }

const rows = await r.json();
const seen = new Set();
const out = [];
for (const row of rows) {
  if (seen.has(row.deal_id)) continue;   // берём самый свежий прогон по сделке
  seen.add(row.deal_id);
  const j = row.ai_judge_json || {};
  out.push({
    deal_id: row.deal_id,
    processed_at: row.processed_at,
    judge_model: row.judge_model,
    writer_model: row.writer_model,
    final_comment: row.ai_final_comment,
    judge: {
      verdict: j.verdict, verdict_reason_short: j.verdict_reason_short,
      closure_reason_class: j.closure_reason_class, exact_reason: j.exact_reason,
      misplaced: j.misplaced, correct_stage: j.correct_stage,
      recoverable_level: j.recoverable_level,
      manager_mistakes: j.manager_mistakes, key_signals: j.key_signals,
      risk_factors: j.risk_factors, questions_for_manager: j.questions_for_manager
    },
    judge_cost_rub: j.judge_usage?.cost_rub ?? null,
    writer_cost_rub: j.writer_usage?.cost_rub ?? null
  });
}
out.sort((a, b) => a.deal_id - b.deal_id);
fs.writeFileSync(path.join(DATA, 'prod-texts.json'), JSON.stringify(out, null, 2), 'utf8');

const sum = out.reduce((s, d) => s + (d.judge_cost_rub || 0) + (d.writer_cost_rub || 0), 0);
console.log(`Разборов на ${VERSION}: ${out.length}`);
if (out.length) console.log(`Цена: сумма ${sum.toFixed(2)} ₽, средняя ${(sum / out.length).toFixed(2)} ₽ за сделку`);
console.table(out.map(d => ({
  сделка: d.deal_id, вердикт: d.judge.verdict, класс: d.judge.closure_reason_class,
  ошибок: (d.judge.manager_mistakes || []).length,
  'символов текста': (d.final_comment || '').length,
  '₽': +((d.judge_cost_rub || 0) + (d.writer_cost_rub || 0)).toFixed(2)
})));
