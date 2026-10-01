// Сверка: функции надёжности, которые реально стоят в нодах, ведут себя так же,
// как источник prototype/lib/stt-reliability.js. Плюс проверка синтаксиса всех правленых нод.
//
// Функции вставлены в ноды по частям — каждой ноде только то, что ей нужно, — поэтому
// единой сборки .node.js здесь нет, и расхождение ловится этой сверкой.
//
// Порядок: сначала выгрузить ноды, потом сверить.
//   node bench/dump-node.mjs --wf FHdtN0HGjVAbe9Ow --node "Парсинг транскрипта" --out tmp/backup/FHdtN0HGjVAbe9Ow/posle/parsing.js
//   (так же retry.js, speechkit.js, poll-state.js, timeout.js; из GLQ2iuzRaCQZM7QU —
//    transcribe-all.js и config-filter.js в tmp/backup/GLQ2iuzRaCQZM7QU/posle-stt/)
//   node bench/check-stt-nodes.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..').replace(/\\/g, '/');
const T = ROOT + '/tmp/backup/FHdtN0HGjVAbe9Ow/posle';
const G = ROOT + '/tmp/backup/GLQ2iuzRaCQZM7QU/posle-stt';

const read = (f) => fs.readFileSync(f, 'utf8');
const body = (f) => { const t = read(f).replace(/\r\n/g, '\n'); return t.slice(t.indexOf('\n\n') + 2); };

// ── синтаксис: ноды оборачиваются n8n в async-функцию, поэтому так и проверяем ──
const files = {
  'Парсинг транскрипта': T + '/parsing.js',
  'Повторить или таймаут': T + '/retry.js',
  'Запустить SpeechKit': T + '/speechkit.js',
  'stt-poll-state': T + '/poll-state.js',
  'stt-timeout': T + '/timeout.js',
  'stt-download-valid': T + '/download-valid.js',
  'stt-download-failed': T + '/download-failed.js',
  'Транскрибировать все звонки': G + '/transcribe-all.js',
  'Config + Фильтр звонков': G + '/config-filter.js'
};
let bad = 0;
console.log('=== Синтаксис нод ===');
for (const [name, f] of Object.entries(files)) {
  try { new Function('return (async function(){' + body(f) + '})'); console.log(`  ok   ${name}`); }
  catch (e) { bad++; console.log(`  FAIL ${name}: ${e.message}`); }
}

// ── поведение функций из нод против библиотеки ──
const libNames = ['sttTransient', 'sttChannelsMismatch', 'sttErrorText', 'sttMergePollState', 'sttNeedsMonoFallback', 'sttDownloadFailure'];
const LIB = new Function(read(ROOT + '/prototype/lib/stt-reliability.js') +
  '\nreturn {' + libNames.map(n => n + ':' + n).join(',') + '};')();

// Из ноды вырезаем только объявления функций (до строки, где начинается работа с $-контекстом).
function pick(file, names) {
  const t = body(file);
  const src = names.map(n => {
    const re = new RegExp('(?:async )?function ' + n + '\\s*\\([^)]*\\)\\s*\\{');
    const m = t.match(re);
    if (!m) throw new Error(`в ${file} нет функции ${n}`);
    let i = t.indexOf(m[0]), depth = 0, j = i;
    for (; j < t.length; j++) {
      if (t[j] === '{') depth++;
      else if (t[j] === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    return t.slice(i, j);
  }).join('\n');
  return new Function(src + '\nreturn {' + names.map(n => n + ':' + n).join(',') + '};')();
}

const POLL = pick(T + '/poll-state.js', ['sttTransient', 'sttErrorText', 'sttMergePollState']);
const PARSE = pick(T + '/parsing.js', ['sttChannelsMismatch']);
const SPEECH = pick(T + '/speechkit.js', ['sttTransient']);
const TRANS = pick(G + '/transcribe-all.js', ['sttChannelsMismatch', 'sttNeedsMonoFallback']);
const DL = pick(T + '/download-valid.js', ['sttDownloadFailure']);

const msgs = ['503 Service Unavailable', '500 err', 'ETIMEDOUT', 'socket hang up', 'ECONNRESET',
  '400 Bad Request', 'Audio has 1 channels, but 2 requested in specification',
  'Audio has 1 channels, but 2 requested', 'Audio has 1 channel, but 2 requested',
  'код 1500 ошибка', 'invalid key', 'audio channels decoded', ''];

const same = (what, a, b) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) { bad++; console.log(`  FAIL ${what}: нода ${JSON.stringify(a)} / библиотека ${JSON.stringify(b)}`); }
};
console.log('\n=== Поведение против библиотеки ===');
for (const m of msgs) {
  same(`poll-state.sttTransient(${JSON.stringify(m)})`, POLL.sttTransient(m), LIB.sttTransient(m));
  same(`speechkit.sttTransient(${JSON.stringify(m)})`, SPEECH.sttTransient(m), LIB.sttTransient(m));
  same(`parsing.sttChannelsMismatch(${JSON.stringify(m)})`, PARSE.sttChannelsMismatch(m), LIB.sttChannelsMismatch(m));
  same(`transcribe.sttChannelsMismatch(${JSON.stringify(m)})`, TRANS.sttChannelsMismatch(m), LIB.sttChannelsMismatch(m));
}
const states = [{ attempt: 7, poll_transient: 0, operation_id: 'op1' }, { attempt: 1 }, {}];
const polls = [{ error: { message: '502' } }, { error: { message: 'ETIMEDOUT' } },
  { done: true, response: { chunks: [] } }, { done: true, error: { message: 'Audio has 1 channels, but 2 requested' } }, {}];
for (const s of states) for (const p of polls) {
  same('mergePollState', POLL.sttMergePollState(s, p), LIB.sttMergePollState(s, p));
}
const subs = [{ success: true, formatted_dialog: '' }, { success: true, formatted_dialog: 'Менеджер: да' },
  { success: false, error: 'Audio has 1 channels, but 2 requested' }, { success: false, error: '503 upstream' },
  { success: false, channels_mismatch: true, error: 'x' }, {}, null];
for (const s of subs) for (const ch of [1, 2]) {
  same(`needsMono(${JSON.stringify(s)},${ch})`, TRANS.sttNeedsMonoFallback(s, ch), LIB.sttNeedsMonoFallback(s, ch));
}

console.log(bad === 0 ? '\nвсе ноды: синтаксис ок, поведение совпадает с библиотекой' : `\nпроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
