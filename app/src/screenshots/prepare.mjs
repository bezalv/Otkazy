import { SYSTEM_PROMPT, USER_PROMPT } from './prompt.mjs';

const MAX_IMAGES_PER_COMMENT = 10;
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;

function imageType(buffer) {
  if (buffer.length > 8 && buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (buffer.length > 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.length > 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  const signature = buffer.toString('latin1', 0, 6);
  if (buffer.length > 6 && ['GIF87a', 'GIF89a'].includes(signature)) return 'image/gif';
  return null;
}

/** Собирает запросы к модели. Загрузка файла предоставляется вызывающим кодом. */
export async function prepareScreenshotTasks({ communications, resolveFile, downloadFile }) {
  const screenshotComments = (communications || []).filter(comment =>
    comment?.type === 'comment' && comment.screenshots?.length);
  if (screenshotComments.length > 1) {
    throw new RangeError('Скриншоты нужно обрабатывать по одному комментарию за раз');
  }
  const tasks = [];
  const failedComments = [];
  const failures = [];
  const stats = { screenshots_total: 0, comments_with_screenshots: 0, screenshots_downloaded: 0, screenshots_download_failed: 0 };

  for (const comment of screenshotComments) {
    const shots = comment.screenshots;
    stats.comments_with_screenshots++;
    stats.screenshots_total += shots.length;
    const files = [];
    const content = [{ type: 'text', text: USER_PROMPT }];
    const errors = [];
    let bytes = 0;

    for (const shot of shots) {
      try {
        if (files.length >= MAX_IMAGES_PER_COMMENT) throw new Error('Превышен лимит числа скриншотов');
        const response = await resolveFile(shot.file_id);
        const meta = response?.result || response;
        if (!meta?.DOWNLOAD_URL) throw new Error('Нет ссылки на файл');
        const date = shot.date || meta.CREATE_TIME;
        if (!date || !Number.isFinite(new Date(date).getTime())) throw new Error('Нет корректной даты файла');
        const raw = await downloadFile(meta.DOWNLOAD_URL, { maxBytes: MAX_TOTAL_BYTES - bytes });
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const mime = imageType(buffer);
        if (!mime) throw new Error('Файл не является поддерживаемым изображением');
        if (bytes + buffer.length > MAX_TOTAL_BYTES) throw new Error('Превышен лимит размера');
        bytes += buffer.length;
        content.push({ type: 'text', text: `Скриншот file_id=${files.length}` });
        content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } });
        files.push({
          file_id: shot.file_id, name: shot.name || meta.NAME || '', date,
          size: buffer.length, mime, width: shot.width || null, height: shot.height || null,
        });
      } catch {
        errors.push({ file_id: shot.file_id, error: 'Не удалось подготовить скриншот' });
        failures.push({ file_id: shot.file_id, retryable: true, error: 'Не удалось подготовить скриншот' });
      }
    }

    stats.screenshots_downloaded += files.length;
    stats.screenshots_download_failed += shots.length - files.length;
    if (!files.length) {
      failedComments.push({ comment_id: comment.comment_id, count: shots.length, errors });
      continue;
    }
    tasks.push({
      _has_images: true, comment_id: comment.comment_id, files, download_errors: errors,
      polza_body: {
        model: 'anthropic/claude-sonnet-4.6', temperature: 0, max_tokens: 8000,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }],
      },
    });
  }

  if (!tasks.length) tasks.push({ _has_images: false });
  for (const task of tasks) {
    task.failed_comments = failedComments;
    task.stats = stats;
  }
  return { tasks, failures };
}
