// Явный тип изображения, видео или документа важнее суффикса имени файла.
// Generic octet-stream не определяет формат; application/ogg — контейнер.
export function explicitNonAudio(file) {
  if (!file || typeof file !== 'object') return false;
  return ['type', 'TYPE', 'mimeType', 'mime_type', 'MIME_TYPE', 'contentType', 'CONTENT_TYPE'].some(key => {
    const value = String(file[key] || '').trim().toLowerCase().split(';')[0];
    if (/^(?:image|video|text)(?:\/|$)/.test(value)) return true;
    if (['document', 'pdf', 'archive'].includes(value)) return true;
    return value.startsWith('application/') && !['application/octet-stream', 'application/ogg', 'application/x-ogg'].includes(value);
  });
}

// Сравниваем доступные стабильные признаки двух чтений конкретного файла.
// Совпадение метаданных не доказывает неизменность самих аудиобайтов.
export function voiceFileSnapshot(file, expectedId, fallbackName = '') {
  if (!file || typeof file !== 'object' || explicitNonAudio(file)) return null;
  const id = String(file.ID ?? file.id ?? expectedId ?? '');
  const name = String(file.NAME ?? file.name ?? fallbackName ?? '');
  if (!/^[1-9]\d{0,15}$/.test(id) || id !== String(expectedId) || !name) return null;
  const size = file.SIZE ?? file.size ?? null;
  const modified = file.UPDATE_TIME ?? file.updateTime ?? file.MODIFY_TIME ?? file.modifyTime ?? null;
  if (size !== null && !/^\d+$/.test(String(size))) return null;
  if (modified !== null && typeof modified !== 'string') return null;
  return { id, name, size: size === null ? null : String(size), modified };
}

export function sameVoiceFileSnapshot(expected, file) {
  if (!expected || typeof expected !== 'object' || file?.ID == null && file?.id == null) return false;
  const actual = voiceFileSnapshot(file, expected.id);
  return !!actual && actual.id === expected.id && actual.name === expected.name
    && (expected.size === null || actual.size === expected.size)
    && (expected.modified === null || actual.modified === expected.modified);
}
