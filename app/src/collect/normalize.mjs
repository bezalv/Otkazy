import { createHash } from 'node:crypto';
import { chatMillisTimestamp } from '../time-precision.mjs';
import { explicitNonAudio, voiceFileSnapshot } from '../voice-file-metadata.mjs';
import { verifiedAudioOnly } from '../stt-client.mjs';
import { ambiguousProcessingOnly } from '../calls/transcript-quality.mjs';
import { isMissedCallSystemMessage } from '../system-chat.mjs';

export class TemporalScopeError extends Error {
  constructor(source, reason) { super(reason); this.source = source; }
}

// Доказательство живёт только в памяти процесса; поля из ответа Битрикса и
// сериализованной коммуникации сами по себе не дают права на классификацию.
const verifiedFallbackEvents = new WeakMap();
// Статус полного распознавания выдаётся только самим нормализатором для
// подтверждённой сессии. Флаги в JSON или копии сообщения не являются proof.
const verifiedVoiceEvents = new WeakSet();
const AUDIO_EXTENSIONS = ['mp3', 'mpga', 'ogg', 'opus', 'wav', 'm4a', 'oga'];
const VOICE_SUPPORTED = ['ogg', 'oga', 'opus', 'mp3', 'mpga'];
const SYSTEM_PATTERNS = [
  'Начат новый диалог', 'Сделка прикреплена к диалогу', 'Контактная информация сохранена',
  'Переданы дополнительные данные', 'Обращение направлено на', 'Обращение перенаправлено на',
  'работу с диалогом', 'отказался от диалога', 'отказалась от диалога',
  'присоединился к диалогу', 'покинул диалог', 'Диалог переведен на',
  'Оценка диалога', 'Сессия закрыта', 'Сессия завершена',
  'Автоматическое завершение диалога', 'Создан новый лид', 'Создана новая сделка',
  'Создан новый контакт', '=== SYSTEM WZ ===', 'Сообщение изменено', 'Доп. объект',
  'Wazzup App', 'app.wazzup24.ru', 'по правилам очереди', 'Диалог снят с оператора',
  'Обращение возвращено в очередь', 'К чату присоединил',
];

function stripBbCodes(value) {
  return String(value || '').replace(/\[\/?\w[\w= ]*\]/g, '').trim();
}

const WAZZUP_PREFIX = /^\s*(?:\[(?:B|I|U|S)\]\s*)*===\s*(Исходящее|Входящее)\s+сообщение(?:\s*,[^=\r\n]*)?\s*===/i;

function cleanChatText(value, isWazzup = false) {
  return String(value || '')
    .replace(isWazzup ? WAZZUP_PREFIX : /===\s*(?:Исходящее|Входящее)\s+сообщение[^=]*===/g, '')
    .replace(/=== SYSTEM WZ ===[^\n]*/g, '')
    .replace(/\[\/?\w[\w= ]*\]/g, '')
    .replace(/^>>.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extension(value) {
  const match = String(value || '').split('?')[0].split('#')[0].match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
}

function audioLink(value) {
  const clean = stripBbCodes(value);
  if (!/^https?:\/\/\S+$/.test(clean)) return null;
  const ext = extension(clean);
  return AUDIO_EXTENSIONS.includes(ext) ? { url: clean, ext } : null;
}

function systemMessage(message, text, fileCount) {
  if (fileCount > 0) return false;
  const hasSender = message.senderid !== undefined && message.senderid !== null && String(message.senderid) !== '';
  const header = /=== (?:Исходящее|Входящее) сообщение/.test(text) || WAZZUP_PREFIX.test(String(text || ''));
  if (hasSender && String(message.senderid) === '0' && !header) return true;
  const clean = stripBbCodes(text);
  return isMissedCallSystemMessage(clean) || SYSTEM_PATTERNS.some(pattern => clean.includes(pattern));
}

function isAiComment(comment) {
  const text = String(comment.text || '');
  return text.includes('AI-анализ отказа') || text.includes('[B]:f09f948d:');
}

function userRole(user) {
  return user && (user.connector === true || user.extranet === true || user.externalAuthId === 'imconnector')
    ? 'Клиент' : 'Менеджер';
}

function confirmedBitrixManager(user) {
  return user?.active === true && user.connector === false && user.extranet === false
    && typeof user.externalAuthId === 'string' && user.externalAuthId.trim().length > 0
    && user.externalAuthId.trim().toLowerCase() !== 'imconnector';
}

function roleForMessage(message, text, users, isWazzup, connectorUnknown, connectorConflict, isWappi = false) {
  const senderId = String(message.senderid || message.SENDER_ID || message.author_id || message.AUTHOR_ID || '0');
  const user = senderId !== '0' ? users?.[senderId] : null;
  if (connectorConflict) return { role: 'unknown', author: 'Участник чата' };
  if (isWazzup) {
    const header = String(text || '').match(WAZZUP_PREFIX);
    const nextHeader = header && String(text).slice(header[0].length).match(WAZZUP_PREFIX);
    const conflict = nextHeader && nextHeader[1].toLowerCase() !== header[1].toLowerCase();
    if (header && !conflict && header[1].toLowerCase() === 'исходящее') {
      const name = header[0].match(/автор:\s*[^\n(]*\(([^)]+)\)/i);
      return { role: 'Менеджер', author: name?.[1]?.trim() || 'Менеджер' };
    }
    // Коннектор Wazzup использует один sender для сообщений обеих сторон.
    // Только подтверждённый активный пользователь Bitrix может служить исключением.
    if (!header && confirmedBitrixManager(user)) {
      return { role: 'Менеджер', author: user.name || user.firstName || 'Менеджер' };
    }
    return { role: 'unknown', author: 'Участник чата' };
  }
  if (connectorUnknown) {
    if (confirmedBitrixManager(user)) {
      return { role: 'Менеджер', author: user.name || user.firstName || 'Менеджер' };
    }
    return { role: 'unknown', author: 'Участник чата' };
  }
  // Формат заголовка Wazzup не является подтверждением направления Wappi.
  const author = !isWappi && text.match(/===\s*(?:Исходящее|Входящее)\s+сообщение,\s*автор:\s*[^(]*\(([^)]+)\)/);
  if (author) return { role: 'Менеджер', author: author[1].trim() };
  if (user) {
    const role = userRole(user);
    // У Wappi отсутствие признаков внешнего пользователя ещё не делает его
    // сотрудником. Сохраняем неопределённость, пока сотрудник не подтверждён.
    if (isWappi && role === 'Менеджер' && !confirmedBitrixManager(user)) {
      return { role: 'unknown', author: 'Участник чата' };
    }
    return { role, author: role === 'Клиент' ? 'Клиент' : (user.name || user.firstName || 'Менеджер') };
  }
  return { role: 'unknown', author: 'Участник чата' };
}

function fileList(value) {
  return value && typeof value === 'object' ? Object.values(value) : [];
}

function sessionFiles(value) {
  if (!value) return [];
  if (typeof value !== 'object') throw new Error('Некорректный список файлов открытой линии');
  return Object.entries(value).map(([key, file]) => {
    if (!file || typeof file !== 'object') throw new Error('Некорректный файл открытой линии');
    const id = file.id ?? file.ID ?? (Array.isArray(value) ? null : key);
    return id === null ? file : { ...file, id };
  });
}

function metadataExtension(file) {
  return String(file?.extension || '').toLowerCase().replace(/^\./, '') || extension(file?.name || file?.NAME);
}

function audioMetadata(file) {
  return file && !explicitNonAudio(file) && (String(file.type).toLowerCase() === 'audio'
    || String(file.type).toLowerCase().startsWith('audio/')
    || AUDIO_EXTENSIONS.includes(metadataExtension(file)));
}

function knownNonAudio(file) {
  if (!file) return false;
  if (explicitNonAudio(file)) return true;
  if (audioMetadata(file)) return false;
  const type = String(file.type || '').toLowerCase();
  const ext = metadataExtension(file);
  return type === 'image' || type === 'video' || type.startsWith('image/')
    || type.startsWith('video/') || Boolean(ext);
}

function validBitrixId(value) {
  return typeof value === 'number' ? Number.isSafeInteger(value) && value > 0
    : typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function safeId(value) {
  const s = String(value ?? '');
  return /^[1-9]\d{0,15}$/.test(s) && Number.isSafeInteger(Number(s)) ? s : null;
}

function strictTime(value) {
  return chatMillisTimestamp(value)?.getTime() ?? null;
}

function historySnapshot(history) {
  try {
    const serialized = JSON.stringify(history);
    if (typeof serialized !== 'string' || serialized.length > 5_000_000) return null;
    return { serialized, sha256: createHash('sha256').update(serialized).digest('hex') };
  } catch { return null; }
}

function lineId(history, chat) {
  const entity = history?.chat?.[chat]?.entityId;
  if (typeof entity !== 'string' || entity.length > 1024) return null;
  const parts = entity.split('|');
  if (parts.length !== 4 || parts.some(part => !part || part.trim() !== part)) return null;
  return safeId(parts[1]);
}

async function verifyFallback({ collection, session, chatId, meta, verifyFallbackSession }) {
  if (collection.silent !== true || typeof verifyFallbackSession !== 'function'
      || (!meta.isWazzup && !meta.isWappi)) return null;
  const deal = safeId(collection.deal_id), chat = safeId(chatId), history = session.history;
  const sessionId = safeId(history?.sessionId), cutoff = strictTime(collection.deal_data?.lose_date);
  const line = chat && lineId(history, chat);
  const explicitSession = session.session_id == null ? null : safeId(session.session_id);
  // activity-сессия из collectDeal содержит session_id и history.chatId,
  // тогда как fallback содержит chat_id. Оба формата подтверждаются историей
  // и единственной карточкой чата; явно заданный chat_id обязан совпадать.
  const explicitChat = session.chat_id == null ? null : safeId(session.chat_id);
  const matchingSessions = () => collection.raw.sessions.filter(item => safeId(item?.history?.chatId) === chat
    && safeId(item?.history?.sessionId) === sessionId);
  if ((session.session_id != null && explicitSession !== sessionId)
      || matchingSessions().length !== 1 || matchingSessions()[0] !== session) return null;
  if (!deal || !chat || !sessionId || cutoff === null || !line || safeId(history?.chatId) !== chat
      || (session.chat_id != null && explicitChat !== chat) || (explicitSession === null && explicitChat !== chat)
      || collection.raw.chats.filter(item => safeId(item?.CHAT_ID) === chat).length !== 1) return null;
  const snapshot = historySnapshot(history);
  if (!snapshot) return null;
  const matchingChat = collection.raw.chats.find(item => safeId(item?.CHAT_ID) === chat);
  const chatSnapshot = JSON.stringify(matchingChat);
  const chatStillMatches = () => {
    const found = collection.raw.chats.filter(item => safeId(item?.CHAT_ID) === chat);
    return found.length === 1 && found[0] === matchingChat && JSON.stringify(found[0]) === chatSnapshot
      && collection.silent === true && safeId(collection.deal_id) === deal
      && strictTime(collection.deal_data?.lose_date) === cutoff;
  };
  const request = Object.freeze({ deal_id: deal, chat_id: chat, session_id: sessionId, line_id: line,
    cutoff: new Date(cutoff).toISOString(), history_sha256: snapshot.sha256,
    history: JSON.parse(snapshot.serialized) });
  let proof;
  try { proof = await verifyFallbackSession(request); } catch { return null; }
  const current = historySnapshot(history);
  const checks = proof?.checks;
  const created = strictTime(proof?.session_created_at);
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || proof.kind !== 'verified_fallback_session_v1'
      || safeId(proof.deal_id) !== deal || safeId(proof.chat_id) !== chat
      || safeId(proof.session_id) !== sessionId || safeId(proof.line_id) !== line
      || strictTime(proof.cutoff) !== cutoff || proof.history_sha256 !== snapshot.sha256
      || created === null || created > cutoff
      || !checks || typeof checks !== 'object' || Array.isArray(checks)
      || checks.chat_bound_to_deal !== true || checks.session_matches_chat !== true
      || checks.session_matches_line !== true || checks.session_crm_matches_deal !== true
      || checks.direct_session_history_matches !== true || checks.current_chat_history_matches !== true
      || current?.sha256 !== snapshot.sha256 || session.history !== history || collection.silent !== true
      || collection.raw.chats.filter(item => safeId(item?.CHAT_ID) === chat).length !== 1
      || JSON.stringify(collection.raw.chats.find(item => safeId(item?.CHAT_ID) === chat)) !== chatSnapshot
      || safeId(collection.deal_id) !== deal
      || strictTime(collection.deal_data?.lose_date) !== cutoff
      || (session.chat_id == null ? null : safeId(session.chat_id)) !== explicitChat
      || (session.session_id == null ? null : safeId(session.session_id)) !== explicitSession
      || matchingSessions().length !== 1 || matchingSessions()[0] !== session
      || lineId(history, chat) !== line) return null;
  // Это подтверждение ОДНОЙ сессии; полноту предыдущей истории и смен линий
  // оно не доказывает. Проверяющий — доверенная внутренняя зависимость.
  return { deal, chat, sessionId, cutoff, history, sha256: snapshot.sha256, verifier:verifyFallbackSession,
    eventSession: explicitSession ?? `chat_${chat}`, explicitSession, explicitChat, matchingSessions, chatStillMatches, session, members: [] };
}

// Используется только классификатором в том же процессе. Копирование/JSON
// намеренно уничтожает подтверждение, даже если видимое поле осталось.
export function verifiedInferenceSession(event, { dealId, cutoff, cache } = {}) {
  const binding = verifiedFallbackEvents.get(event);
  let eventSnapshot;
  try { eventSnapshot = JSON.stringify(event); } catch { return null; }
  if (!binding || safeId(dealId) !== binding.deal || strictTime(cutoff) !== binding.cutoff
      || safeId(event.chat_id) !== binding.chat || safeId(event.inference_session_id) !== binding.sessionId
      || String(event.session_id) !== binding.eventSession || eventSnapshot !== binding.eventSnapshot
      || binding.session.history !== binding.history
      || (binding.session.session_id == null ? null : safeId(binding.session.session_id)) !== binding.explicitSession
      || (binding.session.chat_id == null ? null : safeId(binding.session.chat_id)) !== binding.explicitChat
      || !binding.chatStillMatches()
      || binding.matchingSessions().length !== 1 || binding.matchingSessions()[0] !== binding.session) return null;
  let valid = cache?.get(binding.history);
  if (valid === undefined) {
    valid = historySnapshot(binding.history)?.sha256 === binding.sha256;
    cache?.set(binding.history, valid);
  }
  return valid ? binding.sessionId : null;
}

// Полный набор видимых событий той же подтверждённой сессии, включая поздние.
// Одних корректных снимков отдельных элементов недостаточно: один можно удалить.
export function verifiedInferenceGroup(events, { dealId, cutoff } = {}) {
  if (!Array.isArray(events) || !events.length) return false;
  const binding = verifiedFallbackEvents.get(events[0]);
  if (!binding || !Array.isArray(binding.members) || binding.members.length !== events.length) return false;
  const actual = new Set(events);
  if (actual.size !== events.length || binding.members.some(item => !actual.has(item))) return false;
  const cache = new Map();
  return events.every(item => verifiedFallbackEvents.get(item)?.members === binding.members
    && verifiedInferenceSession(item, { dealId, cutoff, cache }) === binding.sessionId);
}

// Ограниченный клиент связывает все события с конкретным verifier перехода,
// а не только с совпадающей датой и номером сделки.
export function verifiedInferenceGroupForVerifier(events, scope, verifier) {
  if (typeof verifier !== 'function' || !verifiedInferenceGroup(events, scope)) return false;
  return events.every(event => verifiedFallbackEvents.get(event)?.verifier === verifier);
}

export function verifiedInferenceVoice(event, { dealId, cutoff, cache } = {}) {
  return verifiedVoiceEvents.has(event)
    && verifiedInferenceSession(event, { dealId, cutoff, cache }) !== null;
}

function callEvent(call) {
  if (call._historical_plan_only === true) return {
    type: 'task', date: call.CREATED,
    title: 'Запланированный звонок: ' + (call.SUBJECT || 'без темы') + ' (текущий срок: ' + call.START_TIME + ')',
    status: null, closed_date: null, responsible_id: call.RESPONSIBLE_ID,
    task_id: 'activity:' + call.ID, _historical_task_state_unknown: true, _historical_plan_only: true,
  };
  const audioUrl = call.SETTINGS?.RECORD_URL || null;
  const files = fileList(call.FILES).map(file => ({
    name: file.name || file.NAME,
    url: file.urlDownload || file.URL_DOWNLOAD || file.url || null,
    size: file.size || file.SIZE,
  })).filter(file => file.url);
  const created = call.CREATED || call.START_TIME;
  const scheduled = created && call.START_TIME
    && Math.abs(new Date(call.START_TIME).getTime() - new Date(created).getTime()) > 600000;
  return {
    type: 'call', date: call._historical_event_time || created, direction: call.DIRECTION === '2' ? 'outgoing' : 'incoming',
    subject: call.SUBJECT || '', duration_start: call.START_TIME,
    duration_end: scheduled ? call.START_TIME : call.END_TIME,
    responsible_id: call.RESPONSIBLE_ID, description: call.DESCRIPTION || '',
    provider: call.PROVIDER_ID || '', provider_type_id: call.PROVIDER_TYPE_ID || '',
    completed: call.COMPLETED || '', audio_url: audioUrl, audio_files: files,
    activity_id: call.ID, _needs_transcription: audioUrl || files.length > 0,
  };
}

function commentEvent(comment, screenshots) {
  const files = comment.FILES || {};
  const keys = Object.keys(files);
  const event = {
    type: 'comment', date: comment.CREATED, author_id: comment.AUTHOR_ID,
    text: comment.COMMENT || '', has_files: keys.length > 0, comment_id: comment.ID,
  };
  if (screenshots) {
    const shots = keys.flatMap(key => {
      const file = files[key];
      if (!file || String(file.type) !== 'image') return [];
      return [{
        file_id: file.id ?? key, name: file.name || '', date: file.date || null,
        width: file.image?.width || null, height: file.image?.height || null, size: file.size || null,
      }];
    });
    shots.sort((a, b) => {
      const diff = (a.date ? new Date(a.date).getTime() : 0) - (b.date ? new Date(b.date).getTime() : 0);
      return diff || String(a.name).localeCompare(String(b.name), 'ru', { numeric: true, sensitivity: 'base' });
    });
    if (shots.length) event.screenshots = shots;
  }
  return event;
}

function taskEvent(task, historicalScope) {
  return {
    type: 'task', date: task.createdDate || task.CREATED_DATE, title: task.title || task.TITLE,
    description: String(task.description || task.DESCRIPTION || '').substring(0, 500),
    status: historicalScope ? null : (task.status || task.STATUS), responsible_id: task.responsibleId || task.RESPONSIBLE_ID,
    created_by: task.createdBy || task.CREATED_BY, closed_date: historicalScope ? null : (task.closedDate || task.CLOSED_DATE),
    ...(historicalScope ? { _historical_task_state_unknown: true } : {}),
    task_id: task.id || task.ID,
  };
}

/** Подготовка коммуникаций из результата collectDeal. Все внешние действия внедряются вызывающим кодом. */
export async function normalizeCommunications({ collection, resolveFile, transcribeVoice, screenshots = true, verifyFallbackSession, temporalCutoff = null }) {
  if (collection?._status !== 'pending_normalization' || !collection.raw || !collection.deal_data) {
    throw new TypeError('Нужен полный результат первичного сбора');
  }
  const cutoff = temporalCutoff === null ? null : strictTime(temporalCutoff);
  if (temporalCutoff !== null && cutoff === null) throw new TemporalScopeError('openlines', 'Не подтверждена дата отказа');
  const withinCutoff = value => {
    if (cutoff === null) return true;
    const timestamp = strictTime(value);
    if (timestamp === null) throw new TemporalScopeError('openlines', 'Неизвестно время сообщения или файла');
    if (timestamp === cutoff) throw new TemporalScopeError('openlines', 'Порядок сообщения или файла и отказа не подтверждён');
    return timestamp < cutoff;
  };
  if (['calls', 'openlines', 'comments', 'tasks'].some(key => collection._sources?.[key]?.complete !== true)) {
    throw new Error('Источники сделки прочитаны не полностью');
  }
  const { raw } = collection;
  for (const key of ['calls', 'comments', 'tasks', 'chats', 'sessions']) {
    if (!Array.isArray(raw[key])) throw new TypeError(`Некорректный источник ${key}`);
  }
  for (const [items, getId] of [
    [raw.calls, item => item?.ID], [raw.comments, item => item?.ID],
    [raw.tasks, item => item?.id ?? item?.ID],
  ]) {
    const ids = new Set();
    for (const item of items) {
      const id = getId(item);
      if (!validBitrixId(id)) throw new Error('Источник содержит коммуникацию без устойчивого идентификатора');
      const normalizedId = String(id);
      if (ids.has(normalizedId)) throw new Error('Источник содержит повтор идентификатора коммуникации');
      ids.add(normalizedId);
    }
  }
  const chatMeta = new Map(raw.chats.map(chat => {
    const connector = String(chat.CONNECTOR_ID || '').trim() || 'unknown';
    const title = String(chat.CONNECTOR_TITLE || connector);
    const idIsWazzup = connector.toLowerCase().includes('wazzup') || connector.toLowerCase().startsWith('wz_');
    const titleIsWazzup = title.toLowerCase().includes('wazzup');
    const titleIsWappi = title.toLowerCase().includes('wappi');
    const conflict = (titleIsWazzup && !idIsWazzup) || (titleIsWappi && idIsWazzup);
    return [String(chat.CHAT_ID), {
      connector, title, connectorUnknown: connector.toLowerCase() === 'unknown' || conflict, connectorConflict: conflict,
      isWazzup: idIsWazzup && !conflict,
      isWappi: !conflict && (connector.toLowerCase().includes('wappi') || titleIsWappi),
    }];
  }));
  const messages = [];
  const messageIds = new Map();
  const ambiguousMessageSessions = new Set();
  const eventScopes = new WeakMap();
  // ID файла может встретиться в нескольких сессиях; связь с сообщением
  // учитывается только внутри той сессии, в которой файл найден.
  const orphanFiles = [];
  const fileSessions = new Map();
  function registerSessionFile(key, scope, referenced) {
    const previous = fileSessions.get(key) || [];
    if (previous.some(item => item.scope !== scope && (!referenced || !item.referenced))) {
      throw new Error('Неоднозначная привязка файла к сессии открытой линии');
    }
    previous.push({ scope, referenced });
    fileSessions.set(key, previous);
  }
  const audioItems = [];
  const voiceFailures = [];
  let systemDropped = 0;

  for (const session of raw.sessions) {
    const history = session.history;
    if (!history || typeof history !== 'object' || Array.isArray(history)) throw new Error('Некорректная история открытой линии');
    if (!history.message || typeof history.message !== 'object') throw new Error('В истории открытой линии нет списка сообщений');
    if (session.session_id != null && history.sessionId != null && String(session.session_id) !== String(history.sessionId)) {
      throw new Error('История открытой линии относится к другой сессии');
    }
    const historyChatIds = Object.keys(history.chat || {});
    const chatId = session.chat_id ?? history.chatId ?? (historyChatIds.length === 1 ? historyChatIds[0] : null);
    if (session.chat_id != null && history.chatId != null && String(session.chat_id) !== String(history.chatId)) {
      throw new Error('История открытой линии относится к другому чату');
    }
    if (chatId == null && (Object.keys(history.message).length || Object.keys(history.files || {}).length)) {
      throw new Error('Не подтверждён чат истории открытой линии');
    }
    if (chatId != null && historyChatIds.length && !Object.hasOwn(history.chat, String(chatId))) {
      throw new Error('Чат отсутствует в карте истории открытой линии');
    }
    const sessionId = session.session_id ?? `chat_${chatId}`;
    const sessionScope = `${chatId}:${safeId(history.sessionId) ?? sessionId}`;
    const meta = chatMeta.get(String(chatId)) || { connector: 'unknown', title: 'unknown', isWazzup: false, isWappi: false, connectorUnknown: true };
    const users = history.users || {};
    const files = sessionFiles(history.files);
    const linkedFiles = new Set(Object.values(history.message).flatMap(message => {
      const ids = message?.params?.FILE_ID ?? message?.params?.fileId ?? [];
      return (Array.isArray(ids) ? ids : [ids]).filter(value => value != null).map(String);
    }));
    // Если все Wappi-авторы уже известны, вторая проверка истории и поиск
    // сессии не нужны: семантический классификатор всё равно не вызывается.
    const hasWappiCandidate = meta.isWappi && (Object.values(history.message).some(message => {
      if (!message || typeof message !== 'object') return false;
      const text = message.text || message.TEXT || '';
      const params = message.params || {};
      const rawIds = params.FILE_ID || params.fileId || [];
      const ids = (Array.isArray(rawIds) ? rawIds : [rawIds])
        .filter(id => id != null && String(id) !== '' && String(id) !== '0');
      const count = ids.length + (!ids.length && audioLink(text) ? 1 : 0);
      if (systemMessage(message, text, count) || (!cleanChatText(text, false) && !count)) return false;
      return roleForMessage(message, text, users, false, meta.connectorUnknown, meta.connectorConflict, true).role === 'unknown';
    }) || files.some(file => {
      if (!audioMetadata(file) || file.id == null || linkedFiles.has(String(file.id))) return false;
      const user = users[String(file.authorid ?? '0')];
      return !user || (userRole(user) === 'Менеджер' && !confirmedBitrixManager(user));
    }));
    const verified = (!meta.isWappi || hasWappiCandidate)
      ? await verifyFallback({ collection, session, chatId, meta, verifyFallbackSession }) : null;
    const sessionMessageStart = messages.length;
    const sessionFileRefs = new Set();
    const byId = new Map(files.filter(file => file && file.id != null).map(file => [String(file.id), file]));
    for (const [key, message] of Object.entries(history.message || {})) {
      if (!message || typeof message !== 'object') throw new Error('Некорректное сообщение открытой линии');
      if (message.id == null && message.ID == null && (Array.isArray(history.message) || !/^\d+$/.test(key))) {
        throw new Error('У сообщения открытой линии нет устойчивого идентификатора');
      }
      const rawMessageId = message.id ?? message.ID ?? key;
      if (!validBitrixId(rawMessageId)) throw new Error('У сообщения открытой линии нет устойчивого идентификатора');
      const messageId = String(rawMessageId);
      const identity = `${chatId ?? `session_${sessionId}`}:${messageId}`;
      const text = message.text || message.TEXT || '';
      const params = message.params || {};
      const fileIds = params.FILE_ID || params.fileId || [];
      const ids = [...new Set((Array.isArray(fileIds) ? fileIds : [fileIds])
        .filter(id => id != null && String(id) !== '' && String(id) !== '0').map(String))];
      for (const fileId of ids) sessionFileRefs.add(fileId);
      const fingerprint = JSON.stringify([
        text, [...ids].sort(), message.senderid ?? null, message.SENDER_ID ?? null,
        message.author_id ?? null, message.AUTHOR_ID ?? null, message.date ?? message.DATE ?? null,
      ]);
      if (messageIds.has(identity)) {
        const previous = messageIds.get(identity);
        if (previous.fingerprint !== fingerprint) throw new Error('Версии сообщения открытой линии расходятся');
        if (previous.sessionScope !== sessionScope) {
          ambiguousMessageSessions.add(previous.sessionScope);
          ambiguousMessageSessions.add(sessionScope);
        }
        continue;
      }
      messageIds.set(identity, { fingerprint, sessionScope });
      const link = ids.length ? null : audioLink(text);
      const count = ids.length + (link ? 1 : 0);
      if (systemMessage(message, text, count)) { systemDropped++; continue; }
      const { role, author } = roleForMessage(message, text, users, meta.isWazzup, meta.connectorUnknown, meta.connectorConflict, meta.isWappi);
      const cleaned = link ? '' : cleanChatText(text, meta.isWazzup);
      if (!cleaned && !count) continue;
      // Ссылки на файлы регистрируются выше, даже когда сообщение позднее
      // отказа: иначе вложение станет orphan и попадёт на транскрибацию.
      if (!withinCutoff(message.date || message.DATE || null)) continue;
      if (cutoff !== null) {
        if (link) throw new TemporalScopeError('openlines', 'Историческая версия аудиоссылки не подтверждена');
        for (const id of ids) {
          const file = byId.get(id);
          if (!file || !withinCutoff(file.date || file.DATE || null)) {
            throw new TemporalScopeError('openlines', 'Дата вложения не подтверждает его наличие до отказа');
          }
        }
      }
      const msgKey = `${sessionId}_${messageId}`;
      const event = {
        type: 'chat', channel: meta.title, connector_id: meta.connector, chat_id: chatId,
        session_id: sessionId, message_id: msgKey, date: message.date || message.DATE || null,
        author_id: message.author_id || message.AUTHOR_ID || 0, author_name: author,
        role, direction: role === 'Менеджер' ? 'outgoing' : role === 'Клиент' ? 'incoming' : 'unknown',
        ...(meta.isWazzup && role === 'unknown' ? { _wazzup_author_ambiguous: true } : {}),
        ...(meta.isWappi ? { connector_family: 'wappi' } : {}),
        ...(meta.isWappi && role === 'unknown' ? { _wappi_author_ambiguous: true } : {}),
        ...(meta.connectorUnknown && role === 'unknown' ? { _chat_connector_unknown: true } : {}),
        text: cleaned, is_system: false, _has_audio: count > 0, _has_files: count > 0,
      };
      eventScopes.set(event, sessionScope);
      if (verified) {
        event.inference_session_id = verified.sessionId;
        verified.members.push(event);
        verifiedFallbackEvents.set(event, { ...verified, eventSnapshot: JSON.stringify(event) });
      }
      messages.push(event);
      for (const id of ids) {
        audioItems.push({ event, fileId: id, fileMeta: byId.get(id) || null });
      }
      if (link) audioItems.push({ event, fileId: null, link });
    }
    // Непривязанный image/video остаётся частью истории, даже если отдельного
    // сообщения у него нет. Без его содержания текстовый контекст неполон.
    const scopedFiles = files.filter(file => file?.id != null && sessionFileRefs.has(String(file.id))
      || withinCutoff(file?.date || file?.DATE || null));
    if (scopedFiles.some(file => file?.id == null || (!sessionFileRefs.has(String(file.id)) && knownNonAudio(file)))) {
      if (cutoff !== null && messages.length === sessionMessageStart) {
        throw new TemporalScopeError('openlines', 'Вложение истории не связано с сообщением до отказа');
      }
      for (const event of messages.slice(sessionMessageStart)) {
        event._session_unreferenced_files = true;
        const binding = verifiedFallbackEvents.get(event);
        if (binding) binding.eventSnapshot = JSON.stringify(event);
      }
    }
    for (const key of sessionFileRefs) registerSessionFile(key, sessionScope, true);
    for (const file of scopedFiles) {
      if (file.id != null && !sessionFileRefs.has(String(file.id))) {
        registerSessionFile(String(file.id), sessionScope, false);
      }
      if (!audioMetadata(file)) {
        if (!knownNonAudio(file) && file.id != null && !sessionFileRefs.has(String(file.id))) {
          throw new Error('Не удалось определить тип отдельного файла открытой линии');
        }
        continue;
      }
      if (file.id == null) throw new Error('Неизвестен ID аудиофайла открытой линии');
      if (sessionFileRefs.has(String(file.id))) continue;
      const prior = orphanFiles.find(item => item.sessionScope === sessionScope && String(item.file.id) === String(file.id));
      if (prior) {
        if (JSON.stringify(prior.file) !== JSON.stringify(file)) throw new Error('Версии файла открытой линии расходятся');
        continue;
      }
      orphanFiles.push({ file, chatId, sessionId, sessionScope, meta, users, verified });
    }
  }

  for (const orphan of orphanFiles) {
    const id = String(orphan.file.id);
    const authorId = String(orphan.file.authorid ?? '0');
    const user = authorId !== '0' ? orphan.users[authorId] : null;
    const role = orphan.meta.connectorConflict ? 'unknown' : orphan.meta.isWazzup || orphan.meta.connectorUnknown
      ? (confirmedBitrixManager(user) ? 'Менеджер' : 'unknown')
      : (user ? (orphan.meta.isWappi && userRole(user) === 'Менеджер' && !confirmedBitrixManager(user) ? 'unknown' : userRole(user))
        : (orphan.meta.isWappi ? 'unknown' : 'Клиент'));
    const author = role === 'Менеджер' ? (user.name || user.firstName || 'Менеджер') : role === 'Клиент' ? 'Клиент' : 'Участник чата';
    const event = {
      type: 'chat', channel: orphan.meta.title, connector_id: orphan.meta.connector,
      chat_id: orphan.chatId, session_id: orphan.sessionId, message_id: `${orphan.sessionId}_file_${id}`,
      date: orphan.file.date || null, author_id: authorId, author_name: author,
      role, direction: role === 'Менеджер' ? 'outgoing' : role === 'Клиент' ? 'incoming' : 'unknown', text: '',
      ...(orphan.meta.isWazzup && role === 'unknown' ? { _wazzup_author_ambiguous: true } : {}),
      ...(orphan.meta.isWappi ? { connector_family: 'wappi' } : {}),
      ...(orphan.meta.isWappi && role === 'unknown' ? { _wappi_author_ambiguous: true } : {}),
      ...(orphan.meta.connectorUnknown && role === 'unknown' ? { _chat_connector_unknown: true } : {}),
      is_system: false, _has_audio: true, _has_files: true,
    };
    eventScopes.set(event, orphan.sessionScope);
    if (orphan.verified) {
      event.inference_session_id = orphan.verified.sessionId;
      orphan.verified.members.push(event);
      verifiedFallbackEvents.set(event, { ...orphan.verified, eventSnapshot: null });
    }
    messages.push(event);
    audioItems.push({ event, fileId: id, fileMeta: orphan.file });
  }

  const transcripts = new Map();
  const unrecognized = new Map();
  // Для допуска в контекст требуется успех КАЖДОГО вложения сообщения,
  // а не только одного файла при наличии других, в том числе изображений.
  const attachmentCoverage = new Map();
  let audioFound = 0;
  function markUnrecognized(event, failure) {
    unrecognized.set(event, (unrecognized.get(event) || 0) + 1);
    if (failure) voiceFailures.push(failure);
  }
  for (const item of audioItems) {
    const coverage = attachmentCoverage.get(item.event) || { total: 0, success: 0, audioOnly: 0 };
    coverage.total++;
    attachmentCoverage.set(item.event, coverage);
    if (knownNonAudio(item.fileMeta)) continue;
    let file, voiceSnapshot;
    if (item.link) {
      file = { id: `link${audioFound}`, name: `voice_link.${item.link.ext}`, url: item.link.url };
    } else {
      try {
        if (typeof resolveFile !== 'function') throw new Error('Файловый адаптер не подключён');
        const resolved = await resolveFile(item.fileId);
        const data = resolved?.result || resolved;
        if (!data || typeof data !== 'object') throw new Error('Файл не получен');
        // Если в истории указано аудио, а disk.file.get вернул изображение,
        // видео или другой неаудиоформат, нельзя молча отбросить голосовое:
        // источник противоречив, требуется повторная проверка.
        if (knownNonAudio(data)) {
          if (audioMetadata(item.fileMeta)) {
            markUnrecognized(item.event, { file_id: item.fileId, retryable: true, step: 'disk_file_get',
              error: 'Тип файла в истории и Битрикс Диске расходится' });
          }
          continue;
        }
        const name = data.NAME || data.name || item.fileMeta?.name || '';
        if (audioMetadata(item.fileMeta) && !extension(name)) throw new Error('Не удалось определить формат аудиофайла');
        if (!audioMetadata(item.fileMeta) && !extension(name)) throw new Error('Не удалось определить тип файла');
        if (!audioMetadata(item.fileMeta) && !AUDIO_EXTENSIONS.includes(extension(name))) continue;
        file = { id: item.fileId, name, url: data.DOWNLOAD_URL || data.urlDownload || data.url || null };
        if (verifiedFallbackEvents.has(item.event)) {
          voiceSnapshot = voiceFileSnapshot(data, item.fileId, name);
          if (!voiceSnapshot) throw new Error('Не подтверждены метаданные голосового');
        }
      } catch {
        markUnrecognized(item.event, { file_id: item.fileId, retryable: true, step: 'disk_file_get', error: 'Не удалось получить файл' });
        continue;
      }
    }
    audioFound++;
    const ext = extension(file.name);
    if (!VOICE_SUPPORTED.includes(ext)) {
      markUnrecognized(item.event, { file_id: file.id, file_name: file.name || `x.${ext}`, retryable: false, unsupported: true, step: 'unsupported_format' });
      continue;
    }
    try {
      if (!file.url || typeof transcribeVoice !== 'function') throw new Error('Распознавание недоступно');
      const voiceRequest = {
        download_url: file.url,
        file_name: `chat_audio_${collection.deal_id}_${file.id}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
        file_id: file.id,
        activity_id: `chat_${file.id}`, call_date: item.event.date || '',
        call_direction: item.event.direction,
        comm_index: audioFound - 1, channel_count: 1,
        speaker_role: item.event.role === 'unknown' ? 'Участник чата' : item.event.role,
        ...(verifiedFallbackEvents.has(item.event) ? { require_audio_only: true } : {}),
        ...(voiceSnapshot ? { voice_file_snapshot: voiceSnapshot } : {}),
      };
      const expectedVoiceRequest = JSON.stringify(voiceRequest);
      const response = await transcribeVoice(voiceRequest);
      if (!response || response.success !== true) throw new Error('Распознавание завершилось ошибкой');
      if (typeof response.formatted_dialog !== 'string') throw new Error('Некорректный результат распознавания');
      if (ambiguousProcessingOnly(response)) throw new Error('Неоднозначный результат распознавания');
      if (!response.formatted_dialog.trim()) { markUnrecognized(item.event); continue; }
      const list = transcripts.get(item.event) || [];
      list.push(response);
      transcripts.set(item.event, list);
      coverage.success++;
      if (JSON.stringify(voiceRequest) === expectedVoiceRequest && verifiedAudioOnly(response, voiceRequest)) coverage.audioOnly++;
    } catch {
      markUnrecognized(item.event, { file_id: file.id, file_name: file.name, retryable: true, step: 'transcribe_chat_audio', error: 'Не удалось распознать голосовое' });
    }
  }

  let audioTranscribed = 0;
  let unrecognizedCount = 0;
  for (const message of messages) {
    const list = transcripts.get(message) || [];
    if (list.length) {
      message.transcript = list.map(item => item.formatted_dialog).join('\n\n');
      message.transcript_manager_text = list.map(item => item.manager_text || '').filter(Boolean).join(' ');
      message.transcript_client_text = list.map(item => item.client_text || '').filter(Boolean).join(' ');
      message.transcript_replicas = list.reduce((total, item) => total + (Number(item.total_replicas) || 0), 0);
      message._has_audio_transcript = true;
      const voiceText = [message.transcript_manager_text, message.transcript_client_text].filter(Boolean).join(' ').trim()
        || message.transcript.trim();
      message.text = message.text ? `${message.text}\n\n[Голосовое сообщение]: ${voiceText}` : voiceText;
      audioTranscribed++;
    }
    const count = unrecognized.get(message) || 0;
    if (count) {
      message.text = message.text ? `${message.text}\n\n[голосовое сообщение, не распознано]` : '[голосовое сообщение, не распознано]';
      message._voice_unrecognized = count;
      unrecognizedCount += count;
    }
    if (ambiguousMessageSessions.has(eventScopes.get(message))) message._session_context_ambiguous = true;
    // Закрепляем окончательный объект после обработки вложений, чтобы
    // аудиореплика не выпала из группы. Прочие и нераспознанные вложения
    // не получают подтверждения и закрывают семантическую оценку сессии.
    const binding = verifiedFallbackEvents.get(message);
    if (binding) binding.eventSnapshot = JSON.stringify(message);
    const coverage = attachmentCoverage.get(message);
    if (binding && coverage?.total > 0 && coverage.success === coverage.total && coverage.audioOnly === coverage.total
        && count === 0 && message._has_audio_transcript === true && message._session_unreferenced_files !== true) {
      verifiedVoiceEvents.add(message);
    }
  }

  const chatEvents = messages.filter(message => message.text || message._has_audio_transcript || message._has_files);
  const commentEvents = raw.comments.map(comment => commentEvent(comment, screenshots));
  const calls = raw.calls.map(callEvent);
  const events = [...calls, ...commentEvents, ...chatEvents, ...raw.tasks.map(task => taskEvent(task, cutoff !== null))];
  events.sort((a, b) => (a.date ? new Date(a.date).getTime() : 0) - (b.date ? new Date(b.date).getTime() : 0));
  const stats = {
    total_events: events.length, calls: calls.filter(call => call.type === 'call').length, calls_with_audio: calls.filter(call => call._needs_transcription).length,
    comments: commentEvents.length, chat_messages: chatEvents.length, chat_messages_raw: messages.length,
    chat_files_skipped: messages.length - chatEvents.length, chat_audio_transcribed: audioTranscribed,
    chat_audio_files_found: audioFound, chat_system_dropped: systemDropped,
    chat_voice_unrecognized: unrecognizedCount, tasks: raw.tasks.length + calls.filter(call => call.type === 'task').length, chats_count: raw.chats.length,
    screenshots_found: commentEvents.reduce((total, comment) => total + (comment.screenshots?.length || 0), 0),
  };
  const dealData = {
    ...collection.deal_data, communications: events, comm_stats: stats, silent: collection.silent === true,
    screenshots_enabled: screenshots === true, _sources: collection._sources, voice_failures: voiceFailures,
    _block: 'block2_complete', _ready_for: 'block3_transcription',
  };
  return {
    deal_data: dealData,
    analysis_communications: events.filter(event => event.type !== 'comment' || !isAiComment(event)),
    voice_failures: voiceFailures,
    ready_for_analysis: false,
  };
}
