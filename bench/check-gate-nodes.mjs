// Сверка: функции полноты данных, которые стоят в нодах, ведут себя так же,
// как источник prototype/lib/pipeline-gate.js. Плюс синтаксис всех правленых нод шага Б.
//
// Порядок: сначала выгрузить ноды в tmp/backup/shagB/posle/, потом сверить.
//   node bench/dump-node.mjs --wf GLQ2iuzRaCQZM7QU --node "pipeline-gate" --out tmp/backup/shagB/posle/gate.js
//   (так же: gate-out.js, facts.js, transcribe.js из GLQ2iuzRaCQZM7QU;
//    obrabotat.js, params.js, poluchit.js из BhPWB9S6W5dlMUvV; nightly.js из dqwzTtYN5MqQxx6V)
//   node bench/check-gate-nodes.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const D = path.join(ROOT, 'tmp', 'backup', 'shagB', 'posle');

const body = (f) => { const t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); return t.slice(t.indexOf('\n\n') + 2); };

let bad = 0;
console.log('=== Синтаксис нод ===');
for (const f of fs.readdirSync(D).filter(n => n.endsWith('.js'))) {
  try { new Function('return (async function(){' + body(path.join(D, f)) + '})'); console.log(`  ok   ${f}`); }
  catch (e) { bad++; console.log(`  FAIL ${f}: ${e.message}`); }
}

// Вырезаем объявления по имени — так сравниваем именно то, что исполняет n8n.
// Блок берём от начала объявления до парной закрывающей скобки.
function cutDecl(t, head, file, name, pairs) {
  const m = t.match(head);
  if (!m) throw new Error(`нет ${name} в ${file}`);
  const i = t.indexOf(m[0]);
  const open = pairs === 'braces' ? ['{'] : ['{', '['];
  const close = pairs === 'braces' ? ['}'] : ['}', ']'];
  let depth = 0, j = i, started = false;
  for (; j < t.length; j++) {
    const ch = t[j];
    if (open.indexOf(ch) !== -1) { depth++; started = true; }
    else if (close.indexOf(ch) !== -1) { depth--; if (started && depth === 0) { j++; break; } }
  }
  return t.slice(i, j);
}

function pick(file, names, consts) {
  const t = file.endsWith('pipeline-gate.js') ? fs.readFileSync(file, 'utf8') : body(file);
  const parts = [];
  for (const c of consts || []) parts.push(cutDecl(t, new RegExp('var\\s+' + c + '\\s*='), file, c, 'any') + ';');
  for (const n of names) parts.push(cutDecl(t, new RegExp('function\\s+' + n + '\\s*\\('), file, n, 'braces'));
  const src = parts.join('\n');
  return new Function(src + '\nreturn {' + names.map(n => n + ':' + n).join(',') + '};')();
}

const names = ['pgVoiceUnsupported', 'pgIsRecognitionFailure', 'pgIncompleteSources'];
const consts = ['PG_SOURCES', 'PG_VOICE_UNSUPPORTED'];
const LIB = pick(path.join(ROOT, 'prototype', 'lib', 'pipeline-gate.js'), names, consts);
const GATE = pick(path.join(D, 'gate.js'), names, consts);

const same = (what, a, b) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) { bad++; console.log(`  FAIL ${what}: нода ${JSON.stringify(a)} / библиотека ${JSON.stringify(b)}`); }
};
console.log('\n=== Поведение против библиотеки ===');
const items = [
  { retryable: true }, { retryable: false }, { retryable: true, unsupported: true },
  { retryable: true, file_name: 'a.m4a' }, { retryable: true, file_name: 'a.WAV' },
  { retryable: true, file_name: 'a.ogg' }, {}, { retryable: true, channels_mismatch: true },
  { retryable: false, file_name: 'a.m4a' }
];
items.forEach((it, i) => same(`isRecognitionFailure[${i}]`, GATE.pgIsRecognitionFailure(it), LIB.pgIsRecognitionFailure(it)));
['a.m4a', 'a.WAV', 'a.ogg', 'x', 'a.mp3', ''].forEach((f, i) => same(`voiceUnsupported[${i}]`, GATE.pgVoiceUnsupported(f), LIB.pgVoiceUnsupported(f)));

// Карта отметок: библиотека отдаёт ключи, нода — русские названия, поэтому сравниваем длину.
const marks = [
  {}, null,
  { calls: { complete: true }, openlines: { complete: true }, comments: { complete: true }, tasks: { complete: true } },
  { calls: { complete: true }, openlines: { complete: false }, comments: { complete: true }, tasks: { complete: true } }
];
marks.forEach((m, i) => same(`incompleteSources.length[${i}]`, GATE.pgIncompleteSources(m).length, LIB.pgIncompleteSources(m).length));

console.log(bad === 0 ? '\nвсе ноды: синтаксис ок, поведение совпадает с библиотекой' : `\nпроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
