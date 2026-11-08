// Пакет помечает наличие файла при сборе сообщений Открытых линий.
// Признак расшифровки также встречается у ранее сохранённых голосовых.
function hasFileReference(value) {
  if (Array.isArray(value)) return value.some(hasFileReference);
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  if (typeof value === 'string') return value.trim() !== '' && value.trim() !== '0';
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function hasChatAttachments(message) {
  return message._has_files === true
    || message._has_audio === true
    || message._has_audio_transcript === true
    || hasFileReference(message.attachments)
    || hasFileReference(message.files)
    || hasFileReference(message.file_id)
    || hasFileReference(message.FILE_ID)
    || hasFileReference(message.params?.FILE_ID)
    || hasFileReference(message.params?.fileId)
    || Boolean(message.transcript && String(message.transcript).trim());
}
