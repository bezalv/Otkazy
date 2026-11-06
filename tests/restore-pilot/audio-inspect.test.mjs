import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { comparePcm16Stereo, downloadToFile, fileIdFromStoredUrl, inspectAudioFile, inspectDealAudio, withAudioInspectionResources } from '../../app/src/pilot/audio-inspect.mjs';
import { resolveBinary } from '../../app/src/stt/binaries.mjs';

function pcm(left, right) {
  const result = Buffer.alloc(left.length * 4);
  for (let i = 0; i < left.length; i++) { result.writeInt16LE(left[i], i * 4); result.writeInt16LE(right[i], i * 4 + 2); }
  return result;
}

function wav(channels, kind) {
  const samples = 8000, data = Buffer.alloc(samples * channels * 2);
  for (let i = 0; i < samples; i++) {
    const a = Math.round(Math.sin(i * .03) * 12000);
    const b = kind === 'same' ? a : Math.round(Math.cos(i * .079) * 9000);
    data.writeInt16LE(a, i * channels * 2);
    if (channels === 2) data.writeInt16LE(b, i * channels * 2 + 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(8000, 24); head.writeUInt32LE(8000 * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

test('PCM: идентичные, различные и беззвучные каналы не раскрывают образцы', () => {
  assert.deepEqual(comparePcm16Stereo(pcm([1, 2, 3, 4], [1, 2, 3, 4])),
    { sample_available: true, pcm_identical: true, zero_lag_correlation: 'at_least_0_99' });
  assert.equal(comparePcm16Stereo(pcm([1, 2, 3, 4], [1, 4, 2, 3])).zero_lag_correlation, 'below_0_50');
  assert.equal(comparePcm16Stereo(pcm([1, 2, 3, 4], [-1, -2, -3, -4])).zero_lag_correlation, 'at_most_minus_0_99');
  assert.equal(comparePcm16Stereo(pcm([0, 0], [0, 0])).zero_lag_correlation, 'unavailable');
  assert.throws(() => comparePcm16Stereo(Buffer.alloc(3)));
});

test('fileId может отсутствовать и не является доказательством прежнего файла', () => {
  assert.equal(fileIdFromStoredUrl('https://example.invalid/?fileId=123&x=1'), '123');
  assert.equal(fileIdFromStoredUrl('https://example.invalid/?other=123'), null);
  assert.equal(fileIdFromStoredUrl('https://example.invalid/?FILEID=123'), null);
  assert.equal(fileIdFromStoredUrl('https://example.invalid/?fileId=9999999999999999999999'), null);
});

const ffprobe = resolveBinary('ffprobe'), ffmpeg = resolveBinary('ffmpeg');
test('ffprobe/ffmpeg: физический mono, stereo и идентичные каналы', { skip: !existsSync(ffprobe) || !existsSync(ffmpeg) }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'audio-inspect-test-'));
  const paths = ['mono.wav', 'same.wav', 'different.wav', 'three.wav', 'multi.mka'].map(name => join(dir, name));
  t.after(async () => { for (const file of paths) await unlink(file).catch(() => {}); await rmdir(dir); });
  await writeFile(paths[0], wav(1, 'same')); await writeFile(paths[1], wav(2, 'same')); await writeFile(paths[2], wav(2, 'different'));
  const mono = await inspectAudioFile(paths[0], { ffprobe, ffmpeg });
  assert.deepEqual(mono, { channels: 1, duration: 'less_than_30s', multiple_audio_streams: false, source_stream_selection_verified: true, stereo_sample: null });
  const same = await inspectAudioFile(paths[1], { ffprobe, ffmpeg });
  assert.equal(same.channels, 2); assert.equal(same.stereo_sample.pcm_identical, true);
  const distinct = await inspectAudioFile(paths[2], { ffprobe, ffmpeg });
  assert.equal(distinct.channels, 2); assert.equal(distinct.stereo_sample.pcm_identical, false);
  assert.equal(distinct.stereo_sample.zero_lag_correlation, 'below_0_50');
  await writeFile(paths[3], wav(3, 'different'));
  await promisify(execFile)(ffmpeg, ['-v', 'error', '-y', '-i', paths[1], '-i', paths[3], '-map', '0:a', '-map', '1:a', '-c:a', 'pcm_s16le', paths[4]], { windowsHide: true });
  const multi = await inspectAudioFile(paths[4], { ffprobe, ffmpeg });
  assert.equal(multi.channels, 2); assert.equal(multi.stereo_sample.pcm_identical, true);
  assert.equal(multi.multiple_audio_streams, true); assert.equal(multi.source_stream_selection_verified, false);
});

function fakePool({ rls = false, old } = {}) {
  const queries = [];
  return { queries, async connect() { return { async query(sql, params) {
    queries.push(sql);
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes("current_setting('transaction_read_only')")) return { rows: [{ read_only: 'on', present: true, rls_active: rls }] };
    if (sql.includes('FROM public.lost_deal_communications')) {
      assert.deepEqual(params, [127142]);
      return { rows: old || [{ event_id: '55', call_audio_url: 'https://example.invalid/?fileId=99', call_has_audio: true }] };
    }
    throw new Error('Неожиданный SQL');
  }, release() {} }; } };
}

test('только чтение: совпадение определяется по activity, fileId помечен косвенным, вывод очищен', async () => {
  const pool = fakePool(), methods = [];
  const client = { async request(method, body) {
    methods.push(method);
    if (method === 'crm.activity.list') return { result: [{ ID: '55', FILES: [{ urlDownload: 'https://example.invalid/?fileId=99' }] }], total: 1 };
    if (method === 'disk.file.get') { assert.equal(body.id, 99); return { result: { DOWNLOAD_URL: 'https://example.invalid/secret' } }; }
    throw new Error('Запрещённый метод');
  } };
  const output = await inspectDealAudio({ pool, client, dealId: 127142,
    download: async (_url, path) => writeFile(path, 'synthetic'),
    inspectFile: async () => ({ channels: 2, duration: 'less_than_30s', multiple_audio_streams: false, source_stream_selection_verified: true, stereo_sample: { sample_available: true, pcm_identical: true, zero_lag_correlation: 'at_least_0_99', hidden: 'secret' }, hidden: 'secret' }) });
  assert.deepEqual(methods, ['crm.activity.list', 'disk.file.get']);
  assert.equal(output.activity_matches, 1); assert.equal(output.stored_url_fileid_matches_current, 1);
  assert.equal(output.historical_file_identity_verified, false); assert.equal(output.inspected, 1);
  assert.equal(JSON.stringify(output).includes('secret'), false); assert.equal(JSON.stringify(output).includes('127142'), false);
  assert.ok(pool.queries[0].includes('READ ONLY'));
  assert.ok(pool.queries.every(sql => !/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(sql)));
});

test('отсутствие старого fileId не превращается в доказанное совпадение', async () => {
  const pool = fakePool({ old: [{ event_id: '55', call_audio_url: null, call_has_audio: true }] });
  const client = { async request(method) {
    if (method === 'crm.activity.list') return { result: [{ ID: 55, SETTINGS: { RECORD_URL: 'https://example.invalid/?fileId=99' } }], total: 1 };
    return { result: { DOWNLOAD_URL: 'https://example.invalid/secret' } };
  } };
  const output = await inspectDealAudio({ pool, client, dealId: 127142,
    download: async (_url, path) => writeFile(path, 'synthetic'),
    inspectFile: async () => ({ channels: 1, duration: 'less_than_30s', multiple_audio_streams: false, source_stream_selection_verified: true, stereo_sample: null }) });
  assert.equal(output.fileid_unavailable, 1); assert.equal(output.stored_url_fileid_matches_current, 0);
  assert.equal(output.audio[0].channels, 1); assert.equal(output.historical_file_identity_verified, false);
});

test('RLS и неполная страница прекращают проверку до скачивания', async () => {
  let calls = 0, downloads = 0;
  const client = { async request() { calls++; return { result: [], total: 1 }; } };
  await assert.rejects(inspectDealAudio({ pool: fakePool({ rls: true }), client, dealId: 127142 }));
  assert.equal(calls, 0);
  await assert.rejects(inspectDealAudio({ pool: fakePool(), client, dealId: 127142, download: async () => { downloads++; } }));
  assert.equal(downloads, 0);
});

test('неподходящая сделка и отмена не вызывают сетевой API', async () => {
  let calls = 0;
  const client = { async request() { calls++; throw new Error('не должно вызываться'); } };
  await assert.rejects(inspectDealAudio({ pool: fakePool(), client, dealId: 1 }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inspectDealAudio({ pool: fakePool(), client, dealId: 127142, signal: controller.signal }));
  assert.equal(calls, 0);
});

test('каждый redirect заново проверяет HTTPS и не делает запрос при downgrade', async () => {
  let calls = 0;
  await assert.rejects(downloadToFile('https://example.invalid/audio', join(tmpdir(), 'file-not-created'), {
    fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://example.invalid/audio' } }); },
  }));
  assert.equal(calls, 1);
});

test('общий дедлайн прерывает медленную БД и ждёт закрытия операции/пула до маркера', async () => {
  let settled = false, closed = false, limiterClosed = false;
  const output = await withAudioInspectionResources({ deadlineMs: 20, closeGraceMs: 200,
    run: signal => new Promise(resolve => signal.addEventListener('abort', () => setTimeout(() => { settled = true; resolve({}); }, 20), { once: true })),
    closePool: async () => { await new Promise(resolve => setTimeout(resolve, 5)); closed = true; },
    closeLimiter: () => { limiterClosed = true; },
  });
  assert.deepEqual(output, { status: 'error', resources_closed: true });
  assert.equal(settled, true); assert.equal(closed, true); assert.equal(limiterClosed, true);
});

test('зависшая БД или ошибка закрытия пула не дают resources_closed', async () => {
  await assert.rejects(withAudioInspectionResources({ deadlineMs: 20, closeGraceMs: 30,
    run: () => new Promise(() => {}), closePool: async () => {}, closeLimiter: () => {} }), error => error.code === 'AUDIO_CLEANUP_UNKNOWN');
  await assert.rejects(withAudioInspectionResources({ deadlineMs: 100, closeGraceMs: 30,
    run: async () => ({}), closePool: async () => { throw new Error('secret'); }, closeLimiter: () => {} }), error => error.code === 'AUDIO_CLEANUP_UNKNOWN');
});

test('ошибка unlink или rmdir не выдаёт resources_closed и не раскрывает путь', async t => {
  const root = await mkdtemp(join(tmpdir(), 'audio-cleanup-test-'));
  const leftovers = [];
  t.after(async () => {
    for (const file of leftovers) { await unlink(file).catch(() => {}); await rmdir(dirname(file)).catch(() => {}); }
    await rmdir(root);
  });
  for (const failing of ['unlink', 'rmdir']) {
    let poolClosed = false, limiterClosed = false;
    const client = { async request(method) {
      if (method === 'crm.activity.list') return { result: [{ ID: '55', FILES: [{ urlDownload: 'https://example.invalid/?fileId=99' }] }], total: 1 };
      if (method === 'disk.file.get') return { result: { DOWNLOAD_URL: 'https://example.invalid/secret' } };
      throw new Error('Unexpected method');
    } };
    const work = signal => inspectDealAudio({ pool: fakePool(), client, dealId: 127142, signal, tempRoot: root,
      download: async (_url, file) => { leftovers.push(file); await writeFile(file, 'synthetic'); },
      inspectFile: async () => ({ channels: 1, duration: 'less_than_30s', multiple_audio_streams: false, source_stream_selection_verified: true, stereo_sample: null }),
      removeFile: failing === 'unlink' ? async () => { throw new Error('private-path'); } : unlink,
      removeDirectory: failing === 'rmdir' ? async () => { throw new Error('private-path'); } : rmdir,
    });
    await assert.rejects(withAudioInspectionResources({ run: work, deadlineMs: 1000, closeGraceMs: 1000,
      closePool: async () => { poolClosed = true; }, closeLimiter: () => { limiterClosed = true; },
    }), error => error.code === 'AUDIO_CLEANUP_UNKNOWN' && !error.message.includes('private-path'));
    assert.equal(poolClosed, true); assert.equal(limiterClosed, true);
  }
});
