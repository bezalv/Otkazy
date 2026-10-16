// Сверка отсечки по причине отказа: признак в нодах ведёт себя так же, как источник
// prototype/lib/duplicate-skip.js, и прежнее имя статуса нигде не осталось.
//
// Ноды выгружаются сами, по API, а не переносом кода руками.
// Запуск: node bench/check-skip-reasons.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..').replace(/\\/g, '/');
const env = {};
for (const l of fs.readFileSync(ROOT + '/.env', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const base = (env.N8N_BASE_URL || 'https://bezalv.ru').replace(/\/+$/, '');

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ok   ' + n); };
const bad = (n, h) => { fail++; console.log('  FAIL ' + n + (h ? '\n       ' + h : '')); };

const r = await fetch(`${base}/api/v1/workflows/BhPWB9S6W5dlMUvV`, { headers: { 'X-N8N-API-KEY': env.N8N_API_KEY } });
if (!r.ok) { console.error('n8n API ' + r.status); process.exit(2); }
const wf = await r.json();
const node = (nm) => wf.nodes.find((n) => n.name === nm);
const kod = {};
for (const nm of ['Обработать 1 сделку', 'Получить сделки из Bitrix', 'Подготовить SQL']) {
  const n = node(nm);
  if (!n) { bad('нода «' + nm + '» не найдена'); continue; }
  kod[nm] = n.parameters.jsCode || '';
}
const otvet = node('Ответ webhook');

console.log('=== Синтаксис правленых нод ===');
for (const [nm, src] of Object.entries(kod)) {
  try { new Function('return (async function(){' + src + '})'); ok(nm); }
  catch (e) { bad(nm, e.message); }
}

// ── поведение признака: нода против источника ──
const lib = fs.readFileSync(ROOT + '/prototype/lib/duplicate-skip.js', 'utf8');
const L = new Function(lib + '\nreturn { skipLoseReasonKey, isSkipLoseReason, SKIP_LOSE_REASONS, SKIP_LOSE_REASON_IDS };')();

function teloFunkcii(src, imya) {
  const nachalo = src.indexOf('function ' + imya + '(');
  if (nachalo === -1) return '';
  const pervaya = src.indexOf('{', nachalo);
  if (pervaya === -1) return '';
  let glubina = 0;
  for (let i = pervaya; i < src.length; i++) {
    if (src[i] === '{') glubina++;
    else if (src[i] === '}') { glubina--; if (glubina === 0) return src.slice(nachalo, i + 1); }
  }
  return '';
}

console.log('\n=== Признак в «Обработать 1 сделку» против источника ===');
const src = kod['Обработать 1 сделку'] || '';
const konstanty = (src.match(/^\s*var SKIP_LOSE_REASONS?(_IDS)? =.*;$/gm) || []).join('\n');
let N = null;
try {
  N = new Function(konstanty + '\n' + teloFunkcii(src, 'skipLoseReasonKey')
    + '\nreturn { skipLoseReasonKey: skipLoseReasonKey, SKIP_LOSE_REASONS: SKIP_LOSE_REASONS, SKIP_LOSE_REASON_IDS: SKIP_LOSE_REASON_IDS };')();
} catch (e) { bad('не удалось вырезать признак из ноды', e.message); }

if (N) {
  // Весь справочник причин отказа, сверено с crm.deal.userfield.list 16.10.2026
  const SPRAVOCHNIK = [
    ['3991', 'Поиск застройщиков'], ['3957', 'Потенциальный дилер'], ['3419', 'Дорого'],
    ['3677', 'Отказ от замера'], ['3113', 'Не производим'], ['3115', 'Передумал/не актуально'],
    ['3415', 'Заявку не оставлял, остекление не интересует'], ['3119', 'Спам (банки, реклама, поставщики)'],
    ['3121', 'Не дозвонились/ не выходит на связь/игнор'], ['3123', 'Отказано заводом'],
    ['3125', 'Не устроили условия/сроки'], ['3127', 'Ошибся номером'],
    ['3129', 'Узнать информацию по заказу/ внести изменения в расчет'], ['3131', 'Дополнительный контакт'],
    ['3133', 'Сотрудник'], ['3173', 'Сервис'], ['3265', 'Готовые окна'], ['3297', 'Дубль'],
    ['3357', 'Заказал у других'], ['3447', 'Бросает трубку'], ['3687', 'Потенциальный агент (сделок нет)'],
    ['3967', 'Передано в другой отдел'],
  ];
  const kraevye = [
    [null, 'Дубль'], [null, 'дополнительный контакт'], ['3297', null], ['3131', null],
    [3297, ''], [3131, ''], [' 3297 ', ''], [null, '  Дубль  '], [null, 'Дубликат'],
    [null, 'Дополнительные контакты'], ['32970', ''], ['31310', ''], [null, ''], [null, null],
    [undefined, undefined], ['9999', 'Дубль'], ['3131', 'Дубль'],
  ];
  const vse = SPRAVOCHNIK.concat(kraevye);
  const rashod = vse.filter(([id, txt]) => N.skipLoseReasonKey(id, txt) !== L.skipLoseReasonKey(id, txt));
  rashod.length
    ? bad('признак расходится с источником', rashod.length + ' случаев из ' + vse.length)
    : ok('признак совпадает на ' + vse.length + ' случаях (все 22 значения справочника + краевые)');

  // Ровно две причины и ни одной лишней из справочника
  const otsekaem = SPRAVOCHNIK.filter(([id, txt]) => N.skipLoseReasonKey(id, txt) !== null).map(([, t]) => t);
  JSON.stringify(otsekaem.sort()) === JSON.stringify(['Дополнительный контакт', 'Дубль'])
    ? ok('из справочника отсекаются ровно «Дубль» и «Дополнительный контакт»')
    : bad('отсекается не то', 'отсекаются: ' + otsekaem.join(', '));
  JSON.stringify(N.SKIP_LOSE_REASONS) === JSON.stringify(L.SKIP_LOSE_REASONS)
    ? ok('список причин в ноде совпадает с источником')
    : bad('список причин разошёлся', 'нода: ' + JSON.stringify(N.SKIP_LOSE_REASONS));
  JSON.stringify(N.SKIP_LOSE_REASON_IDS) === JSON.stringify(L.SKIP_LOSE_REASON_IDS)
    ? ok('идентификаторы в ноде совпадают с источником')
    : bad('идентификаторы разошлись', 'нода: ' + JSON.stringify(N.SKIP_LOSE_REASON_IDS));
}

console.log('\n=== Прежнее имя статуса нигде не осталось ===');
for (const [nm, s] of Object.entries(kod)) {
  const staroe = [];
  if (s.includes('skipped_duplicate')) staroe.push('skipped_duplicate');
  if (s.includes('isDuplicateReason')) staroe.push('isDuplicateReason');
  if (s.includes('DUPLICATE_REASON')) staroe.push('DUPLICATE_REASON');
  staroe.length ? bad(nm + ': осталось ' + staroe.join(', ')) : ok(nm + ' — чисто');
}
const tOtvet = JSON.stringify(otvet && otvet.parameters || {});
tOtvet.includes('skipped_duplicate') ? bad('в ответе вебхука осталось skipped_duplicate') : ok('ответ вебхука — чисто');

console.log('\n=== Цепочка статуса сходится ===');
const obr = kod['Обработать 1 сделку'] || '';
const sql = kod['Подготовить SQL'] || '';
obr.includes("_status: 'skipped_by_reason'") ? ok('отсечка отдаёт skipped_by_reason') : bad('отсечка не отдаёт новый статус');
obr.includes('_skip_reason_key: skipKey') ? ok('причина пробрасывается ключом') : bad('нет _skip_reason_key');
sql.includes("r._status === 'skipped_by_reason'") ? ok('SQL ловит новый статус') : bad('SQL не ловит новый статус');
const pol = kod['Получить сделки из Bitrix'] || '';
pol.includes('_skipped_by_reason: skippedByReason') ? ok('счётчик отдаётся в ответ') : bad('счётчика нет');
pol.includes('_skipped_reasons: skippedReasons') ? ok('разбивка по причинам отдаётся') : bad('разбивки нет');
tOtvet.includes('skipped_by_reason') && tOtvet.includes('skipped_reasons')
  ? ok('ответ вебхука отдаёт счётчик и разбивку') : bad('ответ вебхука не отдаёт счётчик или разбивку');

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
