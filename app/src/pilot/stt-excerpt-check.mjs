// Разовая штатная поканальная транскрибация конкретного звонка; внешних записей нет.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBitrixClient } from '../bitrix-client.mjs';
import { createBitrixLimiter } from '../bitrix-limiter.mjs';
import { startSttService } from '../stt/child.mjs';
import { exportAudio } from './audio-export.mjs';
import { sealEvidenceReport } from './evidence-review.mjs';

const DEAL = '126554', ACTIVITY = '1660320';
const START = 60, END = 80;
const PHASES = new Set(['bitrix_lookup', 'audio_download', 'stt_start', 'stt_transcribe', 'validation']);
const ERRORS = new Set(['bitrix_error', 'audio_unavailable', 'stt_error', 'invalid_response', 'deadline', 'unexpected_error']);
function safeError(phase, code) { return { status: 'error', phase: PHASES.has(phase) ? phase : 'validation', error_code: ERRORS.has(code) ? code : 'unexpected_error' }; }

/** Читает только выбранный звонок и передаёт оригинал штатному локальному STT. */
export async function transcribeExcerpt({ client, polzaKey, signal, fetchImpl = fetch,
  exportImpl = exportAudio, startImpl = startSttService, onPhase = () => {} }) {
  if (!client || typeof client.request !== 'function' || typeof polzaKey !== 'string' || !polzaKey
      || !signal || typeof signal.throwIfAborted !== 'function') throw new TypeError('Неверные параметры');
  let phase = 'bitrix_lookup', bytes, service;
  const setPhase = value => { phase = value; onPhase(value); };
  try {
    const audio = await exportImpl({ dealId: DEAL, activityId: ACTIVITY, client, fetchImpl, signal, onPhase: setPhase });
    bytes = Buffer.from(audio.audio_base64, 'base64');
    if (audio.deal_id !== DEAL || audio.activity_id !== ACTIVITY || audio.format !== 'mp3'
        || !Number.isInteger(audio.bytes) || audio.bytes !== bytes.length || bytes.length < 1024 || bytes.length > 550000) {
      return safeError('validation', 'invalid_response');
    }
    signal.throwIfAborted();
    setPhase('stt_start');
    // Ошибку запуска нельзя считать подтверждённым закрытием, поскольку
    // startSttService мог успеть создать дочернюю группу процессов.
    service = await startImpl({ polzaKey, signal });
    setPhase('stt_transcribe');
    const response = await fetchImpl(`${service.address}/v1/transcribe?channels=stereo`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-STT-Key': service.key }, body: bytes, signal,
    });
    if (!response.ok) { await response.body?.cancel?.().catch(() => {}); return safeError(phase, signal.aborted ? 'deadline' : 'stt_error'); }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 1048576) { await response.body?.cancel?.().catch(() => {}); return safeError('validation', 'invalid_response'); }
    let size = 0; const chunks = [];
    for await (const input of response.body) {
      const part = Buffer.from(input); size += part.length;
      if (size > 1048576) throw new Error('Превышен предел ответа');
      chunks.push(part);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    finally { for (const chunk of chunks) chunk.fill(0); }
    setPhase('validation');
    if (body?.ok !== true || body.model !== 'ai-sage/gigaam-v3' || body.channels !== 2 || body.source_channels !== 2
        || !Array.isArray(body.segments) || body.segments.length > 10000
        || !body.segments.every(s => s && [0, 1].includes(s.channel) && Number.isFinite(s.start) && Number.isFinite(s.end)
          && s.start >= 0 && s.end >= s.start && typeof s.text === 'string' && s.text.length <= 2000)) {
      return safeError(phase, 'invalid_response');
    }
    const segments = body.segments.filter(s => s.start < END && s.end > START)
      .map(s => ({ channel: s.channel, start: s.start, end: s.end, text: s.text }));
    if (segments.length > 100 || JSON.stringify(segments).length > 40000) return safeError(phase, 'invalid_response');
    return { status: 'completed', deal_id: DEAL, activity_id: ACTIVITY, interval: { start_seconds: START, end_seconds: END },
      engine: body.model, channels: body.channels, segments, total_segments: body.segments.length };
  } catch (error) {
    if (phase === 'stt_start') throw error;
    const code = signal.aborted ? 'deadline' : phase === 'stt_transcribe' ? 'stt_error'
      : phase === 'validation' ? 'invalid_response' : ['bitrix_error', 'audio_unavailable'].includes(error?.code) ? error.code : 'unexpected_error';
    return safeError(phase, code);
  } finally {
    bytes?.fill(0);
    if (service) await service.close();
  }
}

/** Marker выдаётся только после полного завершения работы и закрытия группы STT. */
export async function runExcerptCommand({ client, polzaKey, closeLimiter, fetchImpl = fetch, exportImpl = exportAudio,
  startImpl = startSttService, deadlineMs = 480000, closeGraceMs = 30000 }) {
  if (typeof closeLimiter !== 'function' || !Number.isSafeInteger(deadlineMs) || deadlineMs < 10 || deadlineMs > 480000
      || !Number.isSafeInteger(closeGraceMs) || closeGraceMs < 10 || closeGraceMs > 30000) throw new TypeError('Неверные лимиты');
  const controller = new AbortController(); let phase = 'bitrix_lookup', timer, grace;
  const work = transcribeExcerpt({ client, polzaKey, signal: controller.signal, fetchImpl, exportImpl, startImpl, onPhase: x => { phase = x; } });
  const expired = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, deadlineMs); });
  try {
    let outcome = await Promise.race([work, expired]);
    if (outcome === null) {
      // Не выводить marker, если завершение группы и работы не подтвердилось.
      await Promise.race([work, new Promise((_, reject) => { grace = setTimeout(() => reject(new Error('Завершение не подтверждено')), closeGraceMs); })]);
      outcome = safeError(phase, 'deadline');
    }
    closeLimiter();
    return { ...outcome, service_closed: true };
  } finally { clearTimeout(timer); clearTimeout(grace); controller.abort(); }
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--sealed') throw new Error('Требуется защищённый вывод');
  const publicKey = process.argv[3];
  sealEvidenceReport({ service_closed: true }, publicKey);
  const base = new URL(process.env.BITRIX_REST_BASE);
  if (base.protocol !== 'https:' || base.hostname !== 'dinalnsk.bitrix24.ru' || base.username || base.password || base.port
      || base.search || base.hash || !/^\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(base.pathname)) throw new Error('Неверный адрес');
  const limiter = createBitrixLimiter(), client = createBitrixClient({ baseUrl: base.toString(), limiter });
  const report = await runExcerptCommand({ client, polzaKey: process.env.POLZA_API_KEY, closeLimiter: () => limiter.close() });
  console.log(JSON.stringify(sealEvidenceReport(report, publicKey)));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('Защищённая проверка не завершена'); process.exitCode = 1;
});
