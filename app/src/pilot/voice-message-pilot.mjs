// Изолированная ручная проверка одного голосового сообщения. Только чтение
// Битрикса; функция не запускает обработчик сделки и не пишет в CRM или БД.
import { createHash } from 'node:crypto';
import { exactMillisTimestamp } from '../time-precision.mjs';
import { ambiguousProcessingOnly } from '../calls/transcript-quality.mjs';
import { createGeneralSessionVerifier } from './general-session-verifier.mjs';
import { createSessionLookup } from './general-session-lookup.mjs';

const MAX_WINDOW = 366 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 10 * 1024 * 1024;
const MIN_BYTES = 1024;
const AUDIO_EXTENSIONS = new Set(['ogg', 'oga', 'opus', 'mp3', 'wav', 'm4a']);
const identifier = value => {
  const text = String(value ?? '');
  return /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
};
const instant = value => exactMillisTimestamp(value)?.getTime() ?? null;
function explicitlyNonAudio(info) {
  return [info?.TYPE, info?.type, info?.CONTENT_TYPE, info?.contentType, info?.MIME_TYPE, info?.mimeType]
    .some(value => typeof value === 'string' && /^(?:image|video)(?:\/|$)/i.test(value.trim()));
}
function hashObject(value) {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string' || text.length > 5_000_000) return null;
    return createHash('sha256').update(text).digest('hex');
  } catch { return null; }
}

function restrictedClient(client, { deal, chat, session, file, line, from, cutoff, maxPages, signal }) {
  let calls = 0;
  return Object.freeze({ async request(method, body = {}, options = {}) {
    signal?.throwIfAborted();
    if (++calls > 600) throw new Error('Превышен предел чтений Битрикса');
    const keys = Object.keys(body).sort().join(',');
    let allowed = method === 'crm.deal.get' && keys === 'id' && identifier(body.id) === deal;
    if (method === 'crm.stagehistory.list') allowed = keys === 'entityTypeId,filter,order,select,start'
      && body.entityTypeId === 2 && Object.keys(body.filter || {}).join(',') === 'OWNER_ID'
      && identifier(body.filter.OWNER_ID) === deal && JSON.stringify(body.order) === '{"CREATED_TIME":"DESC"}'
      && JSON.stringify(body.select) === '["ID","STAGE_ID","CREATED_TIME"]'
      && Number.isSafeInteger(body.start) && body.start >= 0 && body.start < 1000;
    if (method === 'imopenlines.crm.chat.get') allowed = keys === 'ACTIVE_ONLY,CRM_ENTITY,CRM_ENTITY_TYPE'
      && body.CRM_ENTITY_TYPE === 'deal' && identifier(body.CRM_ENTITY) === deal && body.ACTIVE_ONLY === 'N';
    if (method === 'imopenlines.session.history.get') allowed = (keys === 'CHAT_ID' && identifier(body.CHAT_ID) === chat)
      || (keys === 'SESSION_ID' && identifier(body.SESSION_ID) === session);
    if (method === 'imopenlines.v2.Session.list') allowed = keys === 'configId,dateCreateFrom,dateCreateTo,limit,offset,order,orderDirection'
      && identifier(body.configId) === line && body.dateCreateFrom === from && body.dateCreateTo === cutoff
      && body.limit === 200 && Number.isSafeInteger(body.offset) && body.offset >= 0 && body.offset % 200 === 0
      && body.offset < maxPages * 200 && body.order === 'dateCreate' && body.orderDirection === 'desc';
    if (method === 'disk.file.get') allowed = keys === 'id' && identifier(body.id) === file;
    if (!allowed) throw new Error('Метод чтения вне выбранного голосового запрещён');
    const combined = signal && options.signal ? AbortSignal.any([signal, options.signal]) : signal || options.signal;
    const response = await client.request(method, body, { ...options, ...(combined ? { signal: combined } : {}) });
    signal?.throwIfAborted();
    return response;
  } });
}

function selectedMessage(history, { chat, session, message, file, cutoff }) {
  if (!history || identifier(history.chatId) !== chat || identifier(history.sessionId) !== session
      || !history.chat || !Object.hasOwn(history.chat, chat) || !history.message
      || typeof history.message !== 'object') return null;
  const matches = Object.entries(history.message).filter(([key, item]) => identifier(item?.id ?? item?.ID ?? key) === message);
  if (matches.length !== 1) return null;
  const item = matches[0][1], raw = item?.params?.FILE_ID ?? item?.params?.fileId;
  const files = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  if (files.length !== 1 || identifier(files[0]) !== file) return null;
  const metadata = history.files && typeof history.files === 'object'
    ? Object.entries(history.files).filter(([key, value]) => identifier(value?.id ?? value?.ID ?? key) === file) : [];
  if (metadata.length > 1 || metadata.some(([, value]) => !value || typeof value !== 'object' || explicitlyNonAudio(value))) return null;
  const date = instant(item?.date ?? item?.DATE);
  if (date === null || date > cutoff) return null;
  const entity = history.chat[chat]?.entityId;
  const parts = typeof entity === 'string' && entity.length < 1024 ? entity.split('|') : [];
  if (parts.length !== 4 || !parts.every(x => x && x.trim() === x) || !identifier(parts[1])) return null;
  return { line: identifier(parts[1]), date, entity };
}

function selectedFile(response, file, restBase) {
  const info = response?.result;
  if (!info || typeof info !== 'object' || Array.isArray(info) || identifier(info.ID ?? info.id) !== file) return null;
  const name = info.NAME ?? info.name;
  if (typeof name !== 'string' || name.length > 255 || /[\\/\x00-\x1f]/.test(name)) return null;
  const extension = /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension)) return null;
  if (explicitlyNonAudio(info)) return null;
  const size = info.SIZE ?? info.size;
  if (size != null && (!Number.isSafeInteger(Number(size)) || Number(size) < MIN_BYTES || Number(size) > MAX_BYTES)) return null;
  let url;
  try { url = new URL(info.DOWNLOAD_URL ?? info.urlDownload ?? info.url); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== restBase.origin || url.port || url.username || url.password || url.hash
      || url.pathname !== `${restBase.pathname.replace(/\/$/, '')}/download/`
      || [...url.searchParams.keys()].length !== 1 || !url.searchParams.has('token')) return null;
  const token = url.searchParams.get('token');
  if (!token || token.length > 4096 || /[\x00-\x1f\x7f]/.test(token)) return null;
  // Bitrix может выдавать новый token при каждом disk.file.get. URL каждый
  // раз проверяем отдельно, а стабильные метаданные сравниваем без него.
  // Совпадение этих полей не доказывает неизменность содержимого файла.
  const stable = Object.fromEntries(Object.entries(info).filter(([key]) => !['DOWNLOAD_URL','urlDownload','url'].includes(key)));
  const snapshot = hashObject(stable);
  return snapshot ? { extension, url: url.href, snapshot, declaredSize: size == null ? null : Number(size) } : null;
}

async function downloadSelected(url, { fetchImpl, signal }) {
  const response = await fetchImpl(url, { method: 'GET', redirect: 'error', ...(signal ? { signal } : {}) });
  if (!response || response.status !== 200 || !response.body) throw new Error('Запись недоступна');
  const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (/^(?:text\/html|application\/json|image\/|video\/)/.test(type)) throw new Error('Получен не аудиофайл');
  const length = response.headers?.get?.('content-length');
  if (length != null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new Error('Некорректный размер записи');
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      const copy = Buffer.from(chunk); size += copy.length;
      if (size > MAX_BYTES) { copy.fill(0); throw new Error('Слишком большая запись'); }
      chunks.push(copy);
    }
    if (size < MIN_BYTES || (length != null && size !== Number(length))) throw new Error('Неполная запись');
    return Buffer.concat(chunks, size);
  } finally { for (const chunk of chunks) chunk.fill(0); }
}

/**
 * Вызывающий код — доверенный: client выполняет read-only Bitrix REST,
 * inspectAudio локально проверяет байты, transcribeAudio отправляет только их
 * в STT и контролирует бюджет. Результат содержит transcript и должен оставаться
 * в памяти или защищённом локальном хранилище. Полнота истории не доказана.
 */
export async function runVoiceMessagePilot({ dealId, transitionId, chatId, sessionId, messageId, fileId,
  cutoff, from, bitrixRestBase, client, fetchImpl = fetch, inspectAudio, transcribeAudio,
  maxPages = 20, maxDurationSec = 120, signal } = {}) {
  const deal = identifier(dealId), transition = identifier(transitionId), chat = identifier(chatId),
    session = identifier(sessionId), message = identifier(messageId), file = identifier(fileId);
  const cutoffMs = instant(cutoff), fromMs = instant(from);
  let restBase;
  try { restBase = new URL(bitrixRestBase); } catch { throw new TypeError('Некорректный адрес Битрикса'); }
  if (!deal || !transition || !chat || !session || !message || !file || cutoffMs === null || fromMs === null
      || fromMs > cutoffMs || cutoffMs - fromMs > MAX_WINDOW || restBase.protocol !== 'https:'
      || restBase.hostname !== 'dinalnsk.bitrix24.ru' || restBase.port || restBase.username || restBase.password
      || restBase.search || restBase.hash || !/^\/rest\/[1-9]\d{0,15}\/[A-Za-z0-9]+\/?$/.test(restBase.pathname)
      || !client || typeof client.request !== 'function' || typeof fetchImpl !== 'function'
      || typeof inspectAudio !== 'function' || typeof transcribeAudio !== 'function'
      || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20
      || !Number.isFinite(maxDurationSec) || maxDurationSec <= 0 || maxDurationSec > 120
      || !signal || typeof signal.throwIfAborted !== 'function' || typeof signal.addEventListener !== 'function'
      || typeof signal.aborted !== 'boolean') throw new TypeError('Неполные ограничения ручной проверки');
  signal?.throwIfAborted();
  const start = new Date(fromMs).toISOString(), end = new Date(cutoffMs).toISOString();
  // Первое чтение имеет фиксированные chatId и метод: оно не получает файлов.
  let reads = 0;
  const bootstrap = Object.freeze({ async request(method, body, options) {
    if (++reads !== 1 || method !== 'imopenlines.session.history.get' || Object.keys(body || {}).join(',') !== 'CHAT_ID'
        || identifier(body.CHAT_ID) !== chat) throw new Error('Неверный первый запрос');
    return client.request(method, body, { ...options, ...(signal ? { signal } : {}) });
  } });
  const initial = (await bootstrap.request('imopenlines.session.history.get', { CHAT_ID: Number(chat) }))?.result;
  const selected = selectedMessage(initial, { chat, session, message, file, cutoff: cutoffMs });
  const historyHash = hashObject(initial);
  if (!selected || !historyHash) throw new Error('Выбранное голосовое не подтверждено в истории');
  const reader = restrictedClient(client, { deal, chat, session, file, line: selected.line, from: start, cutoff: end, maxPages, signal });
  const lookup = createSessionLookup({ client: reader, from: start, maxPages, signal });
  const verifier = createGeneralSessionVerifier({ client: reader, lookupSession: lookup, dealId: deal, transitionId: transition, purpose: 'session_identity' });
  const verify = async () => {
    signal?.throwIfAborted();
    const history = (await reader.request('imopenlines.session.history.get', { CHAT_ID: Number(chat) }))?.result;
    const selection = selectedMessage(history, { chat, session, message, file, cutoff: cutoffMs });
    if (!selection || selection.line !== selected.line || selection.entity !== selected.entity
        || hashObject(history) !== historyHash) throw new Error('История выбранного голосового изменилась');
    const proof = await verifier(Object.freeze({ deal_id: deal, chat_id: chat, session_id: session, line_id: selected.line,
      cutoff: end, history_sha256: historyHash, history }));
    if (!proof || proof.kind !== 'verified_fallback_session_v1' || proof.history_sha256 !== historyHash
        || proof.deal_id !== deal || proof.chat_id !== chat || proof.session_id !== session
        || proof.line_id !== selected.line || proof.cutoff !== end) throw new Error('Не подтверждена связь сессии со сделкой');
  };
  await verify();
  const meta = selectedFile(await reader.request('disk.file.get', { id: Number(file) }), file, restBase);
  if (!meta) throw new Error('Не подтверждены метаданные аудиофайла');
  const nextMeta = selectedFile(await reader.request('disk.file.get', { id: Number(file) }), file, restBase);
  if (!nextMeta || nextMeta.snapshot !== meta.snapshot) throw new Error('Метаданные аудиофайла изменились');
  await verify();
  let bytes;
  try {
    // Используем URL из самого свежего проверенного disk.file.get, а не
    // первоначальный токен, который к этому моменту мог устареть.
    bytes = await downloadSelected(nextMeta.url, { fetchImpl, signal });
    if (meta.declaredSize !== null && bytes.length !== meta.declaredSize) throw new Error('Размер записи изменился');
    signal?.throwIfAborted();
    const inspected = await inspectAudio(bytes, { extension: meta.extension, signal });
    signal.throwIfAborted();
    if (!inspected || !Number.isFinite(inspected.duration_sec) || inspected.duration_sec <= 0
        || inspected.duration_sec > maxDurationSec || inspected.channels !== 1 || inspected.audio_streams !== 1
        || inspected.video_streams !== 0 || inspected.other_streams !== 0) throw new Error('Аудиофайл не прошёл проверку состава и длительности');
    const digest = createHash('sha256').update(bytes).digest('hex');
    await verify();
    const finalMeta = selectedFile(await reader.request('disk.file.get', { id: Number(file) }), file, restBase);
    if (!finalMeta || finalMeta.snapshot !== meta.snapshot) throw new Error('Метаданные аудиофайла изменились');
    signal?.throwIfAborted();
    // Ни одного повторного вызова и повторного скачивания внутри пилота.
    const transcript = await transcribeAudio(bytes, { extension: meta.extension, channel_count: 1,
      speaker_role: 'Участник чата', duration_sec: inspected.duration_sec, signal });
    signal.throwIfAborted();
    if (!transcript || transcript.success !== true || typeof transcript.formatted_dialog !== 'string'
        || !transcript.formatted_dialog.trim()) throw new Error('Голосовое не распознано');
    if (ambiguousProcessingOnly(transcript)) throw new Error('Содержание голосового требует повторной проверки');
    return { status: 'unverified', delivery_permitted: false, history_complete: null,
      duration_sec: inspected.duration_sec, channels: inspected.channels, audio_sha256: digest,
      transcript, limitations: ['one_session_not_full_history', 'historical_file_identity_unverified',
        'speaker_role_unknown', 'no_delivery'] };
  } finally { bytes?.fill(0); }
}
