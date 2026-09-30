// Прогон детектора на длительности в том виде, в каком она приходит в проде ПОСЛЕ правки:
// поля duration_seconds в потоке нет, длительность считается из duration_start и duration_end.
//
// Проверяет две вещи:
// 1. цифры на коротких звонках не разъехались с прежним прогоном (было 941 помеченных);
// 2. ни один звонок длиннее NOTALK_MAX_SEC не помечен — до правки они попадали в ветку
//    «нулевая длительность» и метились по длине транскрипта.
//
// Запуск: node bench/test-notalk-prod-duration.mjs
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
const H = { apikey: E.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${E.SUPABASE_PUBLISHABLE_KEY}` };

// Выгружаем ВСЕ транскрибированные звонки, а не только короткие.
const CACHE = path.join(DATA, 'all-calls.json');
let calls;
if (fs.existsSync(CACHE) && !process.argv.includes('--refresh')) {
  calls = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  console.log(`Взято из кэша: ${calls.length} звонков (--refresh чтобы перевыгрузить)`);
} else {
  const COLS = ['id', 'deal_id', 'call_duration_seconds', 'call_duration_start', 'call_duration_end',
    'transcript_status', 'transcript_manager_text', 'transcript_client_text', 'transcript_formatted'].join(',');
  calls = [];
  for (const status of ['transcribed', 'voicemail']) {
    let from = 0;
    for (;;) {
      const url = `${E.SUPABASE_URL}/rest/v1/lost_deal_communications?event_type=eq.call` +
        `&transcript_status=eq.${status}&select=${COLS}&order=id.asc&limit=1000&offset=${from}`;
      const r = await fetch(url, { headers: H });
      if (!r.ok) { console.error(`REST ${r.status}: ${(await r.text()).slice(0, 300)}`); process.exit(1); }
      const batch = await r.json();
      calls.push(...batch);
      if (batch.length < 1000) break;
      from += 1000;
    }
  }
  fs.writeFileSync(CACHE, JSON.stringify(calls, null, 2), 'utf8');
  console.log(`Выгружено: ${calls.length} звонков`);
}

const src = fs.readFileSync(path.join(ROOT, 'prototype', 'lib', 'no-conversation.js'), 'utf8');
const D = new Function(src + '\nreturn { detectNoConversation: detectNoConversation, NOTALK_MAX_SEC: NOTALK_MAX_SEC };')();

// Ровно тот расчёт, что теперь стоит в сборщике фактов и в b4.5.
function prodDuration(c) {
  if (c.call_duration_seconds && c.call_duration_seconds > 0) return c.call_duration_seconds;
  if (c.call_duration_start && c.call_duration_end) {
    const s = new Date(c.call_duration_start).getTime();
    const e = new Date(c.call_duration_end).getTime();
    if (!isNaN(s) && !isNaN(e) && e > s) return Math.round((e - s) / 1000);
  }
  return 0;
}
const isMono = (c) => ((c.transcript_formatted || '').indexOf('Говорящий') !== -1);
const cut = (s, n) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// ── сверка: расходится ли поле duration_seconds с расчётом из start/end ─────
let mismatch = 0, noSeconds = 0;
for (const c of calls) {
  const fromField = c.call_duration_seconds;
  const fromRange = (c.call_duration_start && c.call_duration_end)
    ? Math.round((new Date(c.call_duration_end).getTime() - new Date(c.call_duration_start).getTime()) / 1000) : null;
  if (fromField === null || fromField === undefined) noSeconds++;
  else if (fromRange !== null && Math.abs(fromField - fromRange) > 1) mismatch++;
}
console.log(`\nСверка длительности: поле и расчёт из start/end расходятся больше чем на секунду у ${mismatch} звонков; поля нет у ${noSeconds}`);

// ── прогон ──────────────────────────────────────────────────────────────────
const short = [], long = [];
for (const c of calls) {
  const dur = prodDuration(c);
  const res = D.detectNoConversation(c.transcript_client_text, c.transcript_manager_text, dur, isMono(c));
  const row = { c, dur, res };
  (dur > D.NOTALK_MAX_SEC ? long : short).push(row);
}

const shortFlagged = short.filter(r => r.res);
const longFlagged = long.filter(r => r.res);
const byReason = {};
for (const r of shortFlagged) byReason[r.res.reason] = (byReason[r.res.reason] || 0) + 1;

console.log('\n' + '='.repeat(78));
console.log(`Звонков всего: ${calls.length}`);
console.log(`  ≤${D.NOTALK_MAX_SEC} сек: ${short.length}, помечено ${shortFlagged.length}`);
console.log(`  по причине:`, byReason);
console.log(`  >${D.NOTALK_MAX_SEC} сек: ${long.length}, помечено ${longFlagged.length} ${longFlagged.length ? '✗ ТАК БЫТЬ НЕ ДОЛЖНО' : '✓ ни одного, как и требуется'}`);

// ── те самые 233 звонка: длинные с коротким транскриптом ────────────────────
const risky = long.filter(r => (
  (r.c.transcript_client_text || '').length + (r.c.transcript_manager_text || '').length
) <= 200);
const riskyFlagged = risky.filter(r => r.res);
console.log(`\nДлиннее ${D.NOTALK_MAX_SEC} сек с транскриптом короче 200 символов: ${risky.length}`);
console.log(`  из них помечено: ${riskyFlagged.length} ${riskyFlagged.length ? '✗' : '✓ ни одного'}`);
console.log(`  сделок затронуто: ${new Set(risky.map(r => r.c.deal_id)).size}`);
console.log('\n  примеры (должны быть НЕ помечены):');
for (const r of risky.slice(0, 5)) {
  console.log(`    сделка ${r.c.deal_id} | ${r.dur} сек | помечен: ${r.res ? 'ДА — ОШИБКА' : 'нет ✓'}`);
  console.log(`      К: ${cut(r.c.transcript_client_text, 90) || '(пусто)'}`);
  console.log(`      М: ${cut(r.c.transcript_manager_text, 90) || '(пусто)'}`);
}

if (longFlagged.length) {
  console.log('\n  ОШИБОЧНО ПОМЕЧЕННЫЕ ДЛИННЫЕ:');
  for (const r of longFlagged.slice(0, 10)) {
    console.log(`    сделка ${r.c.deal_id} | ${r.dur} сек | ${r.res.reason}`);
    console.log(`      К: ${cut(r.c.transcript_client_text, 110)}`);
  }
  process.exitCode = 1;
}

// ── сравнение с прежним прогоном по коротким ────────────────────────────────
const prev = path.join(DATA, 'notalk-result.json');
if (fs.existsSync(prev)) {
  const p = JSON.parse(fs.readFileSync(prev, 'utf8'));
  console.log(`\nПрежний прогон (длительность из поля базы): помечено ${p.помечено} из ${p.итого} коротких`);
  console.log(`Сейчас (длительность как в проде): помечено ${shortFlagged.length} из ${short.length} коротких`);
}
