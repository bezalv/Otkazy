import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectScreenshotResults } from '../../app/src/screenshots/results.mjs';

const tasks = [1, 2].map(id => ({
  _has_images: true, comment_id: id, files: [{ file_id: id, date: '2026-01-01T00:00:00Z' }],
  stats: { screenshots_total: 2, screenshots_downloaded: 2 },
}));
const base = { communications: [1, 2].map(id => ({ type: 'comment', comment_id: id, screenshots: [{ file_id: id }] })) };
const response = content => ({ choices: [{ message: { content: JSON.stringify(content) } }] });
const valid = response({ screenshots: [{ file_id: 0, is_chat_screenshot: false }], turns: [] });

test('отсутствующий ответ не приписывается другому комментарию', () => {
  const result = collectScreenshotResults({ base, tasks, responses: [{ comment_id: 2, response: valid }], preparationFailures: [] });
  assert.equal(result.output.communications[0].screenshot_extract_status, 'failed');
  assert.equal(result.output.communications[1].screenshot_extract_status, 'not_chat');
  assert.deepEqual(result.failures.map(item => item.file_id), [1]);
});

test('успешный JSON без классификации каждого файла считается сбоем', () => {
  for (const bad of [{}, { screenshots: [], turns: [] }]) {
    const result = collectScreenshotResults({ base, tasks: tasks.slice(0, 1), responses: [{ comment_id: 1, response: response(bad) }], preparationFailures: [] });
    assert.equal(result.output.communications[0].screenshot_extract_status, 'failed');
    assert.equal(result.failures[0].retryable, true);
  }
});

test('повторный ответ на один комментарий блокируется', () => {
  const result = collectScreenshotResults({ base, tasks: tasks.slice(0, 1), responses: [
    { comment_id: 1, response: valid }, { comment_id: 1, response: valid },
  ], preparationFailures: [] });
  assert.equal(result.output.communications[0].screenshot_extract_status, 'failed');
  assert.equal(result.failures.length, 1);
});

test('ответ без даты файла не становится фактом с вымышленным годом', () => {
  const withoutDate = [{ ...tasks[0], files: [{ file_id: 1, date: null }] }];
  const result = collectScreenshotResults({ base, tasks: withoutDate, responses: [{ comment_id: 1, response: valid }], preparationFailures: [] });
  assert.equal(result.output.communications[0].screenshot_extract_status, 'failed');
  assert.equal(result.failures[0].retryable, true);
});

test('пустой или логический идентификатор файла не становится нулём', () => {
  for (const fileId of [null, '', false, undefined]) {
    const invalid = response({ screenshots: [{ file_id: fileId, is_chat_screenshot: true }], turns: [] });
    const result = collectScreenshotResults({ base, tasks: tasks.slice(0, 1), responses: [{ comment_id: 1, response: invalid }], preparationFailures: [] });
    assert.equal(result.failures.length, 1);
  }
});

test('список ошибок подготовки обязателен', () => {
  assert.throws(() => collectScreenshotResults({ base, tasks, responses: [] }), /список ошибок/);
});

test('нельзя скрыть неполную загрузку пустым списком ошибок', () => {
  const partial = [{ ...tasks[0], stats: { screenshots_download_failed: 1 } }];
  assert.throws(() => collectScreenshotResults({ base, tasks: partial, responses: [], preparationFailures: [] }), /не все ошибки/);
});

test('некорректный текст или роль не становится фактом клиента', () => {
  for (const turn of [
    { file_id: 0, speaker: 'client', text: { hidden: 'data' } },
    { file_id: 0, speaker: 'unexpected', text: 'Тест' },
  ]) {
    const model = response({ screenshots: [{ file_id: 0, is_chat_screenshot: true }], turns: [turn] });
    const result = collectScreenshotResults({ base, tasks: tasks.slice(0, 1), responses: [{ comment_id: 1, response: model }], preparationFailures: [] });
    assert.equal(result.failures.length, 1);
    assert.equal(result.output.communications[0].screenshot_extract_status, 'failed');
  }
});
