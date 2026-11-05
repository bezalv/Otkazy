import { mergeScreenshotResults } from './parse.mjs';

function fileIndex(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return Number(value);
  return -1;
}

function coversFiles(response, files) {
  if (!files.length) return false;
  if (files.some(file => !file.date || !Number.isFinite(new Date(file.date).getTime()))) return false;
  const content = response?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map(part => part?.text || '').join('') : content;
  if (typeof text !== 'string') return false;
  const raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const braced = raw.match(/\{[\s\S]*\}/);
  let parsed;
  try {
    parsed = JSON.parse(fence?.[1] || raw);
  } catch {
    try { parsed = JSON.parse(braced?.[0] || ''); } catch { return false; }
  }
  if (!Array.isArray(parsed?.screenshots) || !Array.isArray(parsed.turns)) return false;
  if (parsed.screenshots.length !== files.length) return false;
  const ids = new Set();
  for (const shot of parsed.screenshots) {
    const id = fileIndex(shot?.file_id);
    if (!Number.isInteger(id) || id < 0 || id >= files.length || ids.has(id)
      || typeof shot.is_chat_screenshot !== 'boolean') return false;
    ids.add(id);
  }
  return parsed.turns.every(turn => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return false;
    if (fileIndex(turn.file_id) < 0 || fileIndex(turn.file_id) >= files.length) return false;
    if (!['manager', 'client', 'unknown'].includes(turn.speaker)) return false;
    return ['text', 'attachment', 'time', 'date_label'].every(key =>
      turn[key] === undefined || turn[key] === null || typeof turn[key] === 'string');
  });
}

/** Сопоставляет ответы с комментариями и возвращает сбои для шлюза полноты. */
export function collectScreenshotResults({ base, tasks, responses, preparationFailures }) {
  if (!Array.isArray(preparationFailures)) throw new TypeError('Нужен список ошибок подготовки скриншотов');
  const expectedFailures = Number(tasks[0]?.stats?.screenshots_download_failed) || 0;
  if (preparationFailures.length < expectedFailures) {
    throw new Error('Переданы не все ошибки подготовки скриншотов');
  }
  const failures = [...preparationFailures];
  const byComment = new Map();
  const duplicates = new Set();
  for (const item of responses || []) {
    const id = String(item.comment_id);
    if (byComment.has(id)) duplicates.add(id);
    else byComment.set(id, item.response);
  }

  const runs = tasks.filter(task => task._has_images).map(task => {
    const id = String(task.comment_id);
    const response = byComment.get(id);
    if (!response || response.error || duplicates.has(id) || !coversFiles(response, task.files || [])) {
      for (const file of task.files || []) {
        failures.push({ file_id: file.file_id, retryable: true, error: 'Не удалось распознать скриншот' });
      }
      return { error: { message: 'Не удалось распознать все скриншоты комментария' } };
    }
    return response;
  });
  return { output: mergeScreenshotResults(base, tasks, runs), failures };
}
