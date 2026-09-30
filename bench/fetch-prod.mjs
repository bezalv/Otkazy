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
const PRICES = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'prices.json'), 'utf8'));
const FLEX = PRICES['openai/gpt-6-sol'].flex;
const ALARM = PRICES['openai/gpt-6-sol'].fallback_ratio_alarm;

// Кто ответил, по ответу не видно: поле provider у Polza всегда openrouter. Запасного
// провайдера ловим по цене — выше ×1,6 от «токены × цена flex» значит ответил обычный openai.
// Ниже единицы — нормально: сработал кэш Polza на общем промпте.
function fallbackCheck(usage) {
  if (!usage || usage.cost_rub == null) return null;
  const expected = ((usage.prompt_tokens || 0) * FLEX.input + (usage.completion_tokens || 0) * FLEX.output) / 1e6;
  if (expected <= 0) return null;
  const ratio = usage.cost_rub / expected;
  return { ratio: +ratio.toFixed(2), suspect: ratio > ALARM, cached: usage.prompt_tokens_details?.cached_tokens ?? 0 };
}

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
    writer_cost_rub: j.writer_usage?.cost_rub ?? null,
    judge_fallback: fallbackCheck(j.judge_usage),
    writer_fallback: fallbackCheck(j.writer_usage),
    proof_errors_count: j.proof_errors_count ?? null,
    mistakes: (j.manager_mistakes || []).length
  });
}
out.sort((a, b) => a.deal_id - b.deal_id);
fs.writeFileSync(path.join(DATA, 'prod-texts.json'), JSON.stringify(out, null, 2), 'utf8');

const sum = out.reduce((s, d) => s + (d.judge_cost_rub || 0) + (d.writer_cost_rub || 0), 0);
console.log(`Разборов на ${VERSION}: ${out.length}`);
if (out.length) console.log(`Цена: сумма ${sum.toFixed(2)} ₽, средняя ${(sum / out.length).toFixed(2)} ₽ за сделку`);
console.table(out.map(d => ({
  сделка: d.deal_id,
  время: new Date(d.processed_at).toLocaleString('ru-RU', { timeZone: 'Asia/Novosibirsk', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
  вердикт: d.judge.verdict, класс: d.judge.closure_reason_class,
  ошибок: d.mistakes,
  'текст': (d.final_comment || '').length,
  '₽': +((d.judge_cost_rub || 0) + (d.writer_cost_rub || 0)).toFixed(2),
  '×flex судья': d.judge_fallback?.ratio ?? '—',
  'из кэша': d.judge_fallback?.cached ?? '—'
})));

// ── что смотреть ежедневно ──────────────────────────────────────────────────
const byVerdict = {}, byClass = {};
for (const d of out) {
  byVerdict[d.judge.verdict] = (byVerdict[d.judge.verdict] || 0) + 1;
  byClass[d.judge.closure_reason_class] = (byClass[d.judge.closure_reason_class] || 0) + 1;
}
console.log('');
console.log('Вердикты:', byVerdict);
console.log('Классы  :', byClass);

const fb = out.filter(d => d.judge_fallback?.suspect || d.writer_fallback?.suspect);
console.log('');
console.log(`Запасной провайдер: ${fb.length ? '✗ подозрение на ' + fb.map(d => d.deal_id).join(', ') : '✓ не отвечал ни разу'}`);
const empty = out.filter(d => !d.final_comment || d.final_comment.trim().length < 200);
console.log(`Короткие или пустые тексты: ${empty.length ? '✗ ' + empty.map(d => d.deal_id).join(', ') : '✓ нет'}`);
const proofErr = out.filter(d => d.proof_errors_count);
console.log(`Ошибки валидатора пруфов: ${proofErr.length ? proofErr.map(d => `${d.deal_id} (${d.proof_errors_count})`).join(', ') + '  — смотреть ai_proof_warnings: обычно перепутан proof_type, а не битая ссылка' : '✓ нет'}`);
const pricey = out.filter(d => ((d.judge_cost_rub || 0) + (d.writer_cost_rub || 0)) > 8);
console.log(`Дороже 8 ₽ за сделку: ${pricey.length ? '✗ ' + pricey.map(d => d.deal_id).join(', ') : '✓ нет'}`);
const noMistakes = out.filter(d => d.mistakes === 0 && d.judge.verdict !== 'недостаточно_данных');
console.log(`Живой вердикт без разбора ошибок: ${noMistakes.length ? '! ' + noMistakes.map(d => d.deal_id).join(', ') : '✓ нет'}`);
