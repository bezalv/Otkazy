// Сравнение эталона Opus с прогоном модели на том же входе.
// Запуск: node bench/compare.mjs [--model sol]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'bench', 'data');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const modelKey = arg('model', 'sol');
const TAG = arg('tag', modelKey);

const results = JSON.parse(fs.readFileSync(path.join(DATA, `results.${TAG}.json`), 'utf8'));
const golden = (id) => JSON.parse(fs.readFileSync(path.join(DATA, 'golden', `${id}.json`), 'utf8'));
const labelsPath = path.join(ROOT, 'bench', 'labels.json');
const labels = fs.existsSync(labelsPath) ? JSON.parse(fs.readFileSync(labelsPath, 'utf8')) : {};

const rows = [], mismatch = [];
let vOk = 0, cOk = 0, costSol = 0, costOpus = 0, mSol = 0, mOpus = 0;

for (const r of results) {
  if (r.error) { rows.push({ deal: r.deal_id, error: r.error }); continue; }
  const g = golden(r.deal_id);
  const gj = g.judge;
  const vMatch = gj.verdict === r.verdict;
  const cMatch = gj.closure_reason_class === r.reason_class;
  if (vMatch) vOk++;
  if (cMatch) cOk++;
  const gCost = (g.judge_usage?.cost_rub || 0) + (g.writer_usage?.cost_rub || 0);
  costSol += r.total_cost || 0; costOpus += gCost;
  mSol += r.mistakes; mOpus += (gj.manager_mistakes || []).length;

  rows.push({
    deal: r.deal_id,
    'вердикт Opus': gj.verdict, [`вердикт ${modelKey}`]: r.verdict, '=': vMatch ? 'да' : 'НЕТ',
    'класс Opus': gj.closure_reason_class, [`класс ${modelKey}`]: r.reason_class, '==': cMatch ? 'да' : 'нет',
    'ошибок Opus': (gj.manager_mistakes || []).length, [`ошибок ${modelKey}`]: r.mistakes,
    'возврат Opus': gj.recoverable_level, [`возврат ${modelKey}`]: r.recoverable,
    '₽ Opus': +gCost.toFixed(2), [`₽ ${modelKey}`]: +(r.total_cost || 0).toFixed(2),
    'решение Сани': labels[r.deal_id]?.verdict ?? '—'
  });

  if (!vMatch) {
    mismatch.push({
      deal_id: r.deal_id,
      opus: { verdict: gj.verdict, class: gj.closure_reason_class, reason_short: gj.verdict_reason_short, exact: gj.exact_reason, mistakes: (gj.manager_mistakes || []).map(m => m.mistake) },
      sol: (() => {
        const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'raw', TAG, `${r.deal_id}.judge.json`), 'utf8'));
        const j = raw.parsed.judge;
        return { verdict: j.verdict, class: j.closure_reason_class, reason_short: j.verdict_reason_short, exact: j.exact_reason, mistakes: (j.manager_mistakes || []).map(m => m.mistake) };
      })()
    });
  }
}

console.table(rows);
const n = rows.filter(r => !r.error).length;
console.log(`\nВердикт совпал: ${vOk}/${n}   Класс причины совпал: ${cOk}/${n}`);
console.log(`Ошибок менеджера найдено: Opus ${mOpus}, ${modelKey} ${mSol} (${mOpus ? Math.round(mSol / mOpus * 100) : 0}% от Opus)`);
console.log(`Цена набора: Opus ${costOpus.toFixed(2)} ₽, ${modelKey} ${costSol.toFixed(2)} ₽ — дешевле в ${(costOpus / costSol).toFixed(1)} раза`);
console.log(`Средняя на сделку: Opus ${(costOpus / n).toFixed(2)} ₽, ${modelKey} ${(costSol / n).toFixed(2)} ₽`);

// Критерии приёмки из документа СПИН.
const falsePositive = rows.filter(r => !r.error && r['вердикт Opus'] === 'неправомерен' && r[`вердикт ${modelKey}`] === 'правомерен');
console.log(`\n— «правомерен» там, где у Opus «неправомерен»: ${falsePositive.length} (критерий: 0) ${falsePositive.length ? '✗ ' + falsePositive.map(r => r.deal).join(', ') : '✓'}`);
const schemaFirstTry = results.filter(r => r.parse_method === 'direct').length;
console.log(`— ответ по схеме с первого раза: ${schemaFirstTry}/${n} (критерий: все) ${schemaFirstTry === n ? '✓' : '✗'}`);
const overPrice = results.filter(r => (r.total_cost || 0) > 8);
console.log(`— цена не выше 8 ₽ за сделку: превышений ${overPrice.length} (критерий: 0) ${overPrice.length ? '✗' : '✓'}`);
const fb = results.filter(r => r.fallback);
console.log(`— ответил запасной провайдер: ${fb.length} вызовов ${fb.length ? '✗ ' + fb.map(r => r.deal_id).join(', ') : '✓'}`);

fs.writeFileSync(path.join(DATA, `mismatch.${TAG}.json`), JSON.stringify(mismatch, null, 2), 'utf8');
console.log(`\nРасхождений вердикта: ${mismatch.length} → bench/data/mismatch.${TAG}.json`);
