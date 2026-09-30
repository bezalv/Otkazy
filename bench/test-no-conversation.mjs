// Прогон детектора «разговора не было» по всем коротким звонкам из базы, без правок в n8n.
// Запуск: node bench/test-no-conversation.mjs [--samples 10]
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
const D = new Function(src + `
return { detectNoConversation: detectNoConversation, notalkNormalize: notalkNormalize,
  NOTALK_MACHINE: NOTALK_MACHINE, NOTALK_BOT_SMALLTALK: NOTALK_BOT_SMALLTALK,
  NOTALK_NOT_CLIENT: NOTALK_NOT_CLIENT, NOTALK_PURPOSE: NOTALK_PURPOSE,
  NOTALK_MAX_SEC: NOTALK_MAX_SEC, notalkHit: notalkHit };`)();

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
// Моно-запись: стерео не распозналось, весь звонок расшифрован одним потоком «Говорящий:».
const isMono = (c) => ((c.transcript_formatted || '').indexOf('Говорящий') !== -1);

const flagged = [], notFlagged = [];
for (const c of calls) {
  const res = D.detectNoConversation(c.transcript_client_text, c.transcript_manager_text, c.call_duration_seconds, isMono(c));
  const norm = D.notalkNormalize(c.transcript_client_text);
  const row = { ...c, verdict: res, norm_client: norm, norm_manager: D.notalkNormalize(c.transcript_manager_text), already_vm: c.transcript_status === 'voicemail' || vmHit(norm) };
  (res ? flagged : notFlagged).push(row);
}

const cut = (s, n) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
function pick(arr, n, salt) {
  const scored = arr.map(x => ({ x, h: crypto.createHash('sha256').update(`${SEED}|${salt}|${x.id}`).digest('hex') }));
  scored.sort((a, b) => a.h < b.h ? -1 : 1);
  return scored.slice(0, n).map(s => s.x);
}

// ── сводка ──────────────────────────────────────────────────────────────────
const tr = calls.filter(c => c.transcript_status === 'transcribed');
const flaggedTr = flagged.filter(c => c.transcript_status === 'transcribed');
const newlyCaught = flaggedTr.filter(c => !c.already_vm);
const byReason = {};
for (const c of flagged) byReason[c.verdict.reason] = (byReason[c.verdict.reason] || 0) + 1;

console.log('='.repeat(78));
console.log(`Коротких звонков: ${calls.length} (transcribed ${tr.length}, voicemail ${calls.length - tr.length})`);
console.log(`ПОМЕЧЕНО: ${flagged.length} из ${calls.length} (${Math.round(flagged.length / calls.length * 100)}%)`);
console.log(`  по причине:`, byReason);
console.log(`  прирост к существующему detectVoicemail: ${newlyCaught.length}`);
console.log(`НЕ помечено: ${notFlagged.length}`);

// Прирост именно от стоп-листа Сани: фразы, которых не было в моей первой версии.
const SANY_ONLY = ['защитник', 'умный бот', 'защита от спама', 'антиспам', 'знакомы с абонентом',
  'личному или деловому', 'личный или деловой', 'длительность сообщения', 'сообщение достигло',
  'сообщение готово', 'консультация оператора', 'на удержание', 'not available', 'please try again',
  'the number is', 'at the moment', 'try again later', 'switched off', 'номер не существует',
  'сеть перегружена', 'аппарат вызываемого'];
const fromSanyList = flagged.filter(c => D.notalkHit(c.norm_client, SANY_ONLY) || D.notalkHit(c.norm_client, D.NOTALK_BOT_SMALLTALK));
console.log(`  из них поймано фразами из стоп-листа Сани: ${fromSanyList.length}`);

// ── ГЛАВНАЯ ПРОВЕРКА: помеченные, где клиент говорит живыми словами ─────────
const LIVE = /(не актуальн|не надо|не нужн|заказал|поставил|не интересн|передумал|дорого|подума|на работе|перезвон|хорошо|спасибо|нет,|позже|в проекте)/;
const suspect = flagged.filter(c => LIVE.test((c.transcript_client_text || '').toLowerCase()));

console.log('\n' + '='.repeat(78));
console.log(`ГЛАВНАЯ ПРОВЕРКА: помеченные, где в реплике клиента есть живые слова — ${suspect.length}`);
console.log('='.repeat(78));
for (const c of suspect) {
  console.log(`\nсделка ${c.deal_id} | ${c.call_duration_seconds} сек | ${c.transcript_status} | причина: ${c.verdict.reason}${c.verdict.matched ? ` («${c.verdict.matched}»)` : ''}`);
  console.log(`  КЛИЕНТ:   ${cut(c.transcript_client_text, 400) || '(пусто)'}`);
  console.log(`  МЕНЕДЖЕР: ${cut(c.transcript_manager_text, 200) || '(пусто)'}`);
  console.log(`  остаток после вырезания: «${c.verdict.rest}» (${c.verdict.rest.length} симв., порог 12)`);
}

// ── контроль на разобранных сделках ─────────────────────────────────────────
console.log('\n' + '='.repeat(78));
console.log('КОНТРОЛЬ: сделки, которые Саня разобрал глазами');
console.log('='.repeat(78));
// Проверяем КОНКРЕТНЫЕ звонки по фрагменту транскрипта: в сделке их несколько, и часть
// помечена правильно. Фрагмент ищем в реплике клиента, либо в реплике менеджера (поле mgr).
const CONTROL = [
  { deal: 110387, frag: 'все в проекте', flag: false, what: 'живой клиент «у нас ещё всё в проекте»' },
  { deal: 110387, frag: 'его телефон занят', flag: true, what: 'в той же сделке — автоответчик' },
  { deal: 118715, frag: 'прослушала ваш голосовой', mgr: true, flag: false, what: 'живой разговор, менеджер прослушала голосовое' },
  { deal: 118715, frag: 'перенаправлен на голосовой почтовый', flag: true, what: 'в той же сделке — голосовая почта' },
  { deal: 109433, frag: 'хорошо можно', flag: false, what: 'живой контакт, менеджер представилась' },
  { deal: 119215, frag: 'по какому вопросу звоните', flag: true, what: 'исходный дефект, звонок 11 сек' },
  { deal: 119215, frag: 'слушаю', flag: true, what: 'исходный дефект, звонок 6 сек' },
  { deal: 121167, frag: 'сейчас нет вы по какому', flag: true, what: 'трубку снял не клиент' },
  { deal: 123295, frag: 'сейчас нет вы по какому', flag: true, what: 'то же' },
  { deal: 118181, frag: 'уже поставили', flag: false, what: 'живой отказ «мы уже поставили»' },
  { deal: 120721, frag: 'уже заказали в другом месте', flag: false, what: 'живой отказ «заказали в другом месте»' },
  { deal: 118055, frag: 'не актуально', flag: false, what: 'живой отказ «не актуально»' },
  { deal: 116425, frag: 'неудобно разговаривать давайте завтра', flag: false, what: 'живой «мне неудобно, давайте завтра»' },
  { deal: 115839, frag: 'абоненту пока неудобно', flag: true, what: 'бот «абоненту пока неудобно»' }
];
let fails = 0;
for (const t of CONTROL) {
  const rows = calls.filter(c => {
    if (c.deal_id !== t.deal) return false;
    const hay = D.notalkNormalize(t.mgr ? c.transcript_manager_text : c.transcript_client_text);
    return hay.indexOf(D.notalkNormalize(t.frag)) !== -1;
  });
  if (!rows.length) { console.log(`  ?    ${t.deal}: звонок с «${t.frag}» не найден`); fails++; continue; }
  const res = rows.map(c => D.detectNoConversation(c.transcript_client_text, c.transcript_manager_text, c.call_duration_seconds, isMono(c)));
  const anyFlag = res.some(Boolean);
  const ok = t.flag ? anyFlag : !anyFlag;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${t.deal} «${t.frag}»: [${res.map(r => r ? r.reason : 'нет').join(', ')}] — ${t.what}`);
}
console.log(`\nКонтроль: ${CONTROL.length - fails} из ${CONTROL.length} сошлось${fails ? ', есть расхождения' : ''}`);
if (fails) process.exitCode = 1;

// ── пограничные: живые короткие отказы ──────────────────────────────────────
const EDGE_WORDS = ['я занят', 'мне неудобно', 'сейчас неудобно', 'не актуальн', 'не нужно',
  'не надо', 'некогда', 'перезвоните мне', 'перезвоните позже', 'позвоните позже',
  'я подумаю', 'за рулем', 'я на работе', 'на совещании', 'уже заказал', 'уже купил',
  'не интересует', 'я отказыва', 'не буду', 'я решил', 'мы решили', 'уже поставили',
  'в проекте', 'давайте завтра', 'давайте позже'];
const edges = calls.filter(c => {
  const n = D.notalkNormalize(c.transcript_client_text);
  if (D.notalkHit(n, D.NOTALK_MACHINE) || D.notalkHit(n, D.NOTALK_BOT_SMALLTALK)) return false;
  return EDGE_WORDS.some(w => n.indexOf(w) !== -1);
});
const edgesFlagged = edges.filter(c => D.detectNoConversation(c.transcript_client_text, c.transcript_manager_text, c.call_duration_seconds, isMono(c)));
console.log('\n' + '='.repeat(78));
console.log(`ПОГРАНИЧНЫЕ (живые короткие отказы без признаков машины): ${edges.length}`);
console.log(`Ошибочно помечено: ${edgesFlagged.length} ${edgesFlagged.length ? '✗' : '✓ ни одного'}`);
for (const c of edgesFlagged) {
  console.log(`\n  сделка ${c.deal_id} | ${c.call_duration_seconds} сек | причина ${D.detectNoConversation(c.transcript_client_text, c.transcript_manager_text, c.call_duration_seconds).reason}`);
  console.log(`    КЛИЕНТ: ${cut(c.transcript_client_text, 220)}`);
}

// ── выборки ─────────────────────────────────────────────────────────────────
function show(title, rows) {
  console.log('\n' + '='.repeat(78));
  console.log(title);
  console.log('='.repeat(78));
  for (const c of rows) {
    console.log(`\nсделка ${c.deal_id} | ${c.call_duration_seconds} сек | ${c.transcript_status}${c.verdict ? ` | ${c.verdict.reason}${c.verdict.matched ? ` («${c.verdict.matched}»)` : ''}` : ''}`);
    console.log(`  КЛИЕНТ:   ${cut(c.transcript_client_text, 220) || '(пусто)'}`);
    console.log(`  МЕНЕДЖЕР: ${cut(c.transcript_manager_text, 180) || '(пусто)'}`);
  }
}
show(`${SAMPLES} СЛУЧАЙНЫХ ПОМЕЧЕННЫХ`, pick(flagged, SAMPLES, 'flagged'));
show(`${SAMPLES} СЛУЧАЙНЫХ НЕ ПОМЕЧЕННЫХ`, pick(notFlagged.filter(c => c.norm_client), SAMPLES, 'notflagged'));

fs.writeFileSync(path.join(DATA, 'notalk-result.json'), JSON.stringify({
  итого: calls.length, помечено: flagged.length, прирост_к_detectVoicemail: newlyCaught.length,
  по_причине: byReason, из_стоп_листа_Сани: fromSanyList.length,
  помеченные: flagged.map(c => ({ deal_id: c.deal_id, id: c.id, sec: c.call_duration_seconds, reason: c.verdict.reason, matched: c.verdict.matched, rest: c.verdict.rest, client: c.transcript_client_text, manager: c.transcript_manager_text }))
}, null, 2), 'utf8');
console.log(`\nПолный список помеченных: bench/data/notalk-result.json`);
