// Переключение воркфлоу между Opus и Sol. Обратимо: --rollback возвращает Opus.
//
// Скрипт НЕ ходит в n8n сам (у стенда нет ключа n8n API). Он собирает набор патчей
// find/replace, проверяет их на локальных копиях нод и печатает готовые операции для
// n8n_update_partial_workflow. Применяет их Claude через MCP, по одной ноде за вызов.
//
// Запуск:
//   node bench/switch-model.mjs                 план переключения на Sol
//   node bench/switch-model.mjs --rollback      план возврата на Opus
//   node bench/switch-model.mjs --json          выгрузить операции в bench/data/switch-ops.json
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BENCH = path.join(ROOT, 'bench');
const BACKUP = path.join(ROOT, 'tmp', 'backup', 'GLQ2iuzRaCQZM7QU');
const rollback = process.argv.includes('--rollback');
const toJson = process.argv.includes('--json');

const WF_ANALYSIS = 'GLQ2iuzRaCQZM7QU';
const WF_BATCH = 'BhPWB9S6W5dlMUvV';

const OPUS = 'anthropic/claude-opus-4.7';
const SOL = 'openai/gpt-6-sol';
const schema = JSON.parse(fs.readFileSync(path.join(BENCH, 'schema.judge.json'), 'utf8'));
const solPatches = JSON.parse(fs.readFileSync(path.join(ROOT, 'prototype', 'prompts', 'models', 'gpt-6-sol', 'patches.json'), 'utf8'))
  .filter(p => p.enabled !== false);

// Параметры Sol — из документа «Переход Отказов на GPT-6 Sol — опыт СПИН»:
// flex первым, иначе Polza шлёт обычному openai в 2,1–2,5 раза дороже; запасной оставлен,
// чтобы разбор не падал; reasoning низкий (верхнеуровневый Polza игнорирует); max_tokens 16000,
// потому что рассуждения съедают часть лимита, а обрезанный JSON не разберётся;
// strict-схема только у судьи, у писателя текст. Таймаут нод остаётся 180 с: сделка идёт 9–45 с.
const PROVIDER = `provider: { order: ['openai/flex', 'openai'], allow_fallbacks: true }`;
const REASONING = `reasoning: { effort: 'low' }`;

const judgeBodyOpus = `var judge_request_body = {
  model: JUDGE_MODEL,
  messages: [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(facts_packet, null, 2) }
  ],
  max_tokens: 4000,
  temperature: 0
};`;

const judgeBodySol = `var JUDGE_SCHEMA = ${JSON.stringify(schema, null, 2).split('\n').join('\n')};

var judge_request_body = {
  model: JUDGE_MODEL,
  messages: [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(facts_packet, null, 2) }
  ],
  ${PROVIDER},
  ${REASONING},
  max_tokens: 16000,
  temperature: 0,
  response_format: { type: 'json_schema', json_schema: JUDGE_SCHEMA }
};`;

const writerBodyOpus = `var writer_request_body = {
  model: WRITER_MODEL,
  messages: [
    { role: 'system', content: WRITER_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(writer_input, null, 2) }
  ],
  max_tokens: 2500,
  temperature: 0.2
};`;

const writerBodySol = `var writer_request_body = {
  model: WRITER_MODEL,
  messages: [
    { role: 'system', content: WRITER_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(writer_input, null, 2) }
  ],
  ${PROVIDER},
  ${REASONING},
  max_tokens: 16000,
  temperature: 0.2
};`;

// Пары «как на Opus» → «как на Sol». При --rollback меняются местами.
const PAIRS = [
  { wf: WF_ANALYSIS, node: 'agent-facts-assembler', field: 'parameters.jsCode',
    what: 'модель судьи',
    opus: `var JUDGE_MODEL = '${OPUS}';`, sol: `var JUDGE_MODEL = '${SOL}';` },
  { wf: WF_ANALYSIS, node: 'agent-facts-assembler', field: 'parameters.jsCode',
    what: 'тело запроса судьи: провайдер, рассуждения, лимит, strict-схема',
    opus: judgeBodyOpus, sol: judgeBodySol },
  { wf: WF_ANALYSIS, node: 'agent-judge-parse', field: 'parameters.jsCode',
    what: 'модель писателя',
    opus: `var WRITER_MODEL = '${OPUS}';`, sol: `var WRITER_MODEL = '${SOL}';` },
  { wf: WF_ANALYSIS, node: 'agent-judge-parse', field: 'parameters.jsCode',
    what: 'тело запроса писателя: провайдер, рассуждения, лимит',
    opus: writerBodyOpus, sol: writerBodySol },
  { wf: WF_ANALYSIS, node: 'agent-judge-parse', field: 'parameters.jsCode',
    what: 'запасное имя модели судьи (писалось в базу при пустом ответе)',
    opus: `judge_model: input.model || WRITER_MODEL,`, sol: `judge_model: input.model || JUDGE_MODEL_FALLBACK,` },
  { wf: WF_ANALYSIS, node: 'agent-judge-parse', field: 'parameters.jsCode',
    what: 'объявление запасного имени модели судьи',
    opus: `var WRITER_SYSTEM_PROMPT = $('Set: Writer System Prompt').item.json.content;`,
    sol: `var WRITER_SYSTEM_PROMPT = $('Set: Writer System Prompt').item.json.content;\n// Запасное имя на случай пустого поля model в ответе Polza: раньше тут стояла модель писателя,\n// из-за чего в базу уходила не та модель судьи.\nvar JUDGE_MODEL_FALLBACK = '${SOL}';` },
  { wf: WF_ANALYSIS, node: 'agent-writer-parse', field: 'parameters.jsCode',
    what: 'запасное имя модели писателя',
    opus: `writer_model: input.model || '${OPUS}',`, sol: `writer_model: input.model || '${SOL}',` },
  { wf: WF_ANALYSIS, node: 'final-output', field: 'parameters.jsCode',
    what: 'запасное имя модели в llm_meta',
    opus: `model: input.judge_model || '${OPUS}',`, sol: `model: input.judge_model || '${SOL}',` },
  { wf: WF_BATCH, node: 'Подготовить SQL', field: 'parameters.jsCode',
    what: 'метка версии правил в записи в базу',
    opus: `+ (r.processing_time_sec || 0) + ", 'v2.6', "`, sol: `+ (r.processing_time_sec || 0) + ", 'v2.6-sol', "` },
  { wf: WF_BATCH, node: 'Собрать AI-комментарий', field: 'parameters.jsCode',
    what: 'метка версии правил в комментарии для карточки',
    opus: ` | Промпт v2.6'`, sol: ` | Промпт v2.6-sol'` }
];

// Промпт судьи: v2.6 (рабочий, для Opus) ↔ v2.6 + три патча Sol.
for (const p of solPatches) {
  PAIRS.push({
    wf: WF_ANALYSIS, node: 'Set: Judge System Prompt', field: 'parameters.assignments.assignments[0].value',
    what: `промпт судьи, патч ${p.id}`,
    opus: p.find, sol: p.replace
  });
}

// ── сборка операций ─────────────────────────────────────────────────────────
const byNode = new Map();
for (const p of PAIRS) {
  const key = `${p.wf}|${p.node}|${p.field}`;
  if (!byNode.has(key)) byNode.set(key, { wf: p.wf, node: p.node, field: p.field, patches: [] });
  byNode.get(key).patches.push({
    what: p.what,
    find: rollback ? p.sol : p.opus,
    replace: rollback ? p.opus : p.sol
  });
}

const ops = [];
for (const g of byNode.values()) {
  ops.push({
    workflow: g.wf,
    operation: {
      type: 'patchNodeField', nodeName: g.node, fieldPath: g.field,
      patches: g.patches.map(({ find, replace }) => ({ find, replace }))
    },
    описание: g.patches.map(p => p.what)
  });
}

// ── сухой прогон на локальных копиях, где они есть ──────────────────────────
const LOCAL = {
  'agent-judge-parse': path.join(BACKUP, 'agent-judge-parse.js')
};
console.log(rollback ? '=== ВОЗВРАТ НА OPUS ===\n' : '=== ПЕРЕКЛЮЧЕНИЕ НА SOL ===\n');
console.log(`Затронуто нод: ${ops.length}, патчей всего: ${PAIRS.length}\n`);
for (const o of ops) {
  console.log(`${o.workflow}  ${o.operation.nodeName}  (${o.operation.patches.length} патчей)`);
  for (const d of o.описание) console.log(`    - ${d}`);
}

console.log('\n=== Сухой прогон на локальных копиях ===');
if (rollback) {
  console.log('  При возврате на Opus локальная проверка пропускается: копии нод в tmp/backup/ сняты');
  console.log('  до переключения, текста Sol в них ещё нет. find проверит сам n8n — patchNodeField');
  console.log('  падает, если строка не найдена.');
}
let dryChecked = 0;
for (const o of ops) {
  const file = rollback ? null : LOCAL[o.operation.nodeName];
  if (!file || !fs.existsSync(file)) { console.log(`  пропуск  ${o.operation.nodeName} — локальной копии нет, find проверит n8n`); continue; }
  let code = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  // Локальная копия — до патча W1, накладываем его, чтобы совпасть с прод-версией.
  for (const w of JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'b45', 'patches.json'), 'utf8')).filter(x => x.node === 'agent-judge-parse')) {
    if (code.includes(w.find)) code = code.replace(w.find, w.replace);
  }
  for (const p of o.operation.patches) {
    const n = code.split(p.find).length - 1;
    if (n !== 1) { console.log(`  ✗ FAIL   ${o.operation.nodeName}: find встречается ${n} раз — ${p.find.slice(0, 70)}…`); process.exitCode = 1; continue; }
    code = code.replace(p.find, p.replace);
    dryChecked++;
  }
  const leftOpus = (code.match(/claude-opus/g) || []).length;
  console.log(`  ${leftOpus === 0 || rollback ? 'ok    ' : '✗ FAIL'}   ${o.operation.nodeName}: упоминаний Opus после правки — ${leftOpus}${rollback ? ' (при возврате так и должно быть)' : ''}`);
  if (leftOpus !== 0 && !rollback) process.exitCode = 1;
}
console.log(`Проверено патчей на локальных копиях: ${dryChecked}`);

if (toJson) {
  const out = path.join(BENCH, 'data', rollback ? 'switch-ops-rollback.json' : 'switch-ops.json');
  fs.writeFileSync(out, JSON.stringify(ops, null, 2), 'utf8');
  console.log(`\nОперации выгружены: ${path.relative(ROOT, out)}`);
}
