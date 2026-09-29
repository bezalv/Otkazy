// Выжимка по сделкам, где вердикты разошлись: факты + обоснования обеих моделей.
// Телефоны маскируются — выжимка попадает в отчёт.
// Запуск: node bench/mismatch-brief.mjs [--model sol]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'bench', 'data');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const modelKey = arg('model', 'sol');
const TAG = arg('tag', modelKey);

const mism = JSON.parse(fs.readFileSync(path.join(DATA, `mismatch.${TAG}.json`), 'utf8'));
const mask = (s) => String(s || '').replace(/(\+?7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g, '[телефон]');
const cut = (s, n) => { s = mask(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const day = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : '?');

for (const m of mism) {
  const p = JSON.parse(fs.readFileSync(path.join(DATA, 'inputs', `${m.deal_id}.json`), 'utf8'));
  const mt = p.metrics || {};
  console.log('\n' + '='.repeat(78));
  console.log(`СДЕЛКА ${m.deal_id}   сумма ${p.deal_card?.opportunity ?? '?'} ₽   стадия «${p.deal_card?.stage_name ?? '?'}»`);
  console.log(`отсечка ${day(mt.cutoff_at)} (${mt.cutoff_source})   в воронке ${mt.days_in_funnel_until_lose} дн   фактов ${p.facts.length}`);
  console.log(`звонки: всего ${mt.calls_total}, содержательных ${mt.calls_meaningful}, без ответа исходящих ${mt.calls_unanswered_outgoing}, пропущено входящих ${mt.calls_missed_incoming}`);
  console.log(`чаты: клиент ${mt.chats_client}, менеджер ${mt.chats_manager}; последнее от клиента за ${mt.chats_last_client_days_before_lose} дн до отказа, от менеджера за ${mt.chats_last_manager_days_before_lose} дн`);
  console.log(`последний контакт за ${mt.last_contact_days_before_lose} дн до отказа; макс. разрыв ${mt.max_gap_days} дн (${mt.max_gap_who}); тренд ${mt.trend}`);

  const clientFacts = p.facts.filter(f => f.actor === 'client' && ['call_transcript', 'chat', 'chat_voice_transcript', 'screenshot_chat'].includes(f.source));
  const totalClientChars = clientFacts.reduce((s, f) => s + (f.content || '').length, 0);
  console.log(`\nклиентских реплик ${clientFacts.length}, суммарно ${totalClientChars} символов (порог «недостаточно данных» — 500)`);
  for (const f of clientFacts) console.log(`  [${day(f.ts)} ${f.source}] ${cut(f.content, 300)}`);

  const mgrFacts = p.facts.filter(f => f.actor === 'manager' && ['call_transcript', 'chat', 'screenshot_chat'].includes(f.source));
  if (mgrFacts.length) {
    console.log(`\nреплики менеджера клиенту (${mgrFacts.length}):`);
    for (const f of mgrFacts.slice(0, 6)) console.log(`  [${day(f.ts)} ${f.source}] ${cut(f.content, 220)}`);
  }
  const comments = p.facts.filter(f => f.source === 'crm_comment');
  if (comments.length) {
    console.log(`\nкомментарии менеджера в CRM (${comments.length}) — это НЕ слова клиента:`);
    for (const f of comments) console.log(`  [${day(f.ts)}] ${cut(f.content, 200)}`);
  }
  const events = p.facts.filter(f => f.source === 'call_event');
  if (events.length) {
    console.log(`\nзвонки без транскрипта (${events.length}):`);
    for (const f of events.slice(0, 8)) console.log(`  [${day(f.ts)}] ${cut(f.content, 160)}`);
  }

  console.log(`\n── OPUS: ${m.opus.verdict} / ${m.opus.class} («${m.opus.reason_short}»)`);
  console.log(`   ${cut(m.opus.exact, 500)}`);
  console.log(`   ошибки (${m.opus.mistakes.length}):`);
  for (const x of m.opus.mistakes) console.log(`     - ${cut(x, 200)}`);

  console.log(`\n── ${modelKey.toUpperCase()}: ${m.sol.verdict} / ${m.sol.class} («${m.sol.reason_short}»)`);
  console.log(`   ${cut(m.sol.exact, 500)}`);
  console.log(`   ошибки (${m.sol.mistakes.length}):`);
  for (const x of m.sol.mistakes) console.log(`     - ${cut(x, 200)}`);
}
