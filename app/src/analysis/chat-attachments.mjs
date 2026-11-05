// Пакет помечает наличие файла при сборе сообщений Открытых линий.
// Признак расшифровки также встречается у ранее сохранённых голосовых.
export function hasChatAttachments(message) {
  return message._has_files === true
    || message._has_audio === true
    || message._has_audio_transcript === true
    || Boolean(message.transcript && String(message.transcript).trim());
}
