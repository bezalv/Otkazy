// stt-reserve — резервное распознавание звонков и голосовых (Ф7.16, 12.10.2026). Договор — README.md рядом.
// Node 20 без npm. Принимает запись (тело запроса — сам файл), стерео делит на каналы ffmpeg и распознаёт каждый канал в Polza.
// Возвращает отрезки {channel, start, end, text} по времени. Роли (кто менеджер, кто клиент) сервис не знает — решает вызывающий.
// Модель — RESERVE_MODEL:
//   gigaam (по умолчанию, решение Сани 12.10: Aiesa в тот день не отвечала) — `ai-sage/gigaam-v3`, ответ сразу, без меток времени:
//     канал режется на фразы по паузам (ffmpeg silencedetect), каждая фраза — отдельный запрос, время фразы — из нарезки;
//   aiesa — `aiesa/transcribe`, асинхронно (задача → опрос), отрезки с метками времени от модели; короче 5 с — дополняется тишиной.
// Настройки — переменные окружения:
//   STT_KEY (ключ заголовка X-STT-Key), POLZA_API_KEY, STT_BIND (127.0.0.1), STT_PORT (8790), RESERVE_MODEL, MAX_TASKS (3 —
//   одновременных запросов к Polza и процессов нарезки на весь сервис), QUEUE_MAX (20), REQUEST_TIMEOUT_SEC (600), MAX_FILE_MB (50),
//   MAX_AUDIO_SEC (3 ч), WORK_DIR, LOG_FILE, STT_FFMPEG_PATH, STT_FFPROBE_PATH.
//   Тело запроса пишется сразу на диск (WORK_DIR), не в память.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const VERSION = '1.3.0';
const POLZA = 'https://api.polza.ai/api/v1';
const MODELS = { gigaam: 'ai-sage/gigaam-v3', aiesa: 'aiesa/transcribe' };
const E = process.env;
const CFG = {
  key: String(E.STT_KEY || ''), polza: String(E.POLZA_API_KEY || ''), bind: E.STT_BIND || '127.0.0.1', port: Number(E.STT_PORT || 8790),
  model: E.RESERVE_MODEL || 'gigaam', maxTasks: Number(E.MAX_TASKS || 3), queueMax: Number(E.QUEUE_MAX || 20), timeoutSec: Number(E.REQUEST_TIMEOUT_SEC || 600),
  maxBytes: Number(E.MAX_FILE_MB || 50) * 1024 * 1024, work: E.WORK_DIR || E.CACHE_DIRECTORY || path.join(os.tmpdir(), 'otkazy-stt'),
  log: E.LOG_FILE || (E.LOGS_DIRECTORY ? path.join(E.LOGS_DIRECTORY, 'stt-reserve.log') : path.join(os.tmpdir(), 'otkazy-stt', 'stt-reserve.log')),
  ffmpeg: E.STT_FFMPEG_PATH || 'ffmpeg', ffprobe: E.STT_FFPROBE_PATH || 'ffprobe',
  retries: [10, 30, 60], maxAudioSec: Number(E.MAX_AUDIO_SEC || 3 * 3600), maxParts: 1500, bodySec: 120,
  // нарезка по паузам (gigaam): тишина — ниже -40 дБ дольше 0,4 с; фразы ближе 0,3 с склеиваются, короче 0,25 с — отбрасываются,
  // длиннее 25 с — режутся; к краям фразы — по 0,3 с (при -35 дБ и 0,15 с на 5-секундной записи срезалось начало тихой фразы)
  vad: { noise: '-40dB', minSilence: 0.4, joinGap: 0.3, minSpeech: 0.25, maxChunk: 25, edge: 0.3 },
  aiesaMinSec: 5
};
if (!CFG.key || CFG.key.length < 24) { console.error('нет STT_KEY (или короче 24 символов)'); process.exit(2); }
if (!MODELS[CFG.model]) { console.error('RESERVE_MODEL: ' + Object.keys(MODELS).join(' | ')); process.exit(2); }

// ---------- журнал: строка JSON на запрос, больше 5 МБ — остаются последние 2 МБ ----------
function log(obj) {
  try {
    fs.mkdirSync(path.dirname(CFG.log), { recursive: true });
    const st = fs.existsSync(CFG.log) ? fs.statSync(CFG.log) : null;
    if (st && st.size > 5 * 1024 * 1024) { const b = fs.readFileSync(CFG.log); fs.writeFileSync(CFG.log, b.subarray(b.length - 2 * 1024 * 1024)); }
    fs.appendFileSync(CFG.log, JSON.stringify(Object.assign({ at: new Date().toISOString() }, obj)) + '\n');
  } catch (e) { /* журнал не роняет сервис */ }
}

// ---------- ограничение одновременных запросов к Polza (на весь сервис) ----------
let running = 0; const waiting = [];
function acquire() { return new Promise(res => { if (running < CFG.maxTasks) { running++; res(); } else waiting.push(res); }); }
function release() { const next = waiting.shift(); if (next) next(); else running--; }
let inFlight = 0; // принятые запросы (в работе и в очереди)

class HttpError extends Error { constructor(status, code, message, retryable) { super(message); this.status = status; this.code = code; this.retryable = !!retryable; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (cmd, args, timeoutMs) => new Promise((res, rej) => execFile(CFG[cmd] || cmd, args, { timeout: timeoutMs || 120000, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => (err ? rej(Object.assign(new Error(cmd + ': ' + String(errOut || err.message).slice(0, 300)), { stderr: errOut })) : res({ out, err: errOut }))));

async function probe(file) {
  let j;
  try { j = JSON.parse((await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', file])).out); }
  catch (e) { throw new HttpError(422, 'bad_audio', 'файл не читается как аудио', false); }
  const a = (j.streams || []).find(s => s.codec_type === 'audio');
  if (!a) throw new HttpError(422, 'bad_audio', 'в файле нет звуковой дорожки', false);
  return { channels: Number(a.channels) || 1, duration: Math.round(Number((j.format || {}).duration || a.duration || 0) * 100) / 100 };
}
// Дорожка канала: mp3 моно 16 кГц (pad — дополнить тишиной до N с)
async function track(src, dest, filter, padSec) {
  const af = filter + (padSec ? ',apad=whole_dur=' + padSec : '');
  await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-af', af, '-ac', '1', '-ar', '16000', '-b:a', '48k', dest], 180000);
  return dest;
}
// Фразы канала по паузам: [{start, end}] (секунды от начала записи)
async function speechParts(file, duration) {
  const v = CFG.vad;
  const r = await run('ffmpeg', ['-v', 'info', '-nostats', '-i', file, '-af', 'silencedetect=noise=' + v.noise + ':d=' + v.minSilence, '-f', 'null', '-'], 180000);
  const sil = []; let open = null;
  for (const line of String(r.err).split('\n')) {
    const s = line.match(/silence_start: (-?[\d.]+)/); if (s) open = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end: ([\d.]+)/); if (e) { sil.push([open === null ? 0 : open, Number(e[1])]); open = null; }
  }
  if (open !== null) sil.push([open, duration]);
  let parts = []; let t = 0;
  for (const [a, b] of sil) { if (a > t) parts.push({ start: t, end: a }); t = Math.max(t, b); }
  if (t < duration) parts.push({ start: t, end: duration });
  const joined = [];
  for (const p of parts) { const last = joined[joined.length - 1]; if (last && p.start - last.end < v.joinGap && p.end - last.start <= v.maxChunk) last.end = p.end; else joined.push(Object.assign({}, p)); }
  parts = [];
  for (const p of joined.filter(p => p.end - p.start >= v.minSpeech)) {
    for (let s = p.start; s < p.end; s += v.maxChunk) parts.push({ start: Math.max(0, s - v.edge), end: Math.min(duration, Math.min(p.end, s + v.maxChunk) + v.edge) });
  }
  return parts;
}

// ---------- Polza ----------
async function polzaUpload(file, model, deadline) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' }), path.basename(file));
  fd.append('model', model); fd.append('language', 'ru');
  const r = await fetch(POLZA + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + CFG.polza }, body: fd, signal: AbortSignal.timeout(Math.min(120000, Math.max(1000, deadline - Date.now()))) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new HttpError(502, 'provider_error', 'Polza HTTP ' + r.status + ': ' + String((j && j.error && j.error.message) || '').slice(0, 200), r.status >= 500 || r.status === 429);
  if (!j || typeof j !== 'object' || Array.isArray(j) || (model === MODELS.gigaam && typeof j.text !== 'string')) {
    throw new HttpError(502, 'provider_error', 'Polza вернула некорректный ответ распознавания', true);
  }
  return j;
}
async function aiesaPoll(j, deadline) {
  while (j.status !== 'completed') {
    if (j.status === 'failed' || j.status === 'error') { const msg = String((j.error && (j.error.message || j.error)) || j.status); throw new HttpError(502, 'provider_error', 'Aiesa: ' + msg.slice(0, 200), /временно|недоступ|unavailable|timeout|retry/i.test(msg)); }
    if (typeof j.status !== 'string' || !j.status || typeof j.id !== 'string' || !j.id) throw new HttpError(502, 'provider_error', 'Aiesa вернула некорректный статус задачи', true);
    if (Date.now() > deadline) throw new HttpError(504, 'timeout', 'Aiesa не закончила задачу ' + j.id + ' до общего таймаута', true);
    await sleep(3000);
    const g = await fetch(POLZA + '/audio/transcriptions/' + j.id, { headers: { Authorization: 'Bearer ' + CFG.polza }, signal: AbortSignal.timeout(Math.min(60000, Math.max(1000, deadline - Date.now()))) });
    const n = await g.json().catch(() => null);
    if (!g.ok) throw new HttpError(502, 'provider_error', 'Aiesa HTTP ' + g.status, g.status >= 500 || g.status === 429);
    if (!n || typeof n !== 'object' || Array.isArray(n)) throw new HttpError(502, 'provider_error', 'Aiesa вернула некорректный ответ задачи', true);
    j = n;
  }
  if (!Array.isArray(j.segments) || !j.segments.every(s => s && typeof s.text === 'string' && s.start != null && s.end != null && Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end)) && Number(s.end) >= Number(s.start))) {
    throw new HttpError(502, 'provider_error', 'Aiesa вернула некорректные сегменты', true);
  }
  return j;
}
// Один вызов модели с повтором на «временно недоступен» / 5xx / 429 / таймаут — под общим ограничением одновременных запросов
// info.cancelled — запрос уже не нужен (вышел общий таймаут или другая часть упала без повтора): оставшиеся фразы и повторы
// в Polza не идут, место в ограничителе сразу освобождается — деньги и очередь не тратятся впустую.
const cancelledError = info => info.failure || new HttpError(504, 'timeout', 'не уложились в общий таймаут ' + CFG.timeoutSec + ' с', true);
async function withRetry(fn, deadline, info) {
  if (info.cancelled || Date.now() > deadline) { info.cancelled = true; throw cancelledError(info); }
  await acquire();
  try {
    for (let attempt = 0; ; attempt++) {
      if (info.cancelled || Date.now() > deadline) { info.cancelled = true; throw cancelledError(info); }
      try { const r = await fn(); info.calls++; return r; }
      catch (e) {
        info.calls++;
        const retry = e.retryable && attempt < CFG.retries.length && Date.now() + CFG.retries[attempt] * 1000 < deadline && !info.cancelled;
        if (info.errors.length < 10) info.errors.push(String(e.message).slice(0, 160));
        if (!retry) { if (!info.cancelled) { info.cancelled = true; info.failure = e; } throw e; }
        info.retries++;
        await sleep(CFG.retries[attempt] * 1000);
      }
    }
  } finally { release(); }
}

// gigaam: канал → фразы → каждая фраза отдельным запросом
async function gigaamChannel(file, ch, duration, base, deadline, info, files) {
  const parts = await speechParts(file, duration);
  if (parts.length > CFG.maxParts) throw new HttpError(422, 'too_many_parts', 'в канале ' + parts.length + ' фраз — больше ' + CFG.maxParts, false);
  info.parts += parts.length; info.speech_sec += parts.reduce((s, p) => s + p.end - p.start, 0);
  // Нарезка фразы — внутри ограничителя одновременных запросов: не больше MAX_TASKS процессов ffmpeg разом, сколько бы ни было фраз
  const tasks = parts.map(async (p, i) => {
    const f = base + '_c' + ch + '_' + i + '.mp3'; files.push(f);
    const j = await withRetry(async () => {
      if (!fs.existsSync(f)) await run('ffmpeg', ['-v', 'error', '-y', '-ss', p.start.toFixed(2), '-to', p.end.toFixed(2), '-i', file, '-ac', '1', '-ar', '16000', '-b:a', '48k', f], 60000);
      try { return await polzaUpload(f, MODELS.gigaam, deadline); } finally { await fs.promises.rm(f, { force: true }).catch(() => {}); }
    }, deadline, info);
    return { channel: ch, start: Math.round(p.start * 100) / 100, end: Math.round(p.end * 100) / 100, text: String(j.text || '').trim() };
  });
  const settled = await Promise.allSettled(tasks);
  const failed = settled.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  const out = settled.map(result => result.value);
  return out.filter(s => s.text);
}
// aiesa: канал целиком, отрезки и метки — от модели
async function aiesaChannel(file, ch, duration, deadline, info) {
  const j = await withRetry(async () => aiesaPoll(await polzaUpload(file, MODELS.aiesa, deadline), deadline), deadline, info);
  return (j.segments || []).map(s => ({ channel: ch, start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() })).filter(s => s.text && s.start < Math.max(duration, 0.01));
}

// ---------- тестовый режим (стенд СПИН/Отказов): без Polza и без денег ----------
function testSegments(channels) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const ch = channels === 2 ? i % 2 : 0;
    out.push({ channel: ch, start: i * 4, end: i * 4 + 3.5, text: 'Тестовая реплика канала ' + ch + ', номер ' + (i + 1) });
  }
  return out;
}

// src — файл тела запроса (уже на диске), size — его размер; удаляется здесь же
async function transcribe(src, size, q, id) {
  const t0 = Date.now(); const deadline = t0 + CFG.timeoutSec * 1000;
  const mode = q.get('channels') || 'auto';
  const base = src.replace(/\.in$/, ''); const files = [src];
  try {
    if (!['auto', 'mono', 'stereo'].includes(mode)) throw new HttpError(400, 'bad_request', 'channels: auto | mono | stereo', false);
    // Тестовый режим: модель — та, что настроена (вызывающий проверяет пометку «кто распознал»), отрезки — заготовка, Polza не зовётся
    if (q.get('test') === '1') {
      const channels = mode === 'mono' ? 1 : 2;
      return { ok: true, test: true, model: MODELS[CFG.model], channels, duration_sec: 24, segments: testSegments(channels), elapsed_ms: Date.now() - t0, request_id: id };
    }
    if (!size) throw new HttpError(400, 'bad_request', 'пустое тело: пришлите файл записи', false);
    const p = await probe(src);
    if (p.duration > CFG.maxAudioSec) throw new HttpError(422, 'too_long', 'запись длиннее ' + Math.round(CFG.maxAudioSec / 60) + ' мин', false);
    if (mode === 'stereo' && p.channels < 2) throw new HttpError(422, 'bad_audio', 'запрошено stereo, а в записи ' + p.channels + ' канал', false);
    const stereo = p.channels >= 2 && mode !== 'mono';
    const pad = CFG.model === 'aiesa' && p.duration < CFG.aiesaMinSec ? CFG.aiesaMinSec : 0;
    const tracks = stereo
      ? [{ ch: 0, file: base + '_0.mp3', filter: 'pan=mono|c0=c0' }, { ch: 1, file: base + '_1.mp3', filter: 'pan=mono|c0=c1' }]
      : [{ ch: 0, file: base + '_m.mp3', filter: p.channels >= 2 ? 'pan=mono|c0=0.5*c0+0.5*c1' : 'anull' }];
    for (const t of tracks) {
      files.push(t.file);
      await track(src, t.file, t.filter, pad);
    }
    const info = { calls: 0, retries: 0, errors: [], parts: 0, speech_sec: 0 };
    const settled = await Promise.allSettled(tracks.map(async t => {
      try {
        return await (CFG.model === 'gigaam' ? gigaamChannel(t.file, t.ch, p.duration, base, deadline, info, files) : aiesaChannel(t.file, t.ch, p.duration, deadline, info));
      } catch (error) {
        if (!info.cancelled) { info.cancelled = true; info.failure = error; }
        throw error;
      }
    }));
    const failed = settled.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const per = settled.map(result => result.value);
    const segments = [].concat(...per).sort((a, b) => a.start - b.start || a.channel - b.channel);
    return { ok: true, model: MODELS[CFG.model], channels: stereo ? 2 : 1, source_channels: p.channels, duration_sec: p.duration, padded: !!pad, segments,
      elapsed_ms: Date.now() - t0, polza_calls: info.calls, retries: info.retries, retried_errors: info.errors, speech_parts: info.parts || undefined, speech_sec: info.parts ? Math.round(info.speech_sec * 10) / 10 : undefined, request_id: id };
  } finally { await Promise.allSettled(files.map(f => fs.promises.rm(f, { force: true }))); }
}

function send(res, status, obj) { const b = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) }); res.end(b); }
function keyOk(h) { const a = Buffer.from(String(h || '')), b = Buffer.from(CFG.key); return a.length === b.length && crypto.timingSafeEqual(a, b); }

// Отказ до чтения тела — ответ и обрыв соединения (тело не дочитываем)
function reject(req, res, status, code, message, retryable) {
  const b = JSON.stringify({ ok: false, error: { code, message, retryable } });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b), Connection: 'close' });
  res.end(b, () => req.destroy());
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); const t0 = Date.now();
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, version: VERSION, model: MODELS[CFG.model], running, waiting: waiting.length, in_flight: inFlight, max_tasks: CFG.maxTasks });
  if (!(req.method === 'POST' && url.pathname === '/v1/transcribe')) return reject(req, res, 404, 'not_found', 'есть только GET /health и POST /v1/transcribe', false);
  if (!keyOk(req.headers['x-stt-key'])) return reject(req, res, 401, 'unauthorized', 'нет или неверный X-STT-Key', false);
  if (inFlight >= CFG.queueMax) return reject(req, res, 503, 'overloaded', 'очередь сервиса заполнена (' + inFlight + ')', true);
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > CFG.maxBytes) return reject(req, res, 413, 'too_large', 'файл больше ' + Math.round(CFG.maxBytes / 1048576) + ' МБ', false);
  inFlight++; let counted = true; const done = () => { if (counted) { counted = false; inFlight--; } };
  // Тело — сразу на диск, не в память: память сервиса не растёт от размера и числа записей в очереди
  const id = crypto.randomBytes(6).toString('hex');
  const src = path.join(CFG.work, id + '.in');
  let ws;
  try {
    fs.mkdirSync(CFG.work, { recursive: true });
    ws = fs.createWriteStream(src);
  } catch (error) {
    done();
    log({ status: 503, ms: Date.now() - t0, error: { code: 'storage_error' } });
    return reject(req, res, 503, 'storage_error', 'не удалось сохранить входную запись', true);
  }
  let size = 0; let aborted = false; let dropped = false;
  // файл удаляется после закрытия потока: иначе удаление может опередить его открытие, и файл останется
  const dropFile = () => {
    if (dropped) return;
    dropped = true;
    if (ws.closed) fs.rm(src, { force: true }, () => {});
    else ws.once('close', () => fs.rm(src, { force: true }, () => {}));
    ws.destroy();
  };
  const failStorage = () => {
    if (aborted) return;
    aborted = true;
    dropFile();
    done();
    log({ status: 503, ms: Date.now() - t0, bytes: size, error: { code: 'storage_error' } });
    if (!res.headersSent && !res.destroyed) reject(req, res, 503, 'storage_error', 'не удалось сохранить входную запись', true);
  };
  ws.on('error', failStorage);
  req.on('data', c => {
    size += c.length;
    if (size > CFG.maxBytes && !aborted) { aborted = true; dropFile(); done(); log({ status: 413, ms: Date.now() - t0, bytes: size, error: { code: 'too_large' } }); reject(req, res, 413, 'too_large', 'файл больше ' + Math.round(CFG.maxBytes / 1048576) + ' МБ', false); return; }
    if (!aborted && !ws.write(c)) { req.pause(); ws.once('drain', () => req.resume()); }
  });
  req.on('end', () => {
    if (aborted) return;
    ws.end(async error => {
      if (error) return failStorage();
      if (aborted) return;
      let status = 200, out;
      try { out = await transcribe(src, size, url.searchParams, id); }
      catch (e) {
        status = e instanceof HttpError ? e.status : 500;
        out = { ok: false, error: { code: e.code || 'internal', message: String(e.message).slice(0, 400), retryable: e instanceof HttpError ? e.retryable : true } };
      } finally { done(); }
      log({ status, ms: Date.now() - t0, bytes: size, model: out.model, channels: out.channels, duration: out.duration_sec, segments: out.segments ? out.segments.length : undefined, parts: out.speech_parts, speech_sec: out.speech_sec, calls: out.polza_calls, retries: out.retries || undefined, test: out.test || undefined, error: out.error });
      send(res, status, out);
    });
  });
  req.on('error', () => { aborted = true; dropFile(); done(); });
  req.on('aborted', () => { aborted = true; dropFile(); done(); });
});
// requestTimeout в Node — время на приём всего запроса (тело), а не на ответ: медленная загрузка не держит место в очереди дольше 120 с
server.requestTimeout = CFG.bodySec * 1000; server.headersTimeout = 60000;
server.listen(CFG.port, CFG.bind, () => { log({ start: VERSION, model: MODELS[CFG.model], bind: CFG.bind, port: CFG.port }); console.log('stt-reserve ' + VERSION + ' (' + MODELS[CFG.model] + ') слушает ' + CFG.bind + ':' + CFG.port); });
server.on('error', e => { console.error('не удалось слушать ' + CFG.bind + ':' + CFG.port + ' — ' + e.message); process.exit(1); });
