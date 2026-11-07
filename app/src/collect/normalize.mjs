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
  return SYSTEM_PATTERNS.some(pattern => clean.includes(pattern));
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

function roleForMessage(message, text, users, isWazzup, connectorUnknown, connectorConflict) {
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
  const author = text.match(/===\s*(?:Исходящее|Входящее)\s+сообщение,\s*автор:\s*[^(]*\(([^)]+)\)/);
  if (author) return { role: 'Менеджер', author: author[1].trim() };
  if (user) {
    const role = userRole(user);
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
  return file && (String(file.type).toLowerCase() === 'audio'
    || String(file.type).toLowerCase().startsWith('audio/')
    || AUDIO_EXTENSIONS.includes(metadataExtension(file)));
}

function knownNonAudio(file) {
  if (!file || audioMetadata(file)) return false;
  const type = String(file.type || '').toLowerCase();
  const ext = metadataExtension(file);
  return type === 'image' || type === 'video' || type.startsWith('image/')
    || type.startsWith('video/') || Boolean(ext);
}

function validBitrixId(value) {
  return typeof value === 'number' ? Number.isSafeInteger(value) && value > 0
    : typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function callEvent(call) {
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
    type: 'call', date: created, direction: call.DIRECTION === '2' ? 'outgoing' : 'incoming',
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

function taskEvent(task) {
  return {
    type: 'task', date: task.createdDate || task.CREATED_DATE, title: task.title || task.TITLE,
    description: String(task.description || task.DESCRIPTION || '').substring(0, 500),
    status: task.status || task.STATUS, responsible_id: task.responsibleId || task.RESPONSIBLE_ID,
    created_by: task.createdBy || task.CREATED_BY, closed_date: task.closedDate || task.CLOSED_DATE,
    task_id: task.id || task.ID,
  };
}

/** Подготовка коммуникаций из результата collectDeal. Все внешние действия внедряются вызывающим кодом. */
export async function normalizeCommunications({ collection, resolveFile, transcribeVoice, screenshots = true }) {
  if (collection?._status !== 'pending_normalization' || !collection.raw || !collection.deal_data) {
    throw new TypeError('Нужен полный результат первичного сбора');
  }
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
    }];
  }));
  const messages = [];
  const messageIds = new Map();
  const referencedFiles = new Set();
  const orphanFiles = new Map();
  const audioItems = [];
  const voiceFailures = [];
  let systemDropped = 0;

  for (const session of raw.sessions) {
    const history = session.history;
    if (!history || typeof history !== 'object' || Array.isArray(history)) throw new Error('Некорректная история открытой линии');
    if (!history.message || typeof history.message !== 'object') throw new Error('В истории открытой линии нет списка сообщений');
    const chatId = session.chat_id ?? Object.keys(history.chat || {})[0] ?? null;
    const sessionId = session.session_id ?? `chat_${chatId}`;
    const meta = chatMeta.get(String(chatId)) || { connector: 'unknown', title: 'unknown', isWazzup: false, connectorUnknown: true };
    const users = history.users || {};
    const files = sessionFiles(history.files);
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
      const fingerprint = JSON.stringify([
        text, [...ids].sort(), message.senderid ?? null, message.SENDER_ID ?? null,
        message.author_id ?? null, message.AUTHOR_ID ?? null, message.date ?? message.DATE ?? null,
      ]);
      if (messageIds.has(identity)) {
        if (messageIds.get(identity) !== fingerprint) throw new Error('Версии сообщения открытой линии расходятся');
        continue;
      }
      messageIds.set(identity, fingerprint);
      const link = ids.length ? null : audioLink(text);
      const count = ids.length + (link ? 1 : 0);
      if (systemMessage(message, text, count)) { systemDropped++; continue; }
      const { role, author } = roleForMessage(message, text, users, meta.isWazzup, meta.connectorUnknown, meta.connectorConflict);
      const cleaned = link ? '' : cleanChatText(text, meta.isWazzup);
      if (!cleaned && !count) continue;
      const msgKey = `${sessionId}_${messageId}`;
      const event = {
        type: 'chat', channel: meta.title, connector_id: meta.connector, chat_id: chatId,
        session_id: sessionId, message_id: msgKey, date: message.date || message.DATE || null,
        author_id: message.author_id || message.AUTHOR_ID || 0, author_name: author,
        role, direction: role === 'Менеджер' ? 'outgoing' : role === 'Клиент' ? 'incoming' : 'unknown',
        ...(meta.isWazzup && role === 'unknown' ? { _wazzup_author_ambiguous: true } : {}),
        ...(meta.connectorUnknown && role === 'unknown' ? { _chat_connector_unknown: true } : {}),
        text: cleaned, is_system: false, _has_audio: count > 0, _has_files: count > 0,
      };
      messages.push(event);
      for (const id of ids) {
        referencedFiles.add(id);
        audioItems.push({ event, fileId: id, fileMeta: byId.get(id) || null });
      }
      if (link) audioItems.push({ event, fileId: null, link });
    }
    for (const file of files) {
      if (!audioMetadata(file)) {
        if (!knownNonAudio(file) && file.id != null && !referencedFiles.has(String(file.id))) {
          throw new Error('Не удалось определить тип отдельного файла открытой линии');
        }
        continue;
      }
      if (file.id == null) throw new Error('Неизвестен ID аудиофайла открытой линии');
      if (orphanFiles.has(String(file.id))) continue;
      orphanFiles.set(String(file.id), { file, chatId, sessionId, meta, users });
    }
  }

  for (const [id, orphan] of orphanFiles) {
    if (referencedFiles.has(id)) continue;
    const authorId = String(orphan.file.authorid ?? '0');
    const user = authorId !== '0' ? orphan.users[authorId] : null;
    const role = orphan.meta.connectorConflict ? 'unknown' : orphan.meta.isWazzup || orphan.meta.connectorUnknown
      ? (confirmedBitrixManager(user) ? 'Менеджер' : 'unknown')
      : (user ? userRole(user) : 'Клиент');
    const author = role === 'Менеджер' ? (user.name || user.firstName || 'Менеджер') : role === 'Клиент' ? 'Клиент' : 'Участник чата';
    const event = {
      type: 'chat', channel: orphan.meta.title, connector_id: orphan.meta.connector,
      chat_id: orphan.chatId, session_id: orphan.sessionId, message_id: `${orphan.sessionId}_file_${id}`,
      date: orphan.file.date || null, author_id: authorId, author_name: author,
      role, direction: role === 'Менеджер' ? 'outgoing' : role === 'Клиент' ? 'incoming' : 'unknown', text: '',
      ...(orphan.meta.isWazzup && role === 'unknown' ? { _wazzup_author_ambiguous: true } : {}),
      ...(orphan.meta.connectorUnknown && role === 'unknown' ? { _chat_connector_unknown: true } : {}),
      is_system: false, _has_audio: true, _has_files: true,
    };
    messages.push(event);
    audioItems.push({ event, fileId: id, fileMeta: orphan.file });
  }

  const transcripts = new Map();
  const unrecognized = new Map();
  let audioFound = 0;
  function markUnrecognized(event, failure) {
    unrecognized.set(event, (unrecognized.get(event) || 0) + 1);
    if (failure) voiceFailures.push(failure);
  }
  for (const item of audioItems) {
    if (knownNonAudio(item.fileMeta)) continue;
    let file;
    if (item.link) {
      file = { id: `link${audioFound}`, name: `voice_link.${item.link.ext}`, url: item.link.url };
    } else {
      try {
        if (typeof resolveFile !== 'function') throw new Error('Файловый адаптер не подключён');
        const resolved = await resolveFile(item.fileId);
        const data = resolved?.result || resolved;
        if (!data || typeof data !== 'object') throw new Error('Файл не получен');
        const name = data.NAME || data.name || item.fileMeta?.name || '';
        if (audioMetadata(item.fileMeta) && !extension(name)) throw new Error('Не удалось определить формат аудиофайла');
        if (!audioMetadata(item.fileMeta) && !extension(name)) throw new Error('Не удалось определить тип файла');
        if (!audioMetadata(item.fileMeta) && !AUDIO_EXTENSIONS.includes(extension(name))) continue;
        file = { id: item.fileId, name, url: data.DOWNLOAD_URL || data.urlDownload || data.url || null };
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
      const response = await transcribeVoice({
        download_url: file.url,
        file_name: `chat_audio_${collection.deal_id}_${file.id}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
        file_id: file.id,
        activity_id: `chat_${file.id}`, call_date: item.event.date || '',
        call_direction: item.event.direction,
        comm_index: audioFound - 1, channel_count: 1,
        speaker_role: item.event.role === 'unknown' ? 'Участник чата' : item.event.role,
      });
      if (!response || response.success !== true) throw new Error('Распознавание завершилось ошибкой');
      if (typeof response.formatted_dialog !== 'string') throw new Error('Некорректный результат распознавания');
      if (!response.formatted_dialog) { markUnrecognized(item.event); continue; }
      const list = transcripts.get(item.event) || [];
      list.push(response);
      transcripts.set(item.event, list);
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
  }

  const chatEvents = messages.filter(message => message.text || message._has_audio_transcript || message._has_files);
  const commentEvents = raw.comments.map(comment => commentEvent(comment, screenshots));
  const calls = raw.calls.map(callEvent);
  const events = [...calls, ...commentEvents, ...chatEvents, ...raw.tasks.map(taskEvent)];
  events.sort((a, b) => (a.date ? new Date(a.date).getTime() : 0) - (b.date ? new Date(b.date).getTime() : 0));
  const stats = {
    total_events: events.length, calls: calls.length, calls_with_audio: calls.filter(call => call._needs_transcription).length,
    comments: commentEvents.length, chat_messages: chatEvents.length, chat_messages_raw: messages.length,
    chat_files_skipped: messages.length - chatEvents.length, chat_audio_transcribed: audioTranscribed,
    chat_audio_files_found: audioFound, chat_system_dropped: systemDropped,
    chat_voice_unrecognized: unrecognizedCount, tasks: raw.tasks.length, chats_count: raw.chats.length,
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
