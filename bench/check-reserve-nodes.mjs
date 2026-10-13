// Сверка резервного распознавания: функции, которые реально стоят в нодах, ведут себя так же,
// как источник prototype/lib/stt-reliability.js. Плюс синтаксис правленых нод и целостность
// INSERT в «Подготовить SQL» (число колонок = числу значений).
//
// Ноды выгружаются сами, по API, а не переносом кода руками.
// Запуск: node bench/check-reserve-nodes.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..').replace(/\\/g, '/');
const env = {};
for (const l of fs.readFileSync(ROOT + '/.env', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const base = (env.N8N_BASE_URL || 'https://bezalv.ru').replace(/\/+$/, '');

const WF = {
  FHdtN0HGjVAbe9Ow: ['stt-route', 'stt-after-speechkit', 'stt-reserve-parse', 'Запустить SpeechKit'],
  GLQ2iuzRaCQZM7QU: ['Собрать итог', 'Транскрибировать все звонки'],
  BhPWB9S6W5dlMUvV: ['Подготовить SQL', 'Обработать 1 сделку'],
};

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ok   ' + n); };
const bad = (n, h) => { fail++; console.log('  FAIL ' + n + (h ? '\n       ' + h : '')); };

// ── выгрузка ──
const kod = {};
for (const [id, names] of Object.entries(WF)) {
  const r = await fetch(`${base}/api/v1/workflows/${id}`, { headers: { 'X-N8N-API-KEY': env.N8N_API_KEY } });
  if (!r.ok) { console.error(`n8n API ${r.status} по ${id}`); process.exit(2); }
  const wf = await r.json();
  for (const nm of names) {
    const node = wf.nodes.find((n) => n.name === nm);
    if (!node) { bad(`нода «${nm}» не найдена в ${id}`); continue; }
    kod[nm] = node.parameters.jsCode || '';
  }
}

console.log('=== Синтаксис правленых нод ===');
for (const [nm, src] of Object.entries(kod)) {
  try { new Function('return (async function(){' + src + '})'); ok(nm); }
  catch (e) { bad(nm, e.message); }
}

// ── поведение функций: нода против источника ──
const lib = fs.readFileSync(ROOT + '/prototype/lib/stt-reliability.js', 'utf8');
const L = new Function(lib + '\nreturn { sttMode, sttBreakerOpen, sttUseReserveFirst, sttReserveAfterFailure,'
  + ' sttReserveFailure, sttEngineLabel, sttReserveRole, sttReserveToTranscript, sttReserveChannels };')();

// Вырезаем функции из кода ноды и зовём их напрямую: так ловится расхождение,
// которое глазами на 10 КБ не увидеть.
// Тело функции от 'function NAME(' до парной закрывающей скобки — по счётчику скобок,
// а не по позиции в файле: обрезка «до первого $(» рвала код посередине.
function teloFunkcii(src, imya) {
  const nachalo = src.indexOf('function ' + imya + '(');
  if (nachalo === -1) return '';
  const pervaya = src.indexOf('{', nachalo);
  if (pervaya === -1) return '';
  let glubina = 0;
  for (let i = pervaya; i < src.length; i++) {
    if (src[i] === '{') glubina++;
    else if (src[i] === '}') {
      glubina--;
      if (glubina === 0) return src.slice(nachalo, i + 1);
    }
  }
  return '';
}

function izNody(nodeName, imena) {
  const src = kod[nodeName];
  if (!src) return null;
  const vozvrat = imena.filter((n) => src.includes('function ' + n + '('));
  if (!vozvrat.length) return null;
  // Однострочные константы, на которые опираются функции (STT_MODE_*, роли по каналам и т. п.).
  const konstanty = (src.match(/^var [A-Z][A-Z0-9_]*\s*=.*;$/gm) || []).join('\n');
  const funkcii = vozvrat.map((n) => teloFunkcii(src, n)).join('\n');
  try {
    return new Function(konstanty + '\n' + funkcii
      + '\nreturn {' + vozvrat.map((n) => n + ':' + n).join(',') + '};')();
  } catch (e) { return null; }
}

console.log('\n=== stt-route: режим и предохранитель ===');
const R = izNody('stt-route', ['sttMode', 'sttBreakerOpen', 'sttUseReserveFirst']);
if (!R) bad('не удалось вырезать функции из stt-route');
else {
  const NOW = Date.parse('2026-10-13T10:00:00.000Z');
  const sluchai = [
    ['auto', null], ['auto', '2026-10-13T10:10:00.000Z'], ['auto', '2026-10-13T09:50:00.000Z'],
    ['speechkit', '2026-10-13T10:10:00.000Z'], ['speechkit', null],
    ['reserve', null], ['reserve', '2026-10-13T09:00:00.000Z'],
    ['', null], ['опечатка', '2026-10-13T10:10:00.000Z'], ['RESERVE', null],
  ];
  let r1 = 0;
  for (const [m, u] of sluchai) {
    if (R.sttUseReserveFirst(m, u, NOW) !== L.sttUseReserveFirst(m, u, NOW)) r1++;
  }
  r1 ? bad('решение «сразу в резерв» расходится с источником', r1 + ' случаев из ' + sluchai.length)
     : ok('решение «сразу в резерв» совпадает на ' + sluchai.length + ' случаях');
  const rezhimy = ['auto', 'speechkit', 'reserve', '', 'RESERVE', ' speechkit ', 'мусор'];
  const r2 = rezhimy.filter((m) => R.sttMode(m) !== L.sttMode(m)).length;
  r2 ? bad('разбор режима расходится') : ok('разбор режима совпадает на ' + rezhimy.length + ' значениях');
  // Константа переключателя — в этой ноде, как требует Д6
  const mMode = kod['stt-route'].match(/var STT_MODE = '([^']*)'/);
  mMode ? ok('STT_MODE задан в ноде: ' + mMode[1]) : bad('STT_MODE в ноде не найден');
  if (mMode && !['auto', 'speechkit', 'reserve'].includes(mMode[1])) bad('STT_MODE вне допустимых значений: ' + mMode[1]);
}

console.log('\n=== stt-after-speechkit: уходить ли в резерв ===');
const A = izNody('stt-after-speechkit', ['sttMode', 'sttReserveAfterFailure']);
if (!A) bad('не удалось вырезать функции из stt-after-speechkit');
else {
  const sluchai = [
    ['auto', { success: false, retryable: true }],
    ['auto', { success: true, formatted_dialog: 'Менеджер: да' }],
    ['auto', { success: true, formatted_dialog: '' }],
    ['auto', { success: false, retryable: false, channels_mismatch: true }],
    ['auto', { success: false, retryable: true, download_failed: true }],
    ['auto', { success: false, retryable: false }],
    ['speechkit', { success: false, retryable: true }],
    ['reserve', { success: false, retryable: true }],
    ['auto', {}],
  ];
  const r = sluchai.filter(([m, x]) => A.sttReserveAfterFailure(m, x) !== L.sttReserveAfterFailure(m, x)).length;
  r ? bad('решение о резерве после сбоя расходится', r + ' случаев')
    : ok('решение о резерве после сбоя совпадает на ' + sluchai.length + ' случаях');
}

console.log('\n=== stt-reserve-parse: разбор ответа и сборка ===');
const P = izNody('stt-reserve-parse', ['sttReserveChannels', 'sttReserveFailure', 'sttEngineLabel', 'sttReserveRole', 'sttReserveToTranscript']);
if (!P) bad('не удалось вырезать функции из stt-reserve-parse');
else {
  const META = { activity_id: '1', comm_index: 0, channel_count: 2 };
  const META1 = { activity_id: '1', comm_index: 0, channel_count: 1 };
  const otvety = [
    [200, { ok: true, segments: [] }, META],
    [502, { ok: false, error: { code: 'provider_error', message: 'Polza 503', retryable: true } }, META],
    [422, { ok: false, error: { code: 'bad_audio', message: 'mono', retryable: false } }, META],
    [422, { ok: false, error: { code: 'bad_audio', message: 'нет дорожки', retryable: false } }, META1],
    [401, { ok: false, error: { code: 'unauthorized', message: 'нет ключа', retryable: false } }, META],
    [503, { ok: false, error: { code: 'overloaded', message: 'очередь', retryable: true } }, META],
    [0, null, META], [400, null, META], [429, null, META],
  ];
  const r = otvety.filter(([s, b, m]) =>
    JSON.stringify(P.sttReserveFailure(s, b, m)) !== JSON.stringify(L.sttReserveFailure(s, b, m))).length;
  r ? bad('разбор ошибок сервиса расходится', r + ' ответов') : ok('разбор ошибок совпадает на ' + otvety.length + ' ответах');

  const modeli = ['ai-sage/gigaam-v3', 'aiesa/transcribe', 'aiesa/transcribe-fast', '', null, 'openai/whisper-large-v3'];
  const rm = modeli.filter((m) => P.sttEngineLabel(m) !== L.sttEngineLabel(m)).length;
  rm ? bad('пометка движка расходится') : ok('пометка движка совпадает на ' + modeli.length + ' моделях');

  const rr = [0, 1, '0', '1', 2].filter((c) => P.sttReserveRole(c) !== L.sttReserveRole(c)).length;
  rr ? bad('роли по каналам расходятся') : ok('роли по каналам совпадают');

  const tela = [
    [{ ok: true, model: 'ai-sage/gigaam-v3', channels: 2, request_id: 'r1', segments: [
      { channel: 0, start: 0.4, end: 3, text: 'Здравствуйте' },
      { channel: 1, start: 3.4, end: 5, text: 'Слушаю' },
      { channel: 0, start: 5.2, end: 7, text: 'по замеру' },
      { channel: 0, start: 7.1, end: 9, text: 'удобно' }] }, { channel_count: 2, call_date: 'd', call_direction: 'outgoing' }],
    [{ ok: true, model: 'ai-sage/gigaam-v3', channels: 1, segments: [{ channel: 0, start: 1, end: 2, text: 'Алло да' }] }, { channel_count: 1, speaker_role: 'Говорящий' }],
    [{ ok: true, model: 'ai-sage/gigaam-v3', channels: 1, segments: [{ channel: 0, start: 1, end: 2, text: 'Один канал' }] }, { channel_count: 2 }],
    [{ ok: true, model: 'aiesa/transcribe', channels: 2, segments: [] }, { channel_count: 2 }],
    [{ ok: true, model: 'ai-sage/gigaam-v3', channels: 1, segments: [{ channel: 0, start: 1, end: 2, text: 'Голосовое' }] }, { channel_count: 1, speaker_role: 'Клиент' }],
  ];
  const rt = tela.filter(([b, m]) =>
    JSON.stringify(P.sttReserveToTranscript(b, m)) !== JSON.stringify(L.sttReserveToTranscript(b, m))).length;
  rt ? bad('сборка транскрипта расходится с источником', rt + ' тел ответа')
     : ok('сборка транскрипта совпадает на ' + tela.length + ' телах ответа');
}

console.log('\n=== Пометка движка доходит до базы (Д5) ===');
const itog = kod['Собрать итог'] || '';
itog.includes("comm.transcript_engine = match.transcript_engine || 'speechkit'")
  ? ok('«Собрать итог» переносит пометку на звонок')
  : bad('«Собрать итог» не переносит transcript_engine');
itog.includes('calls_by_reserve') ? ok('в статистике есть счётчик резерва') : bad('нет счётчика calls_by_reserve');

const sql = kod['Подготовить SQL'] || '';
sql.includes('transcript_engine, chat_channel') ? ok('колонка transcript_engine в списке INSERT') : bad('колонки transcript_engine нет в INSERT');
sql.includes('escOrNull(c.transcript_engine)') ? ok('значение transcript_engine в VALUES') : bad('значения transcript_engine нет в VALUES');
sql.includes('transcript_engine=COALESCE(EXCLUDED.transcript_engine') ? ok('обновление пометки через COALESCE') : bad('нет обновления transcript_engine в DO UPDATE SET');

// Целостность INSERT: число колонок должно равняться числу значений.
// Иначе Postgres упадёт уже в проде, на живой сделке.
const mKol = sql.match(/INSERT INTO lost_deal_communications \(([^)]+)\) VALUES \(/);
if (!mKol) bad('не нашёл INSERT в lost_deal_communications');
else {
  const kolonki = mKol[1].split(',').map((s) => s.trim()).filter(Boolean);
  // Значения собираются конкатенацией: считаем разделители ", " в выражении после VALUES.
  const nachalo = sql.indexOf(mKol[0]) + mKol[0].length;
  const konec = sql.indexOf('") ON CONFLICT', nachalo);
  const vyrazhenie = sql.slice(nachalo, konec === -1 ? nachalo + 4000 : konec);
  const razdeliteli = (vyrazhenie.match(/",\s"/g) || []).length;
  const znacheniy = razdeliteli + 1;
  kolonki.length === znacheniy
    ? ok(`колонок ${kolonki.length} = значений ${znacheniy}`)
    : bad('INSERT рассогласован', `колонок ${kolonki.length}, значений ${znacheniy} — Postgres упадёт на живой сделке`);
}

console.log('\n=== Таймауты под резерв (Д4) ===');
const tr = kod['Транскрибировать все звонки'] || '';
const t600 = (tr.match(/timeout: 600000/g) || []).length;
const t900 = (tr.match(/timeout: 900000/g) || []).length;
t600 === 0 && t900 === 2 ? ok('вызовы транскрипции звонков: 900 000 мс (оба прохода)')
  : bad('таймауты звонков не те', `600000 встречается ${t600} раз, 900000 — ${t900}`);
const ob = kod['Обработать 1 сделку'] || '';
ob.includes('channel_count: 1, speaker_role') && ob.includes('timeout: 900000')
  ? ok('вызов транскрипции голосовых: 900 000 мс')
  : bad('таймаут голосовых не поднят');
const rc = kod['stt-reserve-parse'] ? true : false;
rc ? ok('нода разбора резерва на месте') : bad('ноды stt-reserve-parse нет');

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
