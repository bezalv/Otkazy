// Тихий ручной эксперимент с одним голосовым и опционально одним звонком. Модуль не создаёт
// очередь, не записывает результаты и не отправляет сообщения.
import { createHash } from 'node:crypto';
import { processDeal } from '../process-deal.mjs';
import { createSttClient, verifiedAudioOnly } from '../stt-client.mjs';
import { voiceFileSnapshot } from '../voice-file-metadata.mjs';
import { exactMillisTimestamp } from '../time-precision.mjs';
import { createGeneralSessionVerifier } from './general-session-verifier.mjs';
import { createSessionLookup } from './general-session-lookup.mjs';
import { createManualModelLimiter } from './manual-session-adapter.mjs';

const WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const id = value => {
  const text = String(value ?? '');
  return /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
};
const instant = value => exactMillisTimestamp(value)?.getTime() ?? null;
const noMedia = async () => { throw new Error('Прочие файлы и звонки отключены в ручном эксперименте'); };

function snapshot(value) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || text.length > 5_000_000) throw new Error('История недоступна');
  return createHash('sha256').update(text).digest('hex');
}

function recordedFileIds(row) {
  if (row?.FILES != null && typeof row.FILES !== 'object') return null;
  const files = row?.FILES && typeof row.FILES === 'object' ? Object.values(row.FILES) : [];
  if (files.some(file => !file || typeof file !== 'object'
      || !(file.urlDownload ?? file.URL_DOWNLOAD ?? file.url))) return null;
  const values = [row?.SETTINGS?.RECORD_URL, row?.RECORD_URL,
    ...files.map(file => file?.urlDownload ?? file?.URL_DOWNLOAD ?? file?.url)].filter(Boolean);
  const recordFile = row?.RECORD_FILE_ID == null || row?.RECORD_FILE_ID === '' ? null : id(row.RECORD_FILE_ID);
  if (row?.RECORD_FILE_ID && !recordFile) return null;
  if (recordFile && !values.length) return null;
  const result = [];
  for (const value of values) {
    let url; try { url = new URL(String(value)); } catch { return null; }
    const values = url.searchParams.getAll('fileId');
    if (!['http:', 'https:'].includes(url.protocol) || values.length !== 1 || !id(values[0])) return null;
    result.push(id(values[0]));
  }
  for (const file of files) {
    const rawId = file.id ?? file.ID;
    if (rawId == null) continue;
    let fileUrl; try { fileUrl = new URL(String(file.urlDownload ?? file.URL_DOWNLOAD ?? file.url)); } catch { return null; }
    if (!id(rawId) || id(rawId) !== id(fileUrl.searchParams.get('fileId'))) return null;
  }
  if (recordFile) result.push(recordFile);
  return result;
}

function legacyFileType(file) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) return null;
  const hints = new Set();
  for (const value of [file.type, file.TYPE, file.mimeType, file.mime_type, file.MIME_TYPE, file.contentType, file.CONTENT_TYPE]) {
    const type = String(value ?? '').trim().toLowerCase().split(';')[0];
    if (!type || ['file','document','application/octet-stream'].includes(type)) continue;
    if (/^image(?:\/|$)/.test(type)) hints.add('image');
    else if (/^video(?:\/|$)/.test(type)) hints.add('video');
    else if (type === 'pdf' || type === 'application/pdf') hints.add('pdf');
    else return null;
  }
  const extensions = [String(file.extension ?? '').toLowerCase().replace(/^\./, ''),
    ...[file.name, file.NAME].map(name => /\.([a-z0-9]+)$/i.exec(String(name ?? ''))?.[1]?.toLowerCase() || '')];
  for (const ext of extensions.filter(Boolean)) {
    if (['jpg','jpeg','png','gif','webp','bmp','heic','heif'].includes(ext)) hints.add('image');
    else if (['mp4','mov','webm','avi','mkv','mpeg','mpg','m4v'].includes(ext)) hints.add('video');
    else if (ext === 'pdf') hints.add('pdf');
    else return null;
  }
  return hints.size === 1 ? [...hints][0] : null;
}

function legacyCaption(row) {
  return String(row?.text ?? row?.TEXT ?? '')
    .replace(/^\s*(?:\[(?:B|I|U|S)\]\s*)*===\s*(?:Исходящее|Входящее)\s+сообщение(?:\s*,[^=\r\n]*)?\s*===/i, '')
    .replace(/===\s*(?:Исходящее|Входящее)\s+сообщение[^=]*===/g, '')
    .replace(/=== SYSTEM WZ ===[^\n]*/g, '').replace(/\[\/?\w[\w= ]*\]/g, '').replace(/\p{Cf}/gu, '')
    .replace(/^>>.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Проверяем только явно выбранные непроанализированные файлы конкретных
// сообщений. По названию или ID без текущих метаданных тип не предполагаем.
function verifyLegacyMedia(history, bound, chat, session) {
  const files = history?.files && typeof history.files === 'object' ? Object.entries(history.files) : [];
  const rows = history?.message && typeof history.message === 'object' ? Object.entries(history.message) : [];
  const same = chat === bound.selected.chat && session === bound.selected.session;
  for (const [key, file] of files) {
    const fileId = id(file?.id ?? file?.ID ?? (Array.isArray(history.files) ? null : key));
    if (fileId === bound.selected.file && same) continue;
    const expected = bound.legacy.get(fileId);
    if (!same || !expected || legacyFileType(file) !== expected.type) throw new Error('В истории есть непроверенный файл');
  }
  for (const [key, row] of rows) {
    const value = row?.params?.FILE_ID ?? row?.params?.fileId ?? [];
    const refs = (Array.isArray(value) ? value : [value]).filter(x => x != null && String(x) !== '' && String(x) !== '0');
    for (const value of refs) {
      const fileId = id(value);
      if (fileId === bound.selected.file && same) continue;
      const expected = bound.legacy.get(fileId);
      const when = instant(row?.date ?? row?.DATE);
      if (!same || !expected || id(row?.id ?? row?.ID ?? key) !== expected.message || refs.length !== 1) {
        throw new Error('В истории есть непроверенное вложение');
      }
      if (when === null || when > bound.cutoffMs) throw new Error('Дата вложения не подтверждена');
    }
    const text = String(row?.text ?? row?.TEXT ?? '');
    if (/https?:\/\/\S+\.(?:mp3|mpga|ogg|opus|wav|m4a|oga|png|jpe?g|gif|webp|mp4|mov|pdf)(?:[?#\s\]]|$)/i.test(text)) {
      throw new Error('В истории есть ссылка на файл');
    }
  }
  if (!same) return;
  const totals = { image: 0, video: 0, pdf: 0 }, empty = [];
  for (const [fileId, expected] of bound.legacy) {
    const metadata = files.filter(([key, file]) => id(file?.id ?? file?.ID ?? (Array.isArray(history.files) ? null : key)) === fileId);
    const messages = rows.filter(([key, row]) => {
      const value = row?.params?.FILE_ID ?? row?.params?.fileId ?? [];
      return id(row?.id ?? row?.ID ?? key) === expected.message && (Array.isArray(value) ? value : [value]).some(x => id(x) === fileId);
    });
    if (metadata.length !== 1 || messages.length !== 1 || legacyFileType(metadata[0][1]) !== expected.type) {
      throw new Error('Перечень вложений не подтверждён историей');
    }
    totals[expected.type]++;
    if (!legacyCaption(messages[0][1])) empty.push(expected.message);
  }
  bound.legacySummary = { total: bound.legacy.size, types: totals, empty_captions: empty.length };
}

// Проверка требует ровно одно сообщение и один FILE_ID. Её применение не
// доказывает, что остальные сессии сделки получены полностью.
function selection(history, selected, cutoff) {
  if (!history || id(history.chatId) !== selected.chat || id(history.sessionId) !== selected.session
      || !history.chat?.[selected.chat] || !history.message || typeof history.message !== 'object') return null;
  const rows = Object.entries(history.message);
  const matches = rows.filter(([key, row]) => id(row?.id ?? row?.ID ?? key) === selected.message);
  if (matches.length !== 1) return null;
  const references = rows.filter(([, row]) => {
    const value = row?.params?.FILE_ID ?? row?.params?.fileId ?? [];
    return (Array.isArray(value) ? value : [value]).some(x => id(x) === selected.file);
  });
  const row = matches[0][1], rawFiles = row?.params?.FILE_ID ?? row?.params?.fileId;
  const files = Array.isArray(rawFiles) ? rawFiles : rawFiles == null ? [] : [rawFiles];
  if (references.length !== 1 || references[0][1] !== row || files.length !== 1 || id(files[0]) !== selected.file
      || instant(row?.date ?? row?.DATE) === null || instant(row?.date ?? row?.DATE) > cutoff) return null;
  const entity = history.chat[selected.chat].entityId;
  const parts = typeof entity === 'string' && entity.length <= 1024 ? entity.split('|') : [];
  const line = parts.length === 4 && parts.every(part => part && part.trim() === part) ? id(parts[1]) : null;
  return line ? { line, entity, date: row.date ?? row.DATE } : null;
}

// Названия и права только read-only. Список методов не даёт возможности
// записать комментарий, отправить сообщение или изменить сделку.
function scopedReader(client, bound, signal) {
  const chats = new Set(), sessions = new Set(), lines = new Set(); let calls = 0, latestDownload = null;
  const selected = bound.selected;
  return {
    get lastDownload() { return latestDownload; },
    async request(method, body = {}, options = {}) {
      signal.throwIfAborted();
      if (++calls > 800) throw new Error('Превышен предел чтений');
      const f = body.filter || {}; let allowed = false;
      if (method === 'crm.deal.userfield.list') allowed = f.FIELD_NAME === 'UF_CRM_1584703948317';
      else if (method === 'crm.deal.get') allowed = id(body.id) === bound.deal;
      else if (method === 'crm.stagehistory.list') allowed = Number(body.entityTypeId) === 2 && id(f.OWNER_ID) === bound.deal;
      else if (method === 'crm.activity.list') allowed = Number(f.OWNER_TYPE_ID) === 2 && id(f.OWNER_ID) === bound.deal;
      else if (method === 'crm.timeline.comment.list') allowed = id(f.ENTITY_ID) === bound.deal && f.ENTITY_TYPE === 'deal';
      else if (method === 'tasks.task.list') allowed = Array.isArray(f.UF_CRM_TASK) && f.UF_CRM_TASK.length === 1 && f.UF_CRM_TASK[0] === `D_${bound.deal}`;
      else if (method === 'imopenlines.crm.chat.get') allowed = body.CRM_ENTITY_TYPE === 'deal' && id(body.CRM_ENTITY) === bound.deal && body.ACTIVE_ONLY === 'N';
      else if (method === 'imopenlines.session.history.get') {
        const chat = id(body.CHAT_ID), session = id(body.SESSION_ID);
        allowed = Object.keys(body).length === 1 && Boolean(chat && chats.has(chat) || session && sessions.has(session));
      } else if (method === 'imopenlines.v2.Session.list') {
        const line = id(body.configId);
        allowed = Object.keys(body).sort().join(',') === 'configId,dateCreateFrom,dateCreateTo,limit,offset,order,orderDirection'
          && !!line && lines.has(line) && body.dateCreateFrom === bound.from && body.dateCreateTo === bound.cutoff
          && body.limit === 200 && Number.isSafeInteger(body.offset) && body.offset >= 0 && body.offset % 200 === 0
          && body.offset < bound.maxPages * 200 && body.order === 'dateCreate' && body.orderDirection === 'desc';
      } else if (method === 'disk.file.get') allowed = Object.keys(body).length === 1 && bound.mediaAllowed
        && (id(body.id) === selected.file || Boolean(bound.call && bound.callSeen && id(body.id) === bound.call.file));
      if (!allowed) throw new Error('Метод чтения вне выбранной сделки запрещён');
      const combined = options.signal ? AbortSignal.any([signal, options.signal]) : signal;
      const response = await client.request(method, body, { ...options, signal: combined });
      signal.throwIfAborted();
      // В этом опыте один голосовой — единственный разрешённый медиаисточник.
      // Не вызывать судью, если требуется изучить другие файлы/записи.
      if (method === 'crm.activity.list' && Number(f.TYPE_ID) === 2 && Array.isArray(response?.result)) {
        for (const row of response.result) {
          const fileIds = recordedFileIds(row);
          if (fileIds === null || (row?.FILES && Object.keys(row.FILES).length && !fileIds.length)) throw new Error('Запись звонка не подтверждена');
          if (!fileIds.length) continue;
          if (!bound.call || id(row?.ID) !== bound.call.activity || fileIds.some(file => file !== bound.call.file)) {
            throw new Error('Доступны другие записи звонков');
          }
          const hash = snapshot(row);
          if (bound.callSeen && bound.callSeen !== hash) throw new Error('Данные звонка изменились');
          bound.callSeen = hash;
        }
        if (bound.call && (response.next === undefined || response.next === null || response.next === false) && !bound.callSeen) {
          throw new Error('Выбранный звонок не найден в сделке');
        }
      }
      if (method === 'crm.timeline.comment.list' && Array.isArray(response?.result)
          && response.result.some(row => (row?.FILES && Object.keys(row.FILES).length)
            || /\[(?:\/?img|disk\s+file)(?:[\s=\]])/i.test(String(row?.COMMENT ?? '')))) {
        throw new Error('В комментариях есть необработанные файлы');
      }
      if (method === 'imopenlines.crm.chat.get' && Array.isArray(response?.result)) {
        for (const row of response.result) { const value = id(row?.CHAT_ID); if (value) chats.add(value); }
      }
      if (method === 'crm.activity.list' && f.PROVIDER_ID === 'IMOPENLINES_SESSION' && Array.isArray(response?.result)) {
        for (const row of response.result) { const value = id(row?.ASSOCIATED_ENTITY_ID); if (value) sessions.add(value); }
      }
      if (method === 'imopenlines.session.history.get') {
        const history = response?.result, chat = id(history?.chatId), session = id(history?.sessionId);
        if (bound.legacyEnabled) verifyLegacyMedia(history, bound, chat, session);
        if (history?.files && typeof history.files === 'object'
            && Object.entries(history.files).some(([key, file]) => id(file?.id ?? file?.ID ?? key) === selected.file)
            && (chat !== selected.chat || session !== selected.session)) throw new Error('Файл обнаружен вне выбранной сессии');
        if (!bound.legacyEnabled && history?.files && typeof history.files === 'object'
            && Object.entries(history.files).some(([key, file]) => id(file?.id ?? file?.ID ?? key) !== selected.file)) {
          throw new Error('В истории есть другие файлы');
        }
        if (!bound.legacyEnabled && history?.message && typeof history.message === 'object'
            && Object.values(history.message).some(row => {
              const value = row?.params?.FILE_ID ?? row?.params?.fileId ?? [];
              const files = Array.isArray(value) ? value : [value];
              const text = String(row?.text ?? row?.TEXT ?? '');
              return files.some(value => value != null && String(value) !== '' && String(value) !== '0' && id(value) !== selected.file)
                || /https?:\/\/\S+\.(?:mp3|mpga|ogg|opus|wav|m4a|oga|png|jpe?g|gif|webp|mp4|mov|pdf)(?:[?#\s\]]|$)/i.test(text);
            })) throw new Error('В истории есть другие вложения');
        if (bound.expectedHistoryHash && chat === selected.chat && session === selected.session
            && snapshot(history) !== bound.expectedHistoryHash) throw new Error('История изменилась');
        if (id(body.CHAT_ID) === chat && chats.has(chat) && session) sessions.add(session);
        if (chat && chats.has(chat) && session && sessions.has(session)) {
          const entity = history?.chat?.[chat]?.entityId, parts = typeof entity === 'string' ? entity.split('|') : [];
          const line = parts.length === 4 && parts.every(part => part && part.trim() === part) ? id(parts[1]) : null;
          if (line) lines.add(line);
        }
        // Один и тот же файл в чужой сессии не может считаться выбранным.
        if (history?.message && typeof history.message === 'object') {
          const same = Object.values(history.message).some(row => {
            const value = row?.params?.FILE_ID ?? row?.params?.fileId ?? [];
            return (Array.isArray(value) ? value : [value]).some(x => id(x) === selected.file);
          });
          if (same && (chat !== selected.chat || session !== selected.session || !selection(history, selected, bound.cutoffMs))) {
            throw new Error('Файл обнаружен вне выбранного сообщения');
          }
        }
      }
      if (method === 'disk.file.get') {
        const data = response?.result, value = data?.DOWNLOAD_URL ?? data?.urlDownload ?? data?.url;
        let url; try { url = new URL(value); } catch { throw new Error('Не подтверждён адрес файла'); }
        if (id(data?.ID ?? data?.id) !== id(body.id) || url.protocol !== 'https:' || url.origin !== bound.restBase.origin
            || url.username || url.password || url.port || url.hash
            || url.pathname !== `${bound.restBase.pathname.replace(/\/$/, '')}/download/`
            || [...url.searchParams.keys()].length !== 1 || !url.searchParams.get('token')) {
          throw new Error('Не подтверждён адрес файла');
        }
        latestDownload = url.href;
      }
      return response;
    },
  };
}

/**
 * Все внешние адаптеры — доверенные. reserveRequest должен самостоятельно
 * обеспечивать контроль расходов на каждый запрос STT к Polza; этот модуль
 * не является денежным лимитером. В обработку передаются только выбранные
 * файлы. Другие записи не имитируются и блокируют вердикт.
 */
export async function runManualVoicePipeline({ dealId, expectedHistoryId, expectedLoseDate, from, chatId, sessionId,
  messageId, fileId, callActivityId = null, callFileId = null, bitrixRestBase, bitrix, llm, sttUrl, sttKey, reserveRequest,
  fetchImpl = globalThis.fetch, probeAudioOnly, tempRoot, judgeSystemPrompt, writerSystemPrompt,
  audioWaitEnabledAt, savedAudioWait = null, nowMs = null, clock = Date.now, wait, signal,
  maxPages = 20, repairProofErrors = false, legacyMediaMode = false, legacyMedia = null, silent, semanticChatRoles } = {}) {
  const deal = id(dealId), transition = id(expectedHistoryId), selected = {
    chat: id(chatId), session: id(sessionId), message: id(messageId), file: id(fileId),
  };
  const call = callActivityId == null && callFileId == null ? null : { activity: id(callActivityId), file: id(callFileId) };
  const legacy = new Map();
  if (typeof legacyMediaMode !== 'boolean' || (legacyMediaMode && (!Array.isArray(legacyMedia) || !legacyMedia.length || legacyMedia.length > 20))
      || (!legacyMediaMode && legacyMedia !== null)) throw new TypeError('Некорректный режим вложений');
  if (legacyMediaMode) for (const item of legacyMedia) {
    const file = id(item?.fileId), message = id(item?.messageId), type = item?.type;
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).sort().join(',') !== 'fileId,messageId,type' || !file || !message
        || !['image','video','pdf'].includes(type) || legacy.has(file) || file === selected.file
        || (call && file === call.file) || [...legacy.values()].some(value => value.message === message)
        || message === selected.message) throw new TypeError('Некорректный список вложений');
    legacy.set(file, { message, type });
  }
  const cutoffMs = instant(expectedLoseDate), fromMs = instant(from); let restBase;
  try { restBase = new URL(bitrixRestBase); } catch { throw new TypeError('Некорректный адрес Битрикса'); }
  if (silent !== true || semanticChatRoles !== true || !deal || !transition || Object.values(selected).some(x => !x)
      || (call && (!call.activity || !call.file || call.file === selected.file))
      || cutoffMs === null || fromMs === null || fromMs > cutoffMs || cutoffMs - fromMs > WINDOW_MS
      || restBase.protocol !== 'https:' || restBase.hostname !== 'dinalnsk.bitrix24.ru' || restBase.port
      || restBase.username || restBase.password || restBase.search || restBase.hash
      || !/^\/rest\/[1-9]\d{0,15}\/[A-Za-z0-9]+\/?$/.test(restBase.pathname)
      || !bitrix || typeof bitrix.request !== 'function' || !llm || typeof llm.complete !== 'function'
      || typeof fetchImpl !== 'function' || typeof reserveRequest !== 'function' || !signal || typeof signal.throwIfAborted !== 'function'
      || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20 || typeof repairProofErrors !== 'boolean') {
    throw new TypeError('Неполные ограничения ручного опыта');
  }
  signal.throwIfAborted();
  const bound = { deal, selected, call, callSeen: null, cutoffMs, from: new Date(fromMs).toISOString(), cutoff: new Date(cutoffMs).toISOString(),
    maxPages, restBase, legacy, legacyEnabled: legacyMediaMode, legacySummary: null, mediaAllowed: false };
  const reader = scopedReader(bitrix, bound, signal);
  const lookup = createSessionLookup({ client: reader, from: bound.from, maxPages, signal });
  const verifySession = createGeneralSessionVerifier({ client: reader, lookupSession: lookup, dealId: deal,
    transitionId: transition, purpose: 'session_identity' });
  // Подтверждаем чат до первого чтения истории: один номер чата без связи с
  // карточкой не является разрешением скачать или распознать вложение.
  await reader.request('imopenlines.crm.chat.get', { CRM_ENTITY_TYPE: 'deal', CRM_ENTITY: Number(deal), ACTIVE_ONLY: 'N' });
  const current = (await reader.request('imopenlines.session.history.get', { CHAT_ID: Number(selected.chat) }))?.result;
  const chosen = selection(current, selected, cutoffMs);
  if (!chosen) throw new Error('Выбранное голосовое не подтверждено');
  const historyHash = snapshot(current);
  bound.expectedHistoryHash = historyHash;
  const proof = await verifySession(Object.freeze({ deal_id: deal, chat_id: selected.chat, session_id: selected.session,
    line_id: chosen.line, cutoff: bound.cutoff, history_sha256: historyHash, history: current }));
  if (!proof || proof.history_sha256 !== historyHash || proof.session_id !== selected.session
      || proof.chat_id !== selected.chat || proof.deal_id !== deal || proof.line_id !== chosen.line) {
    throw new Error('Привязка выбранной сессии не подтверждена');
  }
  bound.mediaAllowed = true;
  let voiceCalls = 0, callCalls = 0, diskReads = 0, downloads = 0, voiceCompleted = false, callCompleted = false;
  const resolveFile = async file => {
    if (id(file) !== selected.file || ++diskReads > 1) throw new Error('Неизвестный файл запрещён');
    // Нельзя подменить историю между первичной проверкой и получением файла.
    const latest = (await reader.request('imopenlines.session.history.get', { CHAT_ID: Number(selected.chat) }))?.result;
    if (!selection(latest, selected, cutoffMs) || snapshot(latest) !== historyHash) throw new Error('История изменилась');
    const response = await reader.request('disk.file.get', { id: Number(selected.file) });
    const data = response?.result;
    bound.fileSnapshot = voiceFileSnapshot(data, selected.file);
    if (!bound.fileSnapshot) throw new Error('Не подтверждены метаданные голосового');
    return response;
  };
  const guardedFetch = async (url, options = {}) => {
    signal.throwIfAborted();
    if (++downloads > (call ? 2 : 1) || options.method !== 'GET' || String(url) !== reader.lastDownload) throw new Error('Неизвестный адрес файла');
    const combined = options.signal ? AbortSignal.any([signal, options.signal]) : signal;
    return fetchImpl(url, { ...options, redirect: 'error', signal: combined });
  };
  const guardedRequest = (url, options, callback) => reserveRequest(url, {
    ...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
  }, callback);
  const stt = createSttClient({ bitrix: reader, sttUrl, sttKey, reserveRequest: guardedRequest,
    fetchImpl: guardedFetch, ...(probeAudioOnly ? { probeAudioOnly } : {}), ...(tempRoot ? { tempRoot } : {}) });
  const transcribe = async meta => {
    if (call && id(meta?.activity_id) === call.activity && id(meta?.file_id) === call.file
        && Number(meta?.channel_count) === 2 && bound.callSeen && ++callCalls === 1) {
      const response = await reader.request('disk.file.get', { id: Number(call.file) });
      const fileSnapshot = voiceFileSnapshot(response?.result, call.file);
      if (!fileSnapshot) throw new Error('Не подтверждены метаданные звонка');
      const secured = { ...meta, require_audio_only: true, voice_file_snapshot: fileSnapshot };
      const result = await stt(secured);
      if (!verifiedAudioOnly(result, secured)) throw new Error('Звонок не прошёл проверку аудио');
      callCompleted = result.success === true && typeof result.formatted_dialog === 'string' && !!result.formatted_dialog.trim();
      return result;
    }
    if (++voiceCalls > 1 || id(meta?.file_id) !== selected.file || meta?.activity_id !== `chat_${selected.file}`
        || Number(meta?.channel_count) !== 1 || !bound.fileSnapshot
        || instant(meta.call_date) !== instant(chosen.date)) return noMedia();
    // Для Wappi с технически известными авторами нормализатор не запрашивает
    // семантическое подтверждение. Проверку содержимого всё равно требуем.
    const secured = { ...meta, require_audio_only: true, voice_file_snapshot: bound.fileSnapshot };
    const result = await stt(secured);
    if (!verifiedAudioOnly(result, secured)) throw new Error('Голосовое не прошло подтверждение аудио');
    voiceCompleted = result.success === true && typeof result.formatted_dialog === 'string' && !!result.formatted_dialog.trim();
    return result;
  };
  const restrictedModel = createManualModelLimiter(llm, { repairProofErrors, signal });
  const guardedModel = { async complete(body, options = {}) {
    if (options.role !== 'chat-role-inference' && (!voiceCompleted || (call && !callCompleted)
        || (legacyMediaMode && (!bound.legacySummary || bound.legacySummary.empty_captions > 0)))) {
      throw new Error('Не все выбранные аудиозаписи распознаны');
    }
    return restrictedModel.complete(body, options);
  } };
  const result = await processDeal({ dealId: Number(deal), bitrix: reader,
    llm: guardedModel, resolveFile, downloadFile: noMedia, transcribe,
    judgeSystemPrompt, writerSystemPrompt, audioWaitEnabledAt, savedAudioWait,
    silent: true, screenshots: false, semanticChatRoles: true, repairProofErrors,
    verifyFallbackSession: verifySession, verifyLatestSession: verifySession,
    expectedHistoryId: transition, expectedLoseDate: bound.cutoff, nowMs, clock, wait });
  signal.throwIfAborted();
  return { status: !voiceCompleted || (call && !callCompleted) || (legacyMediaMode && (!bound.legacySummary || bound.legacySummary.empty_captions > 0))
      ? 'blocked' : result.status === 'processed' ? 'unverified' : result.status, preliminary: result,
    ...(legacyMediaMode ? { unexamined_media: bound.legacySummary } : {}),
    delivery_permitted: false, history_complete: null, limitations: ['one_session_not_full_history',
      call ? 'selected_voice_and_call_only' : 'selected_voice_only', 'other_calls_and_attachments_not_processed', 'screenshots_disabled',
      ...(legacyMediaMode ? ['legacy_chat_media_contents_unexamined'] : []),
      ...(bound.legacySummary?.empty_captions ? ['legacy_empty_attachment_metrics_unverified'] : []),
      'semantic_roles_are_inference', 'no_delivery'] };
}
