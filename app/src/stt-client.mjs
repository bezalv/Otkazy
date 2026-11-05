import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MIN_AUDIO_BYTES = 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const RESERVE_ERROR_CODES = new Set([
  'bad_request', 'unauthorized', 'not_found', 'too_large', 'bad_audio', 'too_long',
  'too_many_parts', 'provider_error', 'overloaded', 'timeout', 'internal', 'storage_error',
]);

class AudioError extends Error {
  constructor(message, retryable = true) {
    super(message);
    this.retryable = retryable;
  }
}

function engineLabel(model) {
  const value = String(model ?? '').toLowerCase();
  if (value.includes('gigaam')) return 'reserve:gigaam';
  if (value.includes('aiesa')) return 'reserve:aiesa';
  const tail = value.slice(value.lastIndexOf('/') + 1).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return tail ? `reserve:${tail}`.slice(0, 32) : 'reserve:unknown';
}

/** Перевод ответа stt-reserve в формат подворкфлоу n8n. */
export function reserveToTranscript(body, meta) {
  const requested = Number(meta.channel_count) || 2;
  if (requested === 1 && Number(body.channels) !== 1) {
    throw new TypeError('Моно-запрос вернул несовпадающее число каналов');
  }
  const mono = requested === 1 || Number(body.channels) === 1;
  const role = meta.speaker_role || '';
  const segments = [...body.segments].sort((a, b) => Number(a.start) - Number(b.start));
  const conversation = [];
  const manager = [];
  const client = [];
  if (mono) {
    const text = segments.map(item => item.text.trim()).filter(Boolean).join(' ');
    if (text) {
      const speaker = role || 'Говорящий';
      conversation.push({ id: 1, speaker, text });
      if (role === 'Клиент') client.push(text);
      else manager.push(text);
    }
  } else {
    for (const segment of segments) {
      const text = segment.text.trim();
      if (!text) continue;
      const speaker = Number(segment.channel) === 0 ? 'Менеджер' : 'Клиент';
      const last = conversation.at(-1);
      if (last && last.speaker === speaker) last.text += ` ${text}`;
      else conversation.push({ id: conversation.length + 1, speaker, text });
    }
    for (const item of conversation) {
      (item.speaker === 'Менеджер' ? manager : client).push(item.text);
    }
  }
  return {
    activity_id: meta.activity_id, comm_index: meta.comm_index,
    date: meta.call_date, direction: meta.call_direction,
    channel_count: requested, speaker_role: role, total_replicas: conversation.length,
    conversation, formatted_dialog: conversation.map(item => `${item.speaker}: ${item.text}`).join('\n'),
    manager_text: manager.join(' '), client_text: client.join(' '),
    operation_id: body.request_id || null, s3_file: null, transcript_engine: engineLabel(body.model),
    reserve_duration_sec: body.duration_sec ?? null, reserve_speech_sec: body.speech_sec ?? null,
    ...(mono ? { _transcript_mode: 'mono' } : {}), success: true,
  };
}

function failure(meta, message, options = {}) {
  return {
    success: false, retryable: options.retryable !== false,
    channels_mismatch: options.channelsMismatch === true,
    ...(options.downloadFailed ? { download_failed: true } : { reserve_failed: true }),
    activity_id: meta.activity_id, comm_index: meta.comm_index,
    channel_count: Number(meta.channel_count) || 2, error: message,
  };
}

function validReserveResponse(body) {
  if (!body || body.ok !== true || ![1, 2].includes(Number(body.channels)) || !Array.isArray(body.segments)) return false;
  return body.segments.every(segment => segment && typeof segment.text === 'string'
    && typeof segment.start === 'number' && Number.isFinite(segment.start) && segment.start >= 0
    && Number.isInteger(segment.channel) && segment.channel >= 0
    && segment.channel < Number(body.channels));
}

async function readJsonBounded(response) {
  if (!response) return null;
  const chunks = [];
  let total = 0;
  for await (const part of response) {
    const chunk = Buffer.from(part);
    total += chunk.length;
    if (total > MAX_RESPONSE_BYTES) throw new AudioError('Слишком большой ответ сервиса');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
  catch { return null; }
}

function abortAfter(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

async function withTimeout(action, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      action(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new AudioError('Превышено время запроса к Битриксу')); }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function downloadToFile({ url, path, fetchImpl, timeoutMs, maxBytes }) {
  const timeout = abortAfter(timeoutMs);
  try {
    let response;
    try { response = await fetchImpl(url, { method: 'GET', signal: timeout.signal }); }
    catch { throw new AudioError('Не удалось скачать запись'); }
    if (response.status !== 200) {
      await response.body?.cancel?.().catch(() => {});
      throw new AudioError(`Запись не скачана: HTTP ${Number(response.status) || 'без кода'}`);
    }
    const declared = Number(response.headers.get('content-length')) || 0;
    if (declared > maxBytes) {
      await response.body?.cancel?.().catch(() => {});
      throw new AudioError('Запись превышает допустимый размер', false);
    }
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    if (type.includes('text/html') || type.includes('application/json')) {
      await response.body?.cancel?.().catch(() => {});
      throw new AudioError('Вместо аудио получена страница или JSON');
    }
    if (!response.body) throw new AudioError('Получен пустой ответ записи');
    let size = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) callback(new AudioError('Запись превышает допустимый размер', false));
        else callback(null, chunk);
      },
    });
    const input = typeof response.body.getReader === 'function' ? Readable.fromWeb(response.body) : response.body;
    try {
      await pipeline(input, limiter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: timeout.signal });
    } catch (error) {
      if (error instanceof AudioError) throw error;
      throw new AudioError('Не удалось скачать запись полностью');
    }
    if (size < MIN_AUDIO_BYTES) throw new AudioError('Запись пустая или меньше 1024 байт');
    return size;
  } finally { timeout.close(); }
}

/**
 * Возвращает функцию для transcribeCalls и normalizeCommunications.
 * download_url допускается только из внутреннего нормализатора сообщений.
 * Ссылка может происходить из текста клиента в Битриксе и вести на произвольный
 * HTTP-адрес, включая внутренний. Этот модуль не предоставляет HTTP-обработчик;
 * входной вебхук не должен передавать пользовательский URL напрямую в transcribe.
 * Ограничение хостов не добавлено согласно решению, записанному в AGENTS.md.
 */
export function createSttClient({
  bitrix, sttUrl, sttKey, fetchImpl = globalThis.fetch, tempRoot = tmpdir(),
  reserveRequest = httpRequest,
  maxAudioBytes = MAX_AUDIO_BYTES, downloadTimeoutMs = 60000, reserveTimeoutMs = 660000,
}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Не задан HTTP-клиент');
  if (typeof reserveRequest !== 'function') throw new TypeError('Не задан клиент локального сервиса');
  if (!sttKey || typeof sttKey !== 'string') throw new TypeError('Не задан ключ сервиса распознавания');
  let endpoint;
  try { endpoint = new URL(sttUrl); } catch { throw new TypeError('Некорректный адрес сервиса распознавания'); }
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password) throw new TypeError('Сервис распознавания должен быть локальным');
  endpoint = new URL('/v1/transcribe', endpoint);
  if (!Number.isSafeInteger(maxAudioBytes) || maxAudioBytes < MIN_AUDIO_BYTES || maxAudioBytes > MAX_AUDIO_BYTES) {
    throw new TypeError('Некорректный лимит аудиофайла');
  }
  for (const timeout of [downloadTimeoutMs, reserveTimeoutMs]) {
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new TypeError('Некорректный таймаут');
  }

  return async function transcribe(meta) {
    if (!meta || ![1, 2].includes(Number(meta.channel_count))) throw new TypeError('Некорректное число каналов');
    let downloadUrl;
    if (/^\d+$/.test(String(meta.file_id ?? ''))) {
      if (!Number.isSafeInteger(Number(meta.file_id)) || Number(meta.file_id) <= 0) {
        return failure(meta, 'Некорректный ID аудиофайла', { downloadFailed: true });
      }
      if (!bitrix || typeof bitrix.request !== 'function') return failure(meta, 'Не настроен клиент Битрикса', { downloadFailed: true });
      try {
        const response = await withTimeout(signal => bitrix.request('disk.file.get', { id: Number(meta.file_id) }, { signal }), downloadTimeoutMs);
        downloadUrl = response?.result?.DOWNLOAD_URL;
      } catch { return failure(meta, 'Не удалось получить файл из Битрикса', { downloadFailed: true }); }
    } else {
      downloadUrl = meta.download_url;
    }
    try {
      const url = new URL(downloadUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Недопустимый протокол');
    } catch { return failure(meta, 'Не получена ссылка на аудиозапись', { downloadFailed: true }); }

    let directory;
    let file;
    try {
      directory = await mkdtemp(join(tempRoot, 'otkazy-audio-'));
      file = join(directory, 'recording');
      let size;
      try {
        size = await downloadToFile({ url: downloadUrl, path: file, fetchImpl, timeoutMs: downloadTimeoutMs, maxBytes: maxAudioBytes });
      } catch (error) {
        const message = error instanceof AudioError ? error.message : 'Не удалось сохранить аудиозапись';
        return failure(meta, message, { downloadFailed: true, retryable: error?.retryable !== false });
      }
      const url = new URL(endpoint);
      url.searchParams.set('channels', Number(meta.channel_count) === 1 ? 'mono' : 'stereo');
      const timeout = abortAfter(reserveTimeoutMs);
      const input = createReadStream(file);
      input.on('error', () => {});
      let request;
      let response;
      let body;
      try {
        response = await new Promise((resolve, reject) => {
          request = reserveRequest(url, {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'X-STT-Key': sttKey },
            signal: timeout.signal,
          }, resolve);
          request.on('error', reject);
          input.on('error', reject);
          input.pipe(request);
        });
        body = await readJsonBounded(response);
      } catch {
        return failure(meta, 'Сервис распознавания недоступен или не ответил вовремя');
      } finally {
        input.destroy();
        request?.destroy();
        if (!input.closed) await new Promise(resolve => input.once('close', resolve));
        timeout.close();
      }

      const status = response.statusCode;
      if (status === 200 && (!body || (body.ok !== true && body.ok !== false))) {
        return failure(meta, 'Резерв распознавания вернул некорректный ответ');
      }
      if (status !== 200 || body?.ok !== true) {
        const rawCode = String(body?.error?.code || '');
        const code = RESERVE_ERROR_CODES.has(rawCode) ? rawCode : '';
        const channelsMismatch = code === 'bad_audio' && Number(meta.channel_count) === 2;
        const retryable = channelsMismatch ? false : typeof body?.error?.retryable === 'boolean'
          ? body.error.retryable : status >= 500 || status === 408 || status === 429;
        return failure(meta, `Резерв распознавания: ${code || `HTTP ${status || 'без кода'}`}`, { retryable, channelsMismatch });
      }
      if (!validReserveResponse(body)) return failure(meta, 'Резерв распознавания вернул некорректный ответ');
      if (Number(meta.channel_count) === 1 && Number(body.channels) !== 1) {
        return failure(meta, 'Моно-запрос вернул несовпадающее число каналов');
      }
      return reserveToTranscript(body, meta);
    } catch {
      return failure(meta, 'Не удалось подготовить аудиозапись', { downloadFailed: true });
    } finally {
      let cleanupFailed = false;
      if (file) await rm(file, { force: true }).catch(() => { cleanupFailed = true; });
      if (directory) await rmdir(directory).catch(() => { cleanupFailed = true; });
      if (cleanupFailed) throw new Error('Не удалось удалить временный аудиофайл');
    }
  };
}
