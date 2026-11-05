import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downloadFile } from '../../app/src/media/download.mjs';

const response = (chunks, length) => ({
  ok: true,
  headers: { get: () => length },
  body: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(Buffer.from(chunk)); controller.close(); } }),
});

test('файл считывается частями и сохраняет байты', async () => {
  const result = await downloadFile('https://example.test/private', {
    maxBytes: 6, fetchImpl: async () => response(['abc', 'def'], '6'),
  });
  assert.equal(result.toString(), 'abcdef');
});

test('слишком большой Content-Length отклоняется до чтения', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(downloadFile('https://example.test/private', {
    maxBytes: 4, fetchImpl: async () => ({ ok: true, headers: { get: () => '10' }, body }),
  }), /лимит/);
  assert.equal(cancelled, true);
});

test('неверный Content-Length не позволяет обойти ограничение потока', async () => {
  await assert.rejects(downloadFile('https://example.test/private', {
    maxBytes: 4, fetchImpl: async () => response(['abc', 'def'], '2'),
  }), /лимит/);
});

test('ошибка сети не раскрывает приватную ссылку', async () => {
  await assert.rejects(downloadFile('https://example.test/private-token', {
    maxBytes: 4, fetchImpl: async () => { throw new Error('https://example.test/private-token'); },
  }), error => !error.message.includes('private-token'));
});

test('поток HTTP-ошибки закрывается', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(downloadFile('https://example.test/file', {
    maxBytes: 4, fetchImpl: async () => ({ ok: false, status: 503, body }),
  }), /скачать/);
  assert.equal(cancelled, true);
});
