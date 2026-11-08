import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { downloadVerified } from '../../app/src/stt/install-preferred-linux.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const binary = Buffer.from('synthetic binary, no client data');
const compressed = gzipSync(binary);
const item = { name: 'ffmpeg', gzipSha: hash(compressed), binarySize: binary.length, binarySha: hash(binary) };

test('зеркало принимается только после проверки архива и распакованного бинарника', async () => {
  const value = await downloadVerified(item, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://cdn.npmmirror.com/binaries/ffmpeg-static/b6.1.1/ffmpeg-linux-x64.gz');
    assert.equal(options.redirect, 'error');
    return new Response(compressed, { status: 200, headers: { 'content-length': String(compressed.length) } });
  } });
  assert.deepEqual(value, binary);
});

test('повреждённый архив или распакованный файл не устанавливается', async () => {
  const fetchImpl = async () => new Response(compressed, { status: 200 });
  await assert.rejects(downloadVerified({ ...item, gzipSha: '0'.repeat(64) }, { fetchImpl }), /Хеш архива/);
  await assert.rejects(downloadVerified({ ...item, binarySha: '0'.repeat(64) }, { fetchImpl }), /Хеш бинарника/);
  await assert.rejects(downloadVerified({ ...item, binarySize: binary.length + 1 }, { fetchImpl }), /Хеш бинарника/);
});

test('неполный или заведомо слишком большой ответ отклоняется до установки', async () => {
  await assert.rejects(downloadVerified(item, { fetchImpl: async () =>
    new Response(compressed, { status: 200, headers: { 'content-length': '40000001' } }) }), /размер архива/);
  await assert.rejects(downloadVerified(item, { fetchImpl: async () =>
    new Response(compressed, { status: 200, headers: { 'content-length': String(compressed.length + 1) } }) }), /не полностью/);
  await assert.rejects(downloadVerified(item, { fetchImpl: async () => new Response(null, { status: 504 }) }), /недоступно/);
});

test('поток закрывается при HTTP-ошибке и заведомо большом Content-Length', async () => {
  for (const config of [{ status: 504 }, { status: 200, headers: { 'content-length': '40000001' } }]) {
    let cancelled = 0;
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1)); },
      cancel() { cancelled++; } });
    await assert.rejects(downloadVerified(item, { fetchImpl: async () => new Response(body, config) }));
    assert.equal(cancelled, 1);
  }
});

test('поток отменяется, если фактический размер превышает предел', async () => {
  let cancelled = 0, pulls = 0;
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1_000_001)); },
    cancel() { cancelled++; },
  });
  await assert.rejects(downloadVerified(item, { fetchImpl: async () => new Response(body, { status: 200 }) }), /Слишком большой архив/);
  assert.equal(cancelled, 1);
  assert.ok(pulls <= 42);
});
