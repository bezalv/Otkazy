// Только ручной машинный анализ оригинальных аудиобайтов пяти конкретных звонков.
// Никаких действий в CRM/БД и никакой отправки записей, кроме Polza.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createBitrixClient } from '../bitrix-client.mjs';
import { createBitrixLimiter } from '../bitrix-limiter.mjs';
import { resolveBinary } from '../stt/binaries.mjs';
import { fileIdFromStoredUrl, withAudioInspectionResources } from './audio-inspect.mjs';
import { sealEvidenceReport } from './evidence-review.mjs';

const PAIRS = new Map([['96621', new Set(['1315693', '1317027', '1454929'])],
  ['126554', new Set(['1660320'])], ['126956', new Set(['1665898'])]]);
const MODELS = new Set(['xiaomi/mimo-v2.6-flash']);
const METHODS = new Set(['crm.activity.get', 'disk.file.get']);
const POLZA = 'https://api.polza.ai/api/v1';
const MAX_AUDIO = 15 * 1024 * 1024;
const MAX_JSON = 3 * 1024 * 1024;
const MAX_CLIP = 4 * 1024 * 1024;
const CLIP_RANGES = new Map([['126554:1660320', new Set(['0:30', '30:60', '60:90', '90:109'])],
  ['126956:1665898', new Set(['0:30', '30:60', '60:83'])]]);
const MP3_CLIP_RANGES = new Map([['126554:1660320', new Set(['0:20', '20:40', '40:60', '60:80', '80:95', '95:109'])],
  ['126956:1665898', new Set(['60:72', '72:83'])]]);
const HTTP_CODES = new Set([400, 401, 403, 404, 408, 413, 415, 422, 429, 500, 502, 503, 504]);
const SAFE_ERRORS = new Set(['model_unavailable', 'audio_unavailable', 'unsupported_format', 'audio_clip_failed', 'bitrix_error', 'deadline', 'unexpected_error',
  'polza_http_other', ...[...HTTP_CODES].map(x => `polza_http_${x}`)]);

class SafeAudioError extends Error {
  constructor(code) { super('Аудиопроверка не выполнена'); this.code = SAFE_ERRORS.has(code) ? code : 'unexpected_error'; }
}
function safeHttp(response) {
  if (!response?.ok) throw new SafeAudioError(HTTP_CODES.has(response?.status) ? `polza_http_${response.status}` : 'polza_http_other');
  return response;
}
async function safeStage(operation, fallback) {
  try { return await operation(); } catch (error) {
    if (error instanceof SafeAudioError) throw error;
    throw new SafeAudioError(fallback);
  }
}

function requirePair(deal, activity) {
  if (typeof deal !== 'string' || typeof activity !== 'string' || !PAIRS.get(deal)?.has(activity)) throw new Error('Пара не разрешена');
}

function requireClip(deal, activity, clip, clipFormat = 'wav') {
  if (!['wav', 'mp3'].includes(clipFormat) || (clip == null && clipFormat !== 'wav')) throw new Error('Формат не разрешён');
  if (clip == null) return;
  const ranges = clipFormat === 'mp3' ? MP3_CLIP_RANGES : CLIP_RANGES;
  if (!clip || typeof clip !== 'object' || Array.isArray(clip)
      || !Number.isInteger(clip.start_seconds) || !Number.isInteger(clip.end_seconds)
      || Object.keys(clip).length !== 2 || !ranges.get(`${deal}:${activity}`)?.has(`${clip.start_seconds}:${clip.end_seconds}`)) throw new Error('Диапазон не разрешён');
}

export function chooseAudioModel(payload, model) {
  if (!MODELS.has(model) || !Array.isArray(payload?.data)) throw new Error('Модель не разрешена');
  const matches = payload.data.filter(item => item?.id === model);
  if (matches.length !== 1) throw new Error('Модель недоступна');
  const item = matches[0];
  const modalities = item?.architecture?.input_modalities ?? item?.input_modalities;
  if (!Array.isArray(modalities) || !modalities.includes('audio')) throw new Error('Аудиовход не подтверждён');
  return model;
}

function checkUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'dinalnsk.bitrix24.ru' || url.port || url.username || url.password) throw new Error('Адрес записи запрещён');
  return url;
}

async function boundedBytes(response, maximum) {
  if (!response?.ok || !response.body || !Number.isInteger(maximum) || maximum <= 0) {
    await response?.body?.cancel?.().catch(() => {}); throw new Error('Ошибка загрузки');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) { await response.body.cancel().catch(() => {}); throw new Error('Превышен размер'); }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      const part = Buffer.from(chunk); size += part.length;
      if (size > maximum) { part.fill(0); throw new Error('Превышен размер'); }
      chunks.push(part);
    }
    return Buffer.concat(chunks, size);
  } finally { for (const chunk of chunks) chunk.fill(0); }
}

async function boundedJson(response) {
  const bytes = await boundedBytes(response, MAX_JSON);
  try { return JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
}

export function audioMetadata(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.length > MAX_AUDIO) throw new Error('Аудиоданные недопустимы');
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') {
    let offset = 12, channels = null, sampleRate = null, bits = null, dataBytes = null, encoding = null;
    while (offset + 8 <= buffer.length) {
      const name = buffer.toString('ascii', offset, offset + 4), length = buffer.readUInt32LE(offset + 4), start = offset + 8;
      if (start + length > buffer.length) throw new Error('Повреждённый WAV');
      if (name === 'fmt ' && length >= 16) { encoding = buffer.readUInt16LE(start); channels = buffer.readUInt16LE(start + 2);
        sampleRate = buffer.readUInt32LE(start + 4); bits = buffer.readUInt16LE(start + 14); }
      if (name === 'data') dataBytes = length;
      offset = start + length + (length & 1);
    }
    if (!channels || channels > 8 || !sampleRate || !bits || !dataBytes) throw new Error('Параметры WAV не определены');
    const duration = encoding === 1 && bits % 8 === 0 ? dataBytes / (sampleRate * channels * (bits / 8)) : null;
    return { format: 'wav', bytes: buffer.length, channels, sample_rate: sampleRate, duration_seconds: Number.isFinite(duration) ? duration : null };
  }
  if (buffer.toString('ascii', 0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
    return { format: 'mp3', bytes: buffer.length, channels: null, sample_rate: null, duration_seconds: null };
  }
  throw new Error('Поддерживаются только WAV и MP3');
}

// Проверяем каждый фрейм созданного нами MPEG-2 Layer III: продолжительность
// включает небольшое дополнение кодека и не зависит от заголовка Xing.
export function mp3ClipMetadata(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.length > MAX_CLIP) throw new Error('MP3 недопустим');
  let at = 0, frames = 0, channels = null;
  if (buffer.toString('ascii', 0, 3) === 'ID3') {
    if (buffer.length < 10 || [...buffer.subarray(6, 10)].some(n => n & 0x80)) throw new Error('ID3 повреждён');
    at = 10 + ((buffer[6] << 21) | (buffer[7] << 14) | (buffer[8] << 7) | buffer[9]);
  }
  const bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  while (at + 4 <= buffer.length) {
    const h = buffer.readUInt32BE(at);
    const sync = h >>> 21, version = (h >>> 19) & 3, layer = (h >>> 17) & 3;
    const bitrate = bitrates[(h >>> 12) & 15], rateIndex = (h >>> 10) & 3;
    const channelCount = ((h >>> 6) & 3) === 3 ? 1 : 2;
    if (sync !== 0x7ff || version !== 2 || layer !== 1 || !bitrate || rateIndex !== 2
        || (channels !== null && channels !== channelCount)) throw new Error('MP3 фрейм повреждён');
    const length = Math.floor(72000 * bitrate / 16000) + ((h >>> 9) & 1);
    if (at + length > buffer.length) throw new Error('MP3 усечён');
    channels = channelCount; frames++; at += length;
  }
  if (!frames || at !== buffer.length) throw new Error('MP3 фреймы неполны');
  return { format: 'mp3', bytes: buffer.length, channels, sample_rate: 16000, duration_seconds: frames * 576 / 16000 };
}

/** FFmpeg работает без shell и временных файлов; завершение процесса ожидается даже при отмене. */
export async function clipAudio(buffer, { start_seconds, end_seconds, signal, format = 'wav', spawnImpl = spawn, executable = resolveBinary('ffmpeg') }) {
  const formats = format === 'wav' ? CLIP_RANGES : format === 'mp3' ? MP3_CLIP_RANGES : null;
  if (!formats || ![...formats.values()].some(ranges => ranges.has(`${start_seconds}:${end_seconds}`))) throw new Error('Диапазон не разрешён');
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.length > MAX_AUDIO || !signal || typeof spawnImpl !== 'function') throw new Error('Недопустимый фрагмент');
  signal.throwIfAborted();
  const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ss', String(start_seconds), '-t', String(end_seconds - start_seconds),
    '-map', '0:a:0', '-vn', '-ar', '16000', ...(format === 'wav'
      ? ['-acodec', 'pcm_s16le', '-f', 'wav']
      : ['-acodec', 'libmp3lame', '-b:a', '64k', '-write_xing', '0', '-f', 'mp3']), 'pipe:1'];
  const child = spawnImpl(executable, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, detached: false, shell: false });
  const chunks = [];
  let size = 0, failure = false, aborted = false;
  return new Promise((resolveClip, rejectClip) => {
    const stop = () => { aborted = true; child.stdin.destroy(); child.kill('SIGKILL'); };
    const cleanup = () => { signal.removeEventListener('abort', stop); for (const chunk of chunks) chunk.fill(0); };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.on('error', () => { failure = true; });
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => { failure = true; child.kill('SIGKILL'); });
    child.stdout.on('data', input => {
      const part = Buffer.from(input); size += part.length;
      if (size > MAX_CLIP || aborted) { part.fill(0); failure = true; child.stdin.destroy(); child.kill('SIGKILL'); }
      else chunks.push(part);
    });
    child.once('close', code => {
      let output;
      try {
        if (failure || aborted || signal.aborted || code !== 0 || size < 44) throw new Error('Фрагмент не создан');
        output = Buffer.concat(chunks, size);
        if (format === 'mp3') {
          const meta = mp3ClipMetadata(output), wanted = end_seconds - start_seconds;
          if (meta.duration_seconds < wanted - 0.25 || meta.duration_seconds > wanted + 0.25) throw new Error('Длительность фрагмента не подтверждена');
          cleanup(); resolveClip(output); return;
        }
        if (output.toString('ascii', 0, 4) !== 'RIFF' || output.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Не WAV');
        // Потоковый WAV может содержать неопределённые размеры 0xffffffff.
        if (output.readUInt32LE(4) === 0xffffffff) output.writeUInt32LE(output.length - 8, 4);
        let offset = 12, dataFound = false;
        while (offset + 8 <= output.length) {
          const name = output.toString('ascii', offset, offset + 4), n = output.readUInt32LE(offset + 4), start = offset + 8;
          if (name === 'data' && n === 0xffffffff) { output.writeUInt32LE(output.length - start, offset + 4); dataFound = true; break; }
          if (start + n > output.length) throw new Error('WAV повреждён');
          if (name === 'data') { dataFound = true; break; }
          offset = start + n + (n & 1);
        }
        if (!dataFound) throw new Error('В WAV нет данных');
        const meta = audioMetadata(output), wanted = end_seconds - start_seconds;
        if (meta.sample_rate !== 16000 || meta.duration_seconds == null || meta.duration_seconds < wanted - 1 || meta.duration_seconds > wanted + 0.25) throw new Error('Длительность фрагмента не подтверждена');
        cleanup(); resolveClip(output);
      } catch {
        output?.fill(0); cleanup(); rejectClip(new Error('Фрагмент не создан'));
      }
    });
    child.stdin.end(buffer);
  });
}

async function fetchAudio(url, { fetchImpl, signal }) {
  let current = checkUrl(url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const response = await fetchImpl(current, { method: 'GET', redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel?.().catch(() => {});
      if (!location || redirects === 3) throw new Error('Недопустимое перенаправление');
      current = checkUrl(new URL(location, current));
      continue;
    }
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      await response.body?.cancel?.().catch(() => {}); throw new Error('Ответ не аудио');
    }
    return boundedBytes(response, MAX_AUDIO);
  }
  throw new Error('Перенаправление не завершено');
}

function activityFileId(activity) {
  const entries = Array.isArray(activity?.FILES) ? activity.FILES : Object.values(activity?.FILES || {});
  const urls = entries.map(item => item?.urlDownload || item?.URL_DOWNLOAD || item?.url).filter(x => typeof x === 'string');
  if (typeof activity?.SETTINGS?.RECORD_URL === 'string') urls.push(activity.SETTINGS.RECORD_URL);
  const ids = [...new Set(urls.map(fileIdFromStoredUrl).filter(Boolean))];
  if (ids.length !== 1) throw new Error('Файл записи не определён однозначно');
  return Number(ids[0]);
}

/** Анализирует выбранную запись напрямую, без использования сохранённой расшифровки. */
export async function inspectOneAudio({ dealId, activityId, model, apiKey, client, fetchImpl = fetch, signal, onPhase = () => {}, clip = null, clipFormat = 'wav', clipper = clipAudio }) {
  requirePair(dealId, activityId);
  requireClip(dealId, activityId, clip, clipFormat);
  if (!MODELS.has(model) || typeof apiKey !== 'string' || !apiKey || !client || typeof client.request !== 'function'
      || typeof fetchImpl !== 'function' || typeof onPhase !== 'function' || typeof clipper !== 'function' || !signal || typeof signal.throwIfAborted !== 'function') throw new Error('Параметры не подтверждены');
  const call = async (method, body) => {
    if (!METHODS.has(method)) throw new Error('Метод запрещён');
    signal.throwIfAborted();
    return client.request(method, body, { signal });
  };
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  onPhase('model_check');
  await safeStage(async () => {
    const available = safeHttp(await fetchImpl(`${POLZA}/models`, { method: 'GET', headers, redirect: 'error', signal }));
    chooseAudioModel(await boundedJson(available), model);
  }, 'model_unavailable');
  onPhase('bitrix_lookup');
  const activity = await safeStage(async () => {
    const activityResult = await call('crm.activity.get', { id: Number(activityId) });
    const item = activityResult?.result;
    if (String(item?.ID) !== activityId || Number(item.OWNER_TYPE_ID) !== 2 || String(item.OWNER_ID) !== dealId || Number(item.TYPE_ID) !== 2) throw new Error('Звонок не принадлежит сделке');
    return item;
  }, 'bitrix_error');
  const fileId = await safeStage(() => activityFileId(activity), 'audio_unavailable');
  const file = await safeStage(() => call('disk.file.get', { id: fileId }), 'bitrix_error');
  const download = await safeStage(async () => {
    if (typeof file?.result?.DOWNLOAD_URL !== 'string') throw new Error('Нет ссылки на запись');
    return file.result.DOWNLOAD_URL;
  }, 'audio_unavailable');
  let bytes, clipped;
  try {
    onPhase('audio_download');
    bytes = await safeStage(() => fetchAudio(download, { fetchImpl, signal }), 'audio_unavailable');
    const metadata = await safeStage(() => audioMetadata(bytes), 'unsupported_format');
    let input = bytes, inputMetadata = metadata;
    if (clip) {
      if (clipFormat === 'mp3' && metadata.format === 'wav' && ![1, 2].includes(metadata.channels)) throw new SafeAudioError('unsupported_format');
      onPhase('audio_clip');
      clipped = await safeStage(() => clipper(bytes, { ...clip, signal, format: clipFormat }), 'audio_clip_failed');
      if (!Buffer.isBuffer(clipped) || clipped.length > MAX_CLIP) throw new SafeAudioError('audio_clip_failed');
      input = clipped;
      inputMetadata = await safeStage(() => clipFormat === 'mp3' ? mp3ClipMetadata(clipped) : audioMetadata(clipped), 'audio_clip_failed');
      const wanted = clip.end_seconds - clip.start_seconds;
      if (clipFormat === 'mp3' && (![1, 2].includes(inputMetadata.channels) || (metadata.channels != null && metadata.channels !== inputMetadata.channels)
          || inputMetadata.sample_rate !== 16000 || inputMetadata.duration_seconds == null
          || inputMetadata.duration_seconds < wanted - 0.25 || inputMetadata.duration_seconds > wanted + 0.25)) throw new SafeAudioError('audio_clip_failed');
    }
    signal.throwIfAborted();
    const body = { model, temperature: 0, messages: [{ role: 'user', content: [
      { type: 'text', text: 'Проанализируй только приложенную аудиозапись. Не пользуйся готовой расшифровкой и не выноси вердикт по сделке. Передай буквальные ключевые фразы по порядку, отмечая, кто их произнёс только когда это слышно уверенно. Отдельно отметь, есть ли автоответчик, согласие или отказ, разговор о цене и конкуренте, действия менеджера'
          + (clip ? ' и что произошло в слышимом фрагменте.' : ' и чем закончился разговор.')
          + ' Если не расслышал слово, роль или контекст — явно скажи об этом; не додумывай. Укажи, если раздельное прослушивание сторон невозможно.'
          + (clip ? ` Это только фрагмент с ${clip.start_seconds} по ${clip.end_seconds} секунду записи. Его начало и конец могут обрывать фразы; не делай выводов о недостающих частях разговора.` : '') },
      { type: 'input_audio', input_audio: { data: input.toString('base64'), format: inputMetadata.format } },
    ] }] };
    onPhase('model_audio');
    const answer = await safeStage(async () => {
      const response = safeHttp(await fetchImpl(`${POLZA}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal }));
      const parsed = await boundedJson(response), content = parsed?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim() || content.length > 24000) throw new Error('Ответ модели недоступен');
      return content;
    }, 'model_unavailable');
    return { deal_id: dealId, activity_id: activityId, model, audio_metadata: metadata,
      ...(clip ? { clip: { ...clip, offset_seconds: clip.start_seconds, audio_metadata: inputMetadata } } : {}),
      machine_audio_analysis: answer, limitations: ['machine_audio_interpretation_not_human_listening', 'speaker_and_words_may_be_wrong', 'historical_file_identity_unverified'] };
  } finally { bytes?.fill(0); clipped?.fill(0); }
}

/** После завершения работы и закрытия limiter возвращает только ограниченный код ошибки. */
export async function runAudioCommand({ dealId, activityId, model, apiKey, client, fetchImpl = fetch, closeLimiter, deadlineMs = 150000, closeGraceMs = 30000, clip = null, clipFormat = 'wav', clipper = clipAudio }) {
  requirePair(dealId, activityId);
  requireClip(dealId, activityId, clip, clipFormat);
  if (!MODELS.has(model) || typeof closeLimiter !== 'function') throw new Error('Параметры не подтверждены');
  let phase = 'model_check';
  const result = await withAudioInspectionResources({ run: async signal => {
    try { return await inspectOneAudio({ dealId, activityId, model, apiKey, client, fetchImpl, signal, clip, clipFormat, clipper, onPhase: next => { phase = next; } }); }
    catch (error) { return { audio_error: true, phase, error_code: signal.aborted ? 'deadline' : SAFE_ERRORS.has(error?.code) ? error.code : 'unexpected_error' }; }
  }, closeLimiter, closePool: async () => {}, deadlineMs, closeGraceMs });
  return result.status === 'error' ? { status: 'error', phase, error_code: 'deadline', resources_closed: true, service_closed: true }
    : result.audio_error === true ? { status: 'error', phase: result.phase, error_code: result.error_code, resources_closed: true, service_closed: true }
      : { ...result, service_closed: result.resources_closed === true };
}

async function main() {
  const regular = process.argv.length === 7 && process.argv[5] === '--sealed';
  const sliced = process.argv.length === 10 && process.argv[5] === '--clip' && process.argv[8] === '--sealed';
  const mp3Sliced = process.argv.length === 10 && process.argv[5] === '--mp3-clip' && process.argv[8] === '--sealed';
  if (!regular && !sliced && !mp3Sliced) throw new Error('Требуется защищённый вывод');
  const [, , dealId, activityId, model] = process.argv;
  const publicKey = process.argv[sliced || mp3Sliced ? 9 : 6];
  const clip = sliced || mp3Sliced ? { start_seconds: Number(process.argv[6]), end_seconds: Number(process.argv[7]) } : null;
  const clipFormat = mp3Sliced ? 'mp3' : 'wav';
  if (clip && (String(clip.start_seconds) !== process.argv[6] || String(clip.end_seconds) !== process.argv[7])) throw new Error('Некорректный диапазон');
  requirePair(dealId, activityId);
  requireClip(dealId, activityId, clip, clipFormat);
  if (!MODELS.has(model)) throw new Error('Модель не разрешена');
  // Проверяем ключ до любых сетевых запросов.
  sealEvidenceReport({ service_closed: true }, publicKey);
  const base = new URL(process.env.BITRIX_REST_BASE);
  if (base.protocol !== 'https:' || base.hostname !== 'dinalnsk.bitrix24.ru' || base.username || base.password || base.port
      || base.search || base.hash || !/^\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(base.pathname)) throw new Error('Адрес Битрикса запрещён');
  const limiter = createBitrixLimiter();
  const client = createBitrixClient({ baseUrl: base.toString(), limiter });
  const report = await runAudioCommand({ dealId, activityId, model, apiKey: process.env.POLZA_API_KEY, client, clip, clipFormat, closeLimiter: () => limiter.close() });
  console.log(JSON.stringify(sealEvidenceReport(report, publicKey)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('Защищённая проверка не завершена'); process.exitCode = 1;
});
