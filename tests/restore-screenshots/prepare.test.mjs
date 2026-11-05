import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareScreenshotTasks } from '../../app/src/screenshots/prepare.mjs';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
const communications = [{ type: 'comment', comment_id: '1', screenshots: [{ file_id: 5 }] }];

test('изображение готовится с исходной моделью и без URL в метаданных', async () => {
  const result = await prepareScreenshotTasks({
    communications,
    resolveFile: async () => ({ result: { DOWNLOAD_URL: 'https://example.test/private', NAME: 'image.png', CREATE_TIME: '2026-01-01T00:00:00Z' } }),
    downloadFile: async () => png,
  });
  assert.equal(result.tasks[0].polza_body.model, 'anthropic/claude-sonnet-4.6');
  assert.equal(result.tasks[0].files[0].mime, 'image/png');
  assert.equal(JSON.stringify(result.tasks[0].files).includes('private'), false);
  assert.deepEqual(result.failures, []);
});

test('ошибка загрузки блокирует полноту и не раскрывает адрес', async () => {
  const result = await prepareScreenshotTasks({
    communications,
    resolveFile: async () => { throw new Error('https://example.test/private-token'); },
    downloadFile: async () => png,
  });
  assert.equal(result.tasks[0]._has_images, false);
  assert.equal(result.tasks[0].failed_comments.length, 1);
  assert.equal(result.failures[0].retryable, true);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});

test('битый файл и превышение лимита возвращают технический сбой', async () => {
  const result = await prepareScreenshotTasks({
    communications,
    resolveFile: async () => ({ DOWNLOAD_URL: 'https://example.test/file', CREATE_TIME: '2026-01-01T00:00:00Z' }),
    downloadFile: async () => Buffer.from('not an image'),
  });
  assert.equal(result.failures.length, 1);
  assert.equal(result.tasks[0].stats.screenshots_download_failed, 1);

  const tooLarge = Buffer.alloc(6 * 1024 * 1024 + 1);
  png.copy(tooLarge);
  const oversized = await prepareScreenshotTasks({
    communications,
    resolveFile: async () => ({ DOWNLOAD_URL: 'https://example.test/file', CREATE_TIME: '2026-01-01T00:00:00Z' }),
    downloadFile: async () => tooLarge,
  });
  assert.equal(oversized.failures.length, 1);
  assert.equal(oversized.tasks[0].stats.screenshots_download_failed, 1);
});

test('отсутствие даты файла блокирует извлечение вместо подстановки 1970 года', async () => {
  const result = await prepareScreenshotTasks({
    communications,
    resolveFile: async () => ({ DOWNLOAD_URL: 'https://example.test/file', CREATE_TIME: null }),
    downloadFile: async () => png,
  });
  assert.equal(result.failures.length, 1);
  assert.equal(result.tasks[0]._has_images, false);
});

test('несколько комментариев требуют последовательной обработки без накопления base64', async () => {
  await assert.rejects(prepareScreenshotTasks({
    communications: [...communications, { ...communications[0], comment_id: '2' }],
    resolveFile: async () => { throw new Error('не должен вызываться'); },
    downloadFile: async () => png,
  }), /по одному комментарию/);
});
