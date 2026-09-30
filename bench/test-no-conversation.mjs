// Прогон детектора «разговора не было» по всем коротким звонкам из базы, без правок в n8n.
// Запуск: node bench/test-no-conversation.mjs [--seed 1] [--samples 10]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'bench', 'data');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const SEED = arg('seed', 'notalk-2026-09-30');
const SAMPLES = Number(arg('samples', 10));

// Детектор берём из файла как есть — тот же код уйдёт в ноды.
const src = fs.readFileSync(path.join(ROOT, 'prototype', 'lib', 'no-conversation.js'), 'utf8');
const detect = new Function(src + '\nreturn { detectNoConversation: detectNoConversation, NOTALK_MAX_SEC: NOTALK_MAX_SEC, NOTALK_MACHINE: NOTALK_MACHINE, NOTALK_GREETING: NOTALK_GREETING, NOTALK_PURPOSE: NOTALK_PURPOSE, notalkNormalize: notalkNormalize, notalkStripGreetings: notalkStripGreetings };')();

// Списки существующего detectVoicemail из agent-facts-assembler — чтобы отделить,
// что он уже ловит, а что детектор добирает.
const VM_HIGH = ['абонент недоступен', 'абонент не доступен', 'абонент временно недоступен',
  'абонент сейчас не на связи', 'абонент занят', 'тот кому вы звоните не отвечает',
  'номер абонента занят', 'переведен на автоответчик', 'переведён на автоответчик',
  'оставьте сообщение после сигнала', 'оставьте сообщение после звукового сигнала',
  'оставьте ваше сообщение', 'после звукового сигнала', 'после сигнала',
  'в тоновом режиме', 'в тональном режиме', 'для соединения нажмите',
  'я помощник', 'я помошник', 'секретарь ева', 'передам сообщение', 'передам ему сообщение',
  'передам ваше сообщение', 'я записала и отправила', 'записала и отправила',
  'сообщение улетело', 'сообщение отправлено', 'я записал для него ваш ответ',
  'я записала для него ваш ответ', 'оставьте для него ваше сообщение'];
const vmHit = (norm) => VM_HIGH.some(p => norm.indexOf(p) !== -1);

const calls = JSON.parse(fs.readFileSync(path.join(DATA, 'short-calls.json'), 'utf8'));

const flagged = [], notFlagged = [];
for (const c of calls) {
  const res = detect.detectNoConversation(c.transcript_client_text, c.transcript_manager_text, c.call_duration_seconds);
  const norm = detect.notalkNormalize(c.transcript_client_text);
  const row = {
    ...c,
    verdict: res,
    norm_client: norm,
    norm_manager: detect.notalkNormalize(c.transcript_manager_text),
    already_vm: c.transcript_status === 'voicemail' || vmHit(norm)
  };
  (res ? flagged : notFlagged).push(row);
}

// ── сводка ──────────────────────────────────────────────────────────────────
const tr = calls.filter(c => c.transcript_status === 'transcribed');
const flaggedTr = flagged.filter(c => c.transcript_status === 'transcribed');
const newlyCaught = flaggedTr.filter(c => !c.already_vm);

console.log('='.repeat(78));
console.log(`Всего коротких звонков (≤${detect.NOTALK_MAX_SEC} сек): ${calls.length}`);
console.log(`  из них transcribed: ${tr.length}, voicemail: ${calls.length - tr.length}`);
console.log(`\nПОМЕЧЕНО «разговора не было»: ${flagged.length} из ${calls.length} (${Math.round(flagged.length / calls.length * 100)}%)`);
console.log(`  среди transcribed: ${flaggedTr.length} из ${tr.length} (${Math.round(flaggedTr.length / tr.length * 100)}%)`);
console.log(`  из них НЕ ловит существующий detectVoicemail: ${newlyCaught.length} — это и есть прирост`);
const byReason = {};
for (const c of flagged) byReason[c.verdict.reason] = (byReason[c.verdict.reason] || 0) + 1;
console.log(`  по причине:`, byReason);
console.log(`\nНЕ помечено: ${notFlagged.length}`);
const nfEmpty = notFlagged.filter(c => !c.norm_client);
const nfPurpose = notFlagged.filter(c => c.norm_client && detect.NOTALK_PURPOSE.some(p => c.norm_manager.indexOf(p) !== -1));
console.log(`  из них: пустой транскрипт клиента ${nfEmpty.length}, менеджер назвал цель ${nfPurpose.length}, клиент сказал своё ${notFlagged.length - nfEmpty.length - nfPurpose.length}`);

// ── случайная выборка ───────────────────────────────────────────────────────
function pick(arr, n, salt) {
  const scored = arr.map(x => ({ x, h: crypto.createHash('sha256').update(`${SEED}|${salt}|${x.id}`).digest('hex') }));
  scored.sort((a, b) => a.h < b.h ? -1 : 1);
  return scored.slice(0, n).map(s => s.x);
}
const cut = (s, n) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

function show(title, rows) {
  console.log('\n' + '='.repeat(78));
  console.log(title);
  console.log('='.repeat(78));
  for (const c of rows) {
    console.log(`\nсделка ${c.deal_id} | ${c.call_duration_seconds} сек | ${c.direction} | статус ${c.transcript_status}${c.verdict ? ` | причина: ${c.verdict.reason}${c.verdict.matched ? ` («${c.verdict.matched}»)` : ''}` : ''}`);
    console.log(`  КЛИЕНТ:   ${cut(c.transcript_client_text, 240) || '(пусто)'}`);
    console.log(`  МЕНЕДЖЕР: ${cut(c.transcript_manager_text, 240) || '(пусто)'}`);
    if (c.verdict && c.verdict.reason === 'greeting_only') console.log(`  остаток после вырезания приветствий: «${c.verdict.rest}»`);
  }
}

show(`10 СЛУЧАЙНЫХ ПОМЕЧЕННЫХ (детектор говорит: разговора не было)`, pick(flagged, SAMPLES, 'flagged'));
show(`10 СЛУЧАЙНЫХ НЕ ПОМЕЧЕННЫХ (детектор говорит: разговор был)`, pick(notFlagged.filter(c => c.norm_client), SAMPLES, 'notflagged'));

// ── пограничные: клиент сказал что-то содержательное коротко ────────────────
// Ищем именно человеческие формулировки. Слова «перезвонить» и «занят» встречаются и внутри
// фраз роботов («попробуйте перезвонить», «абонент занят»), поэтому звонки с признаком робота
// из пограничных исключаем — там детектор прав по построению.
const EDGE_WORDS = ['я занят', 'мне неудобно', 'сейчас неудобно', 'не актуальн', 'не нужно',
  'не надо', 'некогда', 'перезвоните мне', 'перезвоните позже', 'позвоните позже', 'наберите позже',
  'я подумаю', 'за рулем', 'я на работе', 'на совещании', 'уже заказал', 'уже купил',
  'не интересует', 'я отказыва', 'не буду', 'я решил', 'мы решили', 'занята сейчас',
  'позже перезвоните', 'давайте позже', 'потом наберите'];
const edges = calls.map(c => {
  const norm = detect.notalkNormalize(c.transcript_client_text);
  if (detect.NOTALK_MACHINE.some(p => norm.indexOf(p) !== -1)) return null;  // это робот, не пограничный
  const hit = EDGE_WORDS.find(w => norm.indexOf(w) !== -1);
  return hit ? { c, hit, norm } : null;
}).filter(Boolean);
const edgesFlagged = edges.filter(e => detect.detectNoConversation(e.c.transcript_client_text, e.c.transcript_manager_text, e.c.call_duration_seconds));

console.log('\n' + '='.repeat(78));
console.log(`ПОГРАНИЧНЫЕ: клиент сказал что-то по существу в коротком звонке`);
console.log('='.repeat(78));
console.log(`Найдено таких звонков: ${edges.length}`);
console.log(`Из них детектор ОШИБОЧНО помечает: ${edgesFlagged.length} ${edgesFlagged.length ? '✗ смотреть ниже' : '✓ ни одного'}`);
for (const e of (edgesFlagged.length ? edgesFlagged : pick(edges.map(x => x.c), 8, 'edges').map(c => ({ c, hit: EDGE_WORDS.find(w => detect.notalkNormalize(c.transcript_client_text).indexOf(w) !== -1) })))) {
  const c = e.c;
  console.log(`\nсделка ${c.deal_id} | ${c.call_duration_seconds} сек | слово «${e.hit}» | помечен: ${detect.detectNoConversation(c.transcript_client_text, c.transcript_manager_text, c.call_duration_seconds) ? 'ДА (ошибка)' : 'нет ✓'}`);
  console.log(`  КЛИЕНТ:   ${cut(c.transcript_client_text, 200)}`);
  console.log(`  МЕНЕДЖЕР: ${cut(c.transcript_manager_text, 160) || '(пусто)'}`);
}

// ── отдельно: робот ответил, но менеджер успел назвать цель ─────────────────
const machineButPurpose = calls.filter(c => {
  const norm = detect.notalkNormalize(c.transcript_client_text);
  const mnorm = detect.notalkNormalize(c.transcript_manager_text);
  const machine = detect.NOTALK_MACHINE.some(p => norm.indexOf(p) !== -1);
  const purpose = detect.NOTALK_PURPOSE.some(p => mnorm.indexOf(p) !== -1);
  return machine && purpose;
});
console.log('\n' + '='.repeat(78));
console.log(`ОТДЕЛЬНЫЙ СЛУЧАЙ: ответил робот, но менеджер успел назвать цель — ${machineButPurpose.length} звонков`);
console.log('По твоему ТЗ такие НЕ помечаются (нужны все три условия). По смыслу разговора тоже не было —');
console.log('менеджер говорил с автоответчиком. Примеры для решения:');
for (const c of pick(machineButPurpose, 3, 'mbp')) {
  console.log(`\nсделка ${c.deal_id} | ${c.call_duration_seconds} сек`);
  console.log(`  КЛИЕНТ:   ${cut(c.transcript_client_text, 180)}`);
  console.log(`  МЕНЕДЖЕР: ${cut(c.transcript_manager_text, 180)}`);
}

fs.writeFileSync(path.join(DATA, 'notalk-result.json'), JSON.stringify({
  итого: calls.length, помечено: flagged.length, прирост_к_detectVoicemail: newlyCaught.length,
  по_причине: byReason,
  помеченные: flagged.map(c => ({ deal_id: c.deal_id, id: c.id, sec: c.call_duration_seconds, reason: c.verdict.reason, matched: c.verdict.matched, client: c.transcript_client_text, manager: c.transcript_manager_text }))
}, null, 2), 'utf8');
console.log(`\nПолный список помеченных: bench/data/notalk-result.json`);
