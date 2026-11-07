import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from 'node:crypto';
import { transcribeExcerpt, runExcerptCommand } from '../../app/src/pilot/stt-excerpt-check.mjs';
import { sealEvidenceReport } from '../../app/src/pilot/evidence-review.mjs';
import { startSttService } from '../../app/src/stt/child.mjs';

const client = { request() { throw new Error('must be mocked'); } };
const raw = Buffer.alloc(2048, 7);
const audio = { deal_id: '126554', activity_id: '1660320', format: 'mp3', bytes: raw.length, audio_base64: raw.toString('base64') };
const result = { ok: true, model: 'ai-sage/gigaam-v3', channels: 2, source_channels: 2, segments: [
  { channel: 0, start: 55, end: 61, text: 'фраза менеджера' },
  { channel: 1, start: 61, end: 65, text: 'ответ клиента' },
  { channel: 0, start: 75, end: 82, text: 'фраза на границе' },
  { channel: 1, start: 82, end: 83, text: 'за пределами' },
] };
function setup(body = result) {
  let closed = 0, limited = 0, passedSignal = false;
  return { options: { client, polzaKey: 'TEST', closeLimiter: () => { limited++; },
    exportImpl: async args => { assert.equal(args.dealId, '126554'); assert.equal(args.activityId, '1660320'); return audio; },
    startImpl: async opts => { passedSignal = !!opts.signal; return { address: 'http://127.0.0.1:1234', key: 'TEST', close: async () => { closed++; } }; },
    fetchImpl: async (url, opts) => { assert.equal(url, 'http://127.0.0.1:1234/v1/transcribe?channels=stereo');
      assert.deepEqual(Buffer.from(opts.body), raw); assert.equal(opts.headers['X-STT-Key'], 'TEST'); return new Response(JSON.stringify(body), { status: 200 }); },
  }, get: () => ({ closed, limited, passedSignal }) };
}
test('полный исходный файл проходит стерео GigaAM, на выходе только пересекающие 60–80 секунды сегменты', async () => {
  const s = setup(); const out = await runExcerptCommand(s.options);
  assert.equal(out.status, 'completed'); assert.equal(out.engine, 'ai-sage/gigaam-v3'); assert.equal(out.service_closed, true);
  assert.deepEqual(out.segments, result.segments.slice(0, 3)); assert.equal(out.total_segments, 4);
  assert.deepEqual(s.get(), { closed: 1, limited: 1, passedSignal: true });
});
test('пустой участок не объявляется тишиной, неизвестная модель и моно отклоняются', async () => {
  let s = setup({ ...result, segments: [] }); let out = await runExcerptCommand(s.options);
  assert.equal(out.status, 'completed'); assert.deepEqual(out.segments, []);
  for (const body of [{ ...result, model: 'another' }, { ...result, channels: 1 }, { ...result, source_channels: 1 },
    { ...result, segments: [{ channel: 1, start: 62, end: NaN, text: 'x' }] }]) {
    s = setup(body); out = await runExcerptCommand(s.options); assert.equal(out.error_code, 'invalid_response'); assert.equal(out.service_closed, true);
  }
});
test('ошибка сервиса скрыта, при неудавшемся закрытии marker не выдаётся', async () => {
  const s = setup(); s.options.fetchImpl = async () => new Response('SECRET', { status: 503 });
  const out = await runExcerptCommand(s.options); assert.deepEqual(out, { status: 'error', phase: 'stt_transcribe', error_code: 'stt_error', service_closed: true });
  const failed = setup(); failed.options.startImpl = async () => ({ address: 'http://127.0.0.1:1234', key: 'TEST', close: async () => { throw new Error('uncertain'); } });
  await assert.rejects(runExcerptCommand(failed.options));
});
test('таймаут ожидает завершения дочернего сервиса; если завершение не подтверждено, marker отсутствует', async () => {
  const s = setup(); s.options.deadlineMs = 20; s.options.closeGraceMs = 50;
  s.options.fetchImpl = async (_url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }));
  const out = await runExcerptCommand(s.options); assert.equal(out.error_code, 'deadline'); assert.equal(out.service_closed, true); assert.equal(s.get().closed, 1);
  const stuck = setup(); stuck.options.deadlineMs = 20; stuck.options.closeGraceMs = 20;
  stuck.options.fetchImpl = async () => new Promise(() => {});
  await assert.rejects(runExcerptCommand(stuck.options));
});
test('шифрованный ответ аутентифицирован и не раскрывает текст', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const encoded = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
  const envelope = sealEvidenceReport({ status: 'completed', service_closed: true, segments: [{ text: 'частный текст' }] }, encoded);
  assert.equal(JSON.stringify(envelope).includes('частный текст'), false);
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.encrypted_key, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64')); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const decoded = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]));
  assert.equal(decoded.segments[0].text, 'частный текст');
});
test('реальный локальный STT запускается и закрывается в синтетическом test-режиме без Polza', { timeout: 15000 }, async () => {
  let limiterClosed = false;
  const out = await runExcerptCommand({ client, polzaKey: 'TEST_NOT_A_SECRET', deadlineMs: 10000, closeGraceMs: 3000,
    closeLimiter: () => { limiterClosed = true; }, exportImpl: async () => audio, startImpl: startSttService,
    fetchImpl: async (url, options) => {
      const r = await fetch(`${url}&test=1`, options), body = await r.json();
      // У встроенного test=1 нет поля source_channels; в рабочем ответе оно есть.
      return new Response(JSON.stringify({ ...body, source_channels: 2 }), { status: r.status });
    },
  });
  assert.equal(out.status, 'completed'); assert.equal(out.service_closed, true); assert.equal(out.engine, 'ai-sage/gigaam-v3');
  assert.equal(out.channels, 2); assert.deepEqual(out.segments, []); assert.equal(limiterClosed, true);
});
