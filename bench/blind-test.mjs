// Слепая проверка текстов: пары «Opus / Sol» в том виде, в каком комментарий видит РОП
// в карточке Б24. Форматирование повторяет ноду «Собрать AI-комментарий», но без футера
// с названием модели — иначе проверка перестаёт быть слепой.
//
// Ключ ответов пишется отдельным файлом в bench/data (вне git).
// Запуск: node bench/blind-test.mjs [--tag sol-k2] [--pairs 10]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'bench', 'data');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const TAG = arg('tag', 'sol-k2');
// --from-db: тексты Sol берутся не из сырых ответов стенда, а из базы — то есть ровно те,
// что выдал прод после переключения. Источник: bench/data/prod-texts.json (готовит fetch-prod.mjs).
const fromDb = process.argv.includes('--from-db');
const WANT = Number(arg('pairs', 10));

// Порядок внутри пары фиксируем от seed, чтобы перезапуск давал тот же расклад.
const SEED = arg('seed', 'otkazy-2026-09-30');
function coin(dealId) {
  return crypto.createHash('sha256').update(`${SEED}|${dealId}`).digest()[0] % 2 === 0;
}

const verdictMap = { 'правомерен': 'Правомерен', 'неправомерен': 'Неправомерен' };
const classMap = {
  manager_dropped: 'Менеджер бросил сделку', competitor: 'Ушёл к конкуренту', price: 'Цена',
  no_need: 'Нет потребности', no_money: 'Нет бюджета', timing: 'Не время',
  customer_unreachable: 'Клиент не отвечает', regulatory: 'Регуляторные ограничения', other: 'Прочее'
};
const recoverableMap = { 'высокий': 'высокий шанс (≈80%)', 'средний': 'средний шанс (≈50%)', 'низкий': 'низкий шанс (≈25%)' };

// Повторяет сборку комментария из ноды «Собрать AI-комментарий», футер опущен.
function renderComment(judge, finalComment) {
  const verdictRaw = judge.verdict || 'неизвестно';
  const classRaw = judge.closure_reason_class || 'other';
  const L = [];
  L.push('[B]🔍 AI-анализ отказа[/B]');
  L.push('');
  L.push('[B]Вердикт:[/B] ' + (verdictMap[verdictRaw] || verdictRaw) + (judge.verdict_reason_short ? ' — ' + judge.verdict_reason_short : ''));
  L.push('[B]Класс причины:[/B] ' + (classMap[classRaw] || classRaw) + ' (' + classRaw + ')');
  if (verdictRaw === 'неправомерен') {
    if (judge.recoverable_level && recoverableMap[judge.recoverable_level]) L.push('[B]Возврат сделки:[/B] ' + recoverableMap[judge.recoverable_level]);
    if (judge.misplaced === true && judge.correct_stage) L.push('[B]Корректная стадия:[/B] ' + judge.correct_stage + ' (сделка в неправильной стадии)');
  } else if (verdictRaw === 'правомерен') {
    L.push('[B]Возврат сделки:[/B] не требуется');
  }
  L.push('─────────────────────────────────────');
  L.push('');
  const fc = (finalComment || '').trim();
  if (fc && fc !== 'Отказ правомерен') L.push(fc);
  else if (judge.exact_reason) L.push('[B]Причина отказа:[/B] ' + judge.exact_reason);
  else L.push('(детальный анализ недоступен)');
  L.push('');
  L.push('─────────────────────────────────────');
  return L.join('\n');
}

// BB-коды → markdown: в карточке РОП видит жирный текст, а не теги.
const bbToMd = (s) => s.replace(/\[B\]/g, '**').replace(/\[\/B\]/g, '**').replace(/\[I\]/g, '_').replace(/\[\/I\]/g, '_');

// ── подбор сделок, где есть оба текста ──────────────────────────────────────
const rawDir = path.join(DATA, 'raw', TAG);
const candidates = [];

if (fromDb) {
  const prod = JSON.parse(fs.readFileSync(path.join(DATA, 'prod-texts.json'), 'utf8'));
  for (const row of prod) {
    const goldenPath = path.join(DATA, 'golden', `${row.deal_id}.json`);
    if (!fs.existsSync(goldenPath)) { console.log(`  ! ${row.deal_id}: нет эталона Opus, пропуск`); continue; }
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
    const opusText = (golden.final_comment || '').trim();
    const solText = (row.final_comment || '').trim();
    if (!opusText || opusText === 'Отказ правомерен' || opusText.length < 200) { console.log(`  ! ${row.deal_id}: текст Opus короткий, пропуск`); continue; }
    if (!solText || solText === 'Отказ правомерен' || solText.length < 200) { console.log(`  ! ${row.deal_id}: текст Sol короткий, пропуск`); continue; }
    candidates.push({
      dealId: row.deal_id,
      opus: renderComment(golden.judge, opusText),
      sol: renderComment(row.judge, solText),
      opusLen: opusText.length, solLen: solText.length
    });
  }
} else
for (const f of fs.readdirSync(rawDir)) {
  const m = f.match(/^(\d+)\.writer\.json$/);
  if (!m) continue;
  const dealId = Number(m[1]);
  const goldenPath = path.join(DATA, 'golden', `${dealId}.json`);
  if (!fs.existsSync(goldenPath)) continue;
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
  const opusText = (golden.final_comment || '').trim();
  if (!opusText || opusText === 'Отказ правомерен' || opusText.length < 200) continue;

  const solWriter = JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8'));
  const solText = (solWriter.raw_content || '').trim();
  if (!solText || solText.length < 200) continue;
  const solJudge = JSON.parse(fs.readFileSync(path.join(rawDir, `${dealId}.judge.json`), 'utf8')).parsed.judge;

  candidates.push({
    dealId,
    opus: renderComment(golden.judge, opusText),
    sol: renderComment(solJudge, solText),
    opusLen: opusText.length, solLen: solText.length
  });
}

candidates.sort((a, b) => a.dealId - b.dealId);
const chosen = candidates.slice(0, WANT);

// ── раскладка пар и ключ ────────────────────────────────────────────────────
const pairs = chosen.map((c, i) => {
  const opusFirst = coin(c.dealId);
  return {
    n: i + 1, dealId: c.dealId,
    A: opusFirst ? c.opus : c.sol,
    B: opusFirst ? c.sol : c.opus,
    keyA: opusFirst ? 'opus' : 'sol',
    keyB: opusFirst ? 'sol' : 'opus'
  };
});

fs.writeFileSync(path.join(DATA, 'blind-key.json'), JSON.stringify({
  _что_это: 'Ключ слепой проверки. Не показывать до того, как Саня ответит по всем парам.',
  tag: TAG, seed: SEED, создан: new Date().toISOString(),
  пары: pairs.map(p => ({ пара: p.n, deal_id: p.dealId, A: p.keyA, B: p.keyB }))
}, null, 2), 'utf8');

// Текст пар — с BB-кодами, ровно как уходит в карточку.
fs.writeFileSync(path.join(DATA, 'blind-pairs.txt'),
  pairs.map(p => `${'='.repeat(78)}\nПАРА ${p.n}  (сделка ${p.dealId})\n${'='.repeat(78)}\n\n--- ВАРИАНТ А ---\n${p.A}\n\n--- ВАРИАНТ Б ---\n${p.B}\n`).join('\n'), 'utf8');

// Для показа в чате — BB заменены на markdown, как это видит РОП.
fs.writeFileSync(path.join(DATA, 'blind-pairs-md.txt'),
  pairs.map(p => `### Пара ${p.n}\n\n**Вариант А**\n\n${bbToMd(p.A)}\n\n**Вариант Б**\n\n${bbToMd(p.B)}\n`).join('\n---\n\n'), 'utf8');

console.log(`Кандидатов с двумя текстами: ${candidates.length}, взято пар: ${pairs.length}`);
console.log(`Порядок в парах: ${pairs.filter(p => p.keyA === 'opus').length} с Opus в А, ${pairs.filter(p => p.keyA === 'sol').length} с Sol в А`);
console.table(chosen.map((c, i) => ({ пара: i + 1, сделка: c.dealId, 'символов Opus': c.opusLen, 'символов Sol': c.solLen })));
console.log(`\nПары:  bench/data/blind-pairs.txt (с BB-кодами) и blind-pairs-md.txt (для чата)`);
console.log(`Ключ:  bench/data/blind-key.json — вне git, не открывать до конца проверки`);
