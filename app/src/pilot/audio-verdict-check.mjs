// Только ручной машинный анализ оригинальных аудиобайтов пяти конкретных звонков.
// Никаких действий в CRM/БД и никакой отправки записей, кроме Polza.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBitrixClient } from '../bitrix-client.mjs';
import { createBitrixLimiter } from '../bitrix-limiter.mjs';
import { fileIdFromStoredUrl, withAudioInspectionResources } from './audio-inspect.mjs';
import { sealEvidenceReport } from './evidence-review.mjs';

const PAIRS = new Map([['96621', new Set(['1315693', '1317027', '1454929'])],
  ['126554', new Set(['1660320'])], ['126956', new Set(['1665898'])]]);
const MODELS = new Set(['xiaomi/mimo-v2.6-flash']);
const METHODS = new Set(['crm.activity.get', 'disk.file.get']);
const POLZA = 'https://api.polza.ai/api/v1';
const MAX_AUDIO = 15 * 1024 * 1024;
const MAX_JSON = 3 * 1024 * 1024;
const HTTP_CODES = new Set([400, 401, 403, 404, 408, 413, 415, 422, 429, 500, 502, 503, 504]);
const SAFE_ERRORS = new Set(['model_unavailable', 'audio_unavailable', 'unsupported_format', 'bitrix_error', 'deadline', 'unexpected_error',
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
export async function inspectOneAudio({ dealId, activityId, model, apiKey, client, fetchImpl = fetch, signal, onPhase = () => {} }) {
  requirePair(dealId, activityId);
  if (!MODELS.has(model) || typeof apiKey !== 'string' || !apiKey || !client || typeof client.request !== 'function'
      || typeof fetchImpl !== 'function' || typeof onPhase !== 'function' || !signal || typeof signal.throwIfAborted !== 'function') throw new Error('Параметры не подтверждены');
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
  let bytes;
  try {
    onPhase('audio_download');
    bytes = await safeStage(() => fetchAudio(download, { fetchImpl, signal }), 'audio_unavailable');
    const metadata = await safeStage(() => audioMetadata(bytes), 'unsupported_format');
    signal.throwIfAborted();
    const body = { model, temperature: 0, messages: [{ role: 'user', content: [
      { type: 'text', text: 'Проанализируй только приложенную аудиозапись. Не пользуйся готовой расшифровкой и не выноси вердикт по сделке. Передай буквальные ключевые фразы по порядку, отмечая, кто их произнёс только когда это слышно уверенно. Отдельно отметь, есть ли автоответчик, согласие или отказ, разговор о цене и конкуренте, действия менеджера и чем закончился разговор. Если не расслышал слово, роль или контекст — явно скажи об этом; не додумывай. Укажи, если раздельное прослушивание сторон невозможно.' },
      { type: 'input_audio', input_audio: { data: bytes.toString('base64'), format: metadata.format } },
    ] }] };
    onPhase('model_audio');
    const answer = await safeStage(async () => {
      const response = safeHttp(await fetchImpl(`${POLZA}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal }));
      const parsed = await boundedJson(response), content = parsed?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim() || content.length > 24000) throw new Error('Ответ модели недоступен');
      return content;
    }, 'model_unavailable');
    return { deal_id: dealId, activity_id: activityId, model, audio_metadata: metadata,
      machine_audio_analysis: answer, limitations: ['machine_audio_interpretation_not_human_listening', 'speaker_and_words_may_be_wrong', 'historical_file_identity_unverified'] };
  } finally { bytes?.fill(0); }
}

/** После завершения работы и закрытия limiter возвращает только ограниченный код ошибки. */
export async function runAudioCommand({ dealId, activityId, model, apiKey, client, fetchImpl = fetch, closeLimiter, deadlineMs = 150000 }) {
  requirePair(dealId, activityId);
  if (!MODELS.has(model) || typeof closeLimiter !== 'function') throw new Error('Параметры не подтверждены');
  let phase = 'model_check';
  const result = await withAudioInspectionResources({ run: async signal => {
    try { return await inspectOneAudio({ dealId, activityId, model, apiKey, client, fetchImpl, signal, onPhase: next => { phase = next; } }); }
    catch (error) { return { audio_error: true, phase, error_code: signal.aborted ? 'deadline' : SAFE_ERRORS.has(error?.code) ? error.code : 'unexpected_error' }; }
  }, closeLimiter, closePool: async () => {}, deadlineMs });
  return result.status === 'error' ? { status: 'error', phase, error_code: 'deadline', resources_closed: true, service_closed: true }
    : result.audio_error === true ? { status: 'error', phase: result.phase, error_code: result.error_code, resources_closed: true, service_closed: true }
      : { ...result, service_closed: result.resources_closed === true };
}

async function main() {
  if (process.argv.length !== 7 || process.argv[5] !== '--sealed') throw new Error('Требуется защищённый вывод');
  const [, , dealId, activityId, model, , publicKey] = process.argv;
  requirePair(dealId, activityId);
  if (!MODELS.has(model)) throw new Error('Модель не разрешена');
  // Проверяем ключ до любых сетевых запросов.
  sealEvidenceReport({ service_closed: true }, publicKey);
  const base = new URL(process.env.BITRIX_REST_BASE);
  if (base.protocol !== 'https:' || base.hostname !== 'dinalnsk.bitrix24.ru' || base.username || base.password || base.port
      || base.search || base.hash || !/^\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(base.pathname)) throw new Error('Адрес Битрикса запрещён');
  const limiter = createBitrixLimiter();
  const client = createBitrixClient({ baseUrl: base.toString(), limiter });
  const report = await runAudioCommand({ dealId, activityId, model, apiKey: process.env.POLZA_API_KEY, client, closeLimiter: () => limiter.close() });
  console.log(JSON.stringify(sealEvidenceReport(report, publicKey)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('Защищённая проверка не завершена'); process.exitCode = 1;
});
