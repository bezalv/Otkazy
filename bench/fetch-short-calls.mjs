// Выгрузка коротких транскрибированных звонков для проверки детектора «разговора не было».
// Пишет в bench/data/short-calls.json — вне git, там реплики клиентов.
// Запуск: node bench/fetch-short-calls.mjs [--max-sec 20]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'bench', 'data');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const MAX_SEC = Number(arg('max-sec', 20));

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

const COLS = ['id', 'deal_id', 'event_id', 'event_date', 'direction', 'call_duration_seconds',
  'transcript_status', 'transcript_manager_text', 'transcript_client_text', 'transcript_replicas', 'transcript_formatted',
  'call_subject'].join(',');

// Берём и transcribed, и voicemail: второе нужно, чтобы сверить детектор с тем,
// что уже ловит detectVoicemail в agent-facts-assembler.
const all = [];
for (const status of ['transcribed', 'voicemail']) {
  let from = 0;
  for (;;) {
    const url = `${E.SUPABASE_URL}/rest/v1/lost_deal_communications` +
      `?event_type=eq.call&transcript_status=eq.${status}` +
      `&call_duration_seconds=lte.${MAX_SEC}&select=${COLS}&order=id.asc&limit=1000&offset=${from}`;
    const r = await fetch(url, { headers: H });
    if (!r.ok) { console.error(`REST ${r.status}: ${(await r.text()).slice(0, 300)}`); process.exit(1); }
    const batch = await r.json();
    all.push(...batch);
    if (batch.length < 1000) break;
    from += 1000;
  }
}

all.sort((a, b) => a.id - b.id);
fs.writeFileSync(path.join(DATA, 'short-calls.json'), JSON.stringify(all, null, 2), 'utf8');

const byStatus = {};
for (const c of all) byStatus[c.transcript_status] = (byStatus[c.transcript_status] || 0) + 1;
const deals = new Set(all.map(c => c.deal_id));
const mgrSilent = all.filter(c => (c.transcript_manager_text || '').trim().length < 20).length;

console.log(`Звонков ≤${MAX_SEC} сек выгружено: ${all.length}, сделок: ${deals.size}`);
console.log('По статусу:', byStatus);
console.log(`Менеджер почти ничего не сказал (<20 символов): ${mgrSilent}`);
console.log(`Файл: bench/data/short-calls.json`);
