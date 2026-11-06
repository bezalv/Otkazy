import { createWriteStream } from 'node:fs';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { databaseConfig } from '../operator/triage.mjs';
import { createDeadlinePool } from '../db/deadline-pool.mjs';
import { createBitrixClient } from '../bitrix-client.mjs';
import { createBitrixLimiter } from '../bitrix-limiter.mjs';
import { resolveBinary } from '../stt/binaries.mjs';

const exec = promisify(execFile);
const DEALS = new Set([127142, 126198]);
const MAX_BYTES = 50 * 1024 * 1024;
const PCM_BYTES = 30 * 8000 * 4;
const methods = new Set(['crm.activity.list', 'disk.file.get']);

function cleanupUnknown() {
  const error = new Error('Очистка аудиодиагностики не подтверждена');
  error.code = 'AUDIO_CLEANUP_UNKNOWN';
  return error;
}

function validId(value) {
  return /^(?:[1-9]\d{0,14})$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value));
}

/** URL из старой карточки мог относиться к первому разбору, а не транскрипту. */
export function fileIdFromStoredUrl(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/(?:[?&]|^)fileId=(\d+)(?:[&#]|$)/);
  return match && validId(match[1]) ? match[1] : null;
}

function fileList(files) {
  if (Array.isArray(files)) return files;
  if (files && typeof files === 'object') return Object.values(files);
  return [];
}

function chosenUrl(call) {
  for (const file of fileList(call?.FILES)) {
    const url = file?.urlDownload || file?.URL_DOWNLOAD || file?.url;
    if (typeof url === 'string' && url.trim()) return url.trim();
  }
  return typeof call?.SETTINGS?.RECORD_URL === 'string' ? call.SETTINGS.RECORD_URL.trim() : '';
}

/** Считает сравнение каналов по PCM, не возвращает образцы или хеши. */
export function comparePcm16Stereo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.length % 4 !== 0 || buffer.length > PCM_BYTES) {
    throw new TypeError('Некорректные данные аудиопроверки');
  }
  let same = true, sumL = 0, sumR = 0, sqL = 0, sqR = 0, product = 0;
  const count = buffer.length / 4;
  for (let offset = 0; offset < buffer.length; offset += 4) {
    const left = buffer.readInt16LE(offset), right = buffer.readInt16LE(offset + 2);
    if (left !== right) same = false;
    sumL += left; sumR += right; sqL += left * left; sqR += right * right; product += left * right;
  }
  const varianceL = sqL - sumL * sumL / count, varianceR = sqR - sumR * sumR / count;
  let correlation = 'unavailable';
  if (varianceL > 0 && varianceR > 0) {
    const value = (product - sumL * sumR / count) / Math.sqrt(varianceL * varianceR);
    correlation = value <= -0.99 ? 'at_most_minus_0_99' : value >= 0.99 ? 'at_least_0_99'
      : value >= 0.9 ? '0_90_to_0_99' : value >= 0.5 ? '0_50_to_0_90' : 'below_0_50';
  }
  return { sample_available: true, pcm_identical: same, zero_lag_correlation: correlation };
}

/** Файл должен быть локальным; ffprobe и ffmpeg ограничены по времени и памяти. */
export async function inspectAudioFile(file, { ffprobe = resolveBinary('ffprobe'), ffmpeg = resolveBinary('ffmpeg'), signal } = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('Не задан аудиофайл');
  const options = { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, signal };
  const probe = await exec(ffprobe, ['-v', 'error', '-show_entries', 'stream=index,codec_type,channels,duration:format=duration', '-of', 'json', file], options);
  const json = JSON.parse(probe.stdout);
  const audioStreams = Array.isArray(json.streams) ? json.streams.filter(item => item.codec_type === 'audio') : [];
  const audio = audioStreams[0];
  const channels = Number(audio?.channels), seconds = Number(json?.format?.duration || audio?.duration);
  if (!Number.isInteger(audio?.index) || audio.index < 0 || !Number.isInteger(channels) || channels < 1 || channels > 8 || !Number.isFinite(seconds) || seconds <= 0 || seconds > 10800) {
    throw new Error('Некорректные параметры аудио');
  }
  const duration = seconds < 30 ? 'less_than_30s' : seconds <= 120 ? '30_to_120s' : 'over_120s';
  const streamCheck = { multiple_audio_streams: audioStreams.length > 1, source_stream_selection_verified: audioStreams.length === 1 };
  if (channels !== 2) return { channels, duration, ...streamCheck, stereo_sample: null };
  const raw = await exec(ffmpeg, ['-v', 'error', '-i', file, '-map', `0:${audio.index}`, '-t', '30', '-vn', '-ac', '2', '-ar', '8000', '-f', 's16le', 'pipe:1'],
    { ...options, encoding: 'buffer', maxBuffer: PCM_BYTES + 4096 });
  return { channels, duration, ...streamCheck, stereo_sample: comparePcm16Stereo(raw.stdout) };
}

async function oldCalls(pool, dealId) {
  const connection = await pool.connect();
  let releaseError;
  try {
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const check = await connection.query(`SELECT current_setting('transaction_read_only') AS read_only,
      to_regclass('public.lost_deal_communications') IS NOT NULL AS present,
      CASE WHEN to_regclass('public.lost_deal_communications') IS NOT NULL
        THEN row_security_active(to_regclass('public.lost_deal_communications')) ELSE true END AS rls_active`);
    if (check.rows?.length !== 1 || check.rows[0].read_only !== 'on' || check.rows[0].present !== true || check.rows[0].rls_active !== false) {
      throw new Error('Нельзя подтвердить видимость истории');
    }
    const data = await connection.query(`SELECT event_id, call_audio_url, call_has_audio
      FROM public.lost_deal_communications WHERE deal_id=$1 AND event_type='call' ORDER BY event_id LIMIT 501`, [dealId]);
    if (!Array.isArray(data.rows) || data.rows.length > 500) throw new Error('Слишком много звонков');
    await connection.query('COMMIT');
    return data.rows;
  } catch {
    try { await connection.query('ROLLBACK'); } catch (error) { releaseError = error; }
    throw new Error('Не удалось безопасно прочитать историю звонков');
  } finally { connection.release(releaseError); }
}

async function currentCalls(bitrix, dealId) {
  const list = [], seen = new Set();
  let start = 0;
  for (let page = 0; page < 10; page++) {
    const response = await bitrix.request('crm.activity.list', {
      filter: { OWNER_TYPE_ID: 2, OWNER_ID: dealId, TYPE_ID: 2 },
      select: ['ID', 'SETTINGS', 'FILES'], order: { CREATED: 'ASC' }, start,
    });
    if (!Array.isArray(response?.result) || response.result.length > 50 || response.error) throw new Error('Неполный список звонков');
    for (const call of response.result) {
      if (!validId(call?.ID) || seen.has(String(call.ID))) throw new Error('Некорректный список звонков');
      seen.add(String(call.ID)); list.push(call);
    }
    if (response.next == null || response.next === false) {
      if (response.total != null && Number(response.total) !== start + response.result.length) throw new Error('Неполный список звонков');
      if (response.total == null && response.result.length === 50) throw new Error('Полнота звонков не подтверждена');
      return list;
    }
    const next = Number(response.next);
    if (!Number.isSafeInteger(next) || next !== start + response.result.length || next <= start) throw new Error('Некорректная пагинация');
    start = next;
  }
  throw new Error('Превышен лимит страниц');
}

export async function downloadToFile(url, path, { fetchImpl = fetch, signal: outerSignal } = {}) {
  let parsed = new URL(url);
  const signal = outerSignal ? AbortSignal.any([outerSignal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
  let response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Недопустимая ссылка');
    response = await fetchImpl(parsed, { signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel?.().catch(() => {});
    if (!location || redirects === 5) throw new Error('Некорректное перенаправление');
    parsed = new URL(location, parsed);
  }
  if (!response.ok || !response.body) { await response.body?.cancel?.().catch(() => {}); throw new Error('Ошибка загрузки'); }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) { await response.body.cancel().catch(() => {}); throw new Error('Превышен размер'); }
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (type.includes('text/html') || type.includes('application/json')) { await response.body.cancel().catch(() => {}); throw new Error('Не аудиофайл'); }
  let size = 0;
  const limit = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    callback(size > MAX_BYTES ? new Error('Превышен размер') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
  if (size < 1024) throw new Error('Пустое аудио');
}

/** Явный выбор 1 сделки; ни ID, ни URL, ни текста нет в результате. */
export async function inspectDealAudio({ pool, client, dealId, download = downloadToFile, inspectFile = inspectAudioFile,
  tempRoot = tmpdir(), signal = AbortSignal.timeout(150000), removeFile = unlink, removeDirectory = rmdir }) {
  if (!DEALS.has(Number(dealId)) || !pool || typeof pool.connect !== 'function' || !client || typeof client.request !== 'function') {
    throw new TypeError('Некорректные параметры проверки');
  }
  // Обёртка запрещает любой метод записи до сетевого вызова.
  const bitrix = { request(method, body) {
    if (!methods.has(method)) throw new Error('Метод запрещён');
    signal.throwIfAborted();
    return client.request(method, body, { signal });
  } };
  const old = await oldCalls(pool, Number(dealId));
  const current = await currentCalls(bitrix, Number(dealId));
  const recorded = old.filter(row => row.call_has_audio === true);
  if (recorded.length !== 1) throw new Error('Для диагностики требуется ровно одна сохранённая аудиозапись');
  const output = { historical_recorded: recorded.length, activity_matches: 0, activity_missing: 0,
    stored_url_fileid_matches_current: 0, fileid_differs: 0, fileid_unavailable: 0, inspected: 0, audio: [],
    historical_file_identity_verified: false,
    limitations: ['stored_url_may_predate_transcript', 'stored_audio_flag_may_be_stale', 'bitrix_list_not_snapshot',
      'file_bytes_may_have_changed', 'correlation_only_zero_lag_first_30_seconds'] };
  const byId = new Map(current.map(item => [String(item.ID), item]));
  for (const row of recorded) {
    if (!validId(row.event_id)) { output.activity_missing++; continue; }
    const call = byId.get(String(row.event_id));
    if (!call) { output.activity_missing++; continue; }
    output.activity_matches++;
    const savedFile = fileIdFromStoredUrl(row.call_audio_url), currentFile = fileIdFromStoredUrl(chosenUrl(call));
    if (!savedFile || !currentFile) output.fileid_unavailable++;
    else if (savedFile === currentFile) output.stored_url_fileid_matches_current++;
    else output.fileid_differs++;
    if (!currentFile) continue;
    const response = await bitrix.request('disk.file.get', { id: Number(currentFile) });
    const url = response?.result?.DOWNLOAD_URL;
    if (typeof url !== 'string') throw new Error('Нет ссылки на запись');
    const directory = await mkdtemp(join(tempRoot, 'otkazy-audio-inspect-'));
    const path = join(directory, 'recording');
    try {
      signal.throwIfAborted();
      await download(url, path, { signal });
      const info = await inspectFile(path, { signal });
      if (!info || !Number.isInteger(info.channels) || info.channels < 1 || info.channels > 8
          || typeof info.multiple_audio_streams !== 'boolean' || typeof info.source_stream_selection_verified !== 'boolean'
          || info.multiple_audio_streams === info.source_stream_selection_verified
          || !['less_than_30s', '30_to_120s', 'over_120s'].includes(info.duration)) throw new Error('Некорректный аудиоотчёт');
      if (info.channels === 2 && (!info.stereo_sample || info.stereo_sample.sample_available !== true
          || typeof info.stereo_sample.pcm_identical !== 'boolean'
          || !['unavailable', 'at_most_minus_0_99', 'at_least_0_99', '0_90_to_0_99', '0_50_to_0_90', 'below_0_50'].includes(info.stereo_sample.zero_lag_correlation))) {
        throw new Error('Некорректный отчёт каналов');
      }
      output.audio.push({ channels: info.channels, duration: info.duration, multiple_audio_streams: info.multiple_audio_streams,
        source_stream_selection_verified: info.source_stream_selection_verified, stereo_sample: info.channels === 2
        ? { sample_available: true, pcm_identical: info.stereo_sample.pcm_identical, zero_lag_correlation: info.stereo_sample.zero_lag_correlation } : null });
      output.inspected++;
    } finally {
      // Даже если удаление файла не удалось, пытаемся удалить каталог. Ни
      // пути, ни исходные ошибки в вывод не попадают. Не сообщаем об успешной
      // очистке, если хотя бы одна из операций не была подтверждена.
      let failed = false;
      try { await removeFile(path); } catch (error) { if (error?.code !== 'ENOENT') failed = true; }
      try { await removeDirectory(directory); } catch { failed = true; }
      if (failed) throw cleanupUnknown();
    }
  }
  return output;
}

/** Deadline включает БД и сеть; маркер возможен только после реальной уборки. */
export async function withAudioInspectionResources({ run, closePool, closeLimiter, deadlineMs = 150000, closeGraceMs = 30000 }) {
  if (typeof run !== 'function' || typeof closePool !== 'function' || typeof closeLimiter !== 'function'
      || !Number.isSafeInteger(deadlineMs) || deadlineMs < 10 || deadlineMs > 150000
      || !Number.isSafeInteger(closeGraceMs) || closeGraceMs < 10 || closeGraceMs > 30000) throw new TypeError('Неверные параметры ресурсов');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const work = Promise.resolve().then(() => run(controller.signal));
  const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Истёк срок')), { once: true }));
  let result, failed = false, limiterFailed = false;
  try { result = await Promise.race([work, cancelled]); }
  catch { failed = true; }
  finally {
    clearTimeout(timer);
    controller.abort();
    try { closeLimiter(); } catch { limiterFailed = true; }
    let grace;
    try {
      const outcomes = await Promise.race([
        Promise.allSettled([work, Promise.resolve().then(closePool)]),
        new Promise((_, reject) => { grace = setTimeout(() => reject(cleanupUnknown()), closeGraceMs); }),
      ]);
      if (limiterFailed || outcomes[1].status !== 'fulfilled'
          || (outcomes[0].status === 'rejected' && outcomes[0].reason?.code === 'AUDIO_CLEANUP_UNKNOWN')) throw cleanupUnknown();
    } finally { clearTimeout(grace); }
  }
  return failed ? { status: 'error', resources_closed: true } : { ...result, status: 'completed', resources_closed: true };
}

async function main() {
  if (process.argv.length !== 3 || !DEALS.has(Number(process.argv[2])) || String(Number(process.argv[2])) !== process.argv[2]) throw new Error('Неверная сделка');
  const env = process.env;
  const config = databaseConfig(env);
  const base = new URL(env.BITRIX_REST_BASE);
  if (base.protocol !== 'https:' || base.hostname !== 'dinalnsk.bitrix24.ru' || base.username || base.password
      || base.search || base.hash || !/^\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(base.pathname)) throw new Error('Неверный клиент');
  const { default: pg } = await import('pg');
  const raw = new pg.Pool(config); raw.on('error', () => {});
  const controller = new AbortController();
  const pool = createDeadlinePool(raw, { initializationSignal: controller.signal }), limiter = createBitrixLimiter();
  const client = createBitrixClient({ baseUrl: base.toString(), limiter });
  const result = await withAudioInspectionResources({
    run: signal => {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
      if (signal.aborted) controller.abort();
      return inspectDealAudio({ pool, client, dealId: Number(process.argv[2]), signal });
    },
    closeLimiter: () => limiter.close(), closePool: () => pool.end(),
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Аудиодиагностика не завершена'); process.exitCode = 1; });
}
