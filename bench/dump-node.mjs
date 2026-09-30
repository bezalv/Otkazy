// Выгрузка кода ноды в файл — из текущего состояния воркфлоу или из сохранённой версии.
// Нужна, чтобы бэкап перед правкой снимался выгрузкой, а не переносом кода руками:
// перенос руками на 12–20 КБ гарантированно вносит искажение.
//
// ТРЕБУЕТ N8N_API_KEY в .env. Ключа там сейчас нет, поэтому скрипт падает с понятным
// сообщением. Взять ключ: n8n → Settings → API → Create an API key.
//
// Запуск:
//   node bench/dump-node.mjs --wf GLQ2iuzRaCQZM7QU --node agent-facts-assembler
//   node bench/dump-node.mjs --wf GLQ2iuzRaCQZM7QU --node "b4.5 Comm Analytics" --out tmp/backup/b45.js
//   node bench/dump-node.mjs --wf GLQ2iuzRaCQZM7QU --all          все Code-ноды сразу
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const flag = (n) => process.argv.includes('--' + n);

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
const KEY = E.N8N_API_KEY;
const BASE = (E.N8N_BASE_URL || 'https://bezalv.ru').replace(/\/+$/, '');

if (!KEY) {
  console.error('Нет N8N_API_KEY в .env — выгрузить ноду файлом нельзя.');
  console.error('Взять ключ: n8n → Settings → API → Create an API key, затем добавить строку');
  console.error('  N8N_API_KEY=...');
  console.error('Пока ключа нет, точкой отката служит версия воркфлоу в n8n плюс обратные патчи.');
  process.exit(2);
}

const wfId = arg('wf');
if (!wfId) { console.error('Укажи --wf <id воркфлоу>'); process.exit(1); }

const r = await fetch(`${BASE}/api/v1/workflows/${wfId}`, { headers: { 'X-N8N-API-KEY': KEY } });
if (!r.ok) { console.error(`n8n API ${r.status}: ${(await r.text()).slice(0, 300)}`); process.exit(1); }
const wf = await r.json();

const stamp = new Date().toISOString().slice(0, 10);
const outDir = path.join(ROOT, 'tmp', 'backup', wfId);
fs.mkdirSync(outDir, { recursive: true });

const slug = (s) => s.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-|-$/g, '');
const targets = flag('all')
  ? wf.nodes.filter(n => n.type === 'n8n-nodes-base.code')
  : wf.nodes.filter(n => n.name === arg('node'));

if (!targets.length) {
  console.error(`Нода не найдена. Есть Code-ноды: ${wf.nodes.filter(n => n.type === 'n8n-nodes-base.code').map(n => n.name).join(', ')}`);
  process.exit(1);
}

for (const node of targets) {
  const code = node.parameters?.jsCode;
  if (typeof code !== 'string') { console.log(`  пропуск ${node.name}: нет jsCode`); continue; }
  const out = arg('out') || path.join(outDir, `${slug(node.name)}-${stamp}.js`);
  const header = `// Выгрузка ноды «${node.name}» из воркфлоу ${wfId} («${wf.name}»)\n`
    + `// Снято ${new Date().toISOString()} через n8n API, не руками.\n`
    + `// Это точка отката: код можно вернуть патчем или сравнить с текущим состоянием.\n\n`;
  fs.writeFileSync(out, header + code, 'utf8');
  console.log(`  ${node.name} → ${path.relative(ROOT, out)} (${code.length} символов)`);
}
