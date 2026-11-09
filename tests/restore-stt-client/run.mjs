import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rmdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createSttClient, reserveToTranscript, verifiedAudioOnly } from '../../app/src/stt-client.mjs';
import { execFile, execFileSync } from 'node:child_process';
import { resolveBinary } from '../../app/src/stt/binaries.mjs';

test('моно-голосовое неизвестного участника не превращается в речь менеджера или клиента', () => {
  const result = reserveToTranscript({ channels: 1, segments: [{ channel: 0, start: 0, text: 'Хочу уточнить условия' }] },
    { channel_count: 1, speaker_role: 'Участник чата', call_direction: 'unknown' });
  assert.equal(result.manager_text, '');
  assert.equal(result.client_text, '');
  assert.equal(result.direction, 'unknown');
  assert.equal(result.formatted_dialog, 'Участник чата: Хочу уточнить условия');
});
import { transcribeCalls } from '../../app/src/calls/index.mjs';
import { normalizeCommunications } from '../../app/src/collect/normalize.mjs';

const key = 'local-only-test-key';
const meta = { file_id: '100', activity_id: '123', comm_index: 0, channel_count: 2, call_direction: 'incoming' };
const segments = [
  { channel: 1, start: 2, end: 3, text: 'Здравствуйте' },
  { channel: 0, start: 1, end: 2, text: 'Добрый день' },
  { channel: 1, start: 3, end: 4, text: 'Мне нужна цена' },
];

async function setup(handler) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'otkazy-stt-test-'));
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, tempRoot,
    async close() {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      assert.deepEqual(await readdir(tempRoot), []);
      await rmdir(tempRoot);
    },
  };
}

function makeClient(env, options = {}) {
  const calls = [];
  const bitrix = { async request(method, body) {
    calls.push({ method, body });
    return { result: { DOWNLOAD_URL: `${env.base}/audio` } };
  } };
  const transcribe = createSttClient({ bitrix, sttUrl: env.base, sttKey: key, tempRoot: env.tempRoot, ...options });
  return { transcribe, calls };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('повторное чтение файла сверяет снимок голосового до скачивания и STT', async () => {
 let gets=0,uploads=0;
 const env=await setup(async (req,res)=>{
  if(req.url==='/audio'){gets++;res.end(Buffer.alloc(1024));return;}
  uploads++;for await(const chunk of req)void chunk;
  sendJson(res,200,{ok:true,model:'ai-sage/gigaam-v3',channels:1,segments:[{channel:0,start:0,end:1,text:'Текст'}]});
 });
 try {
  const original={ID:'100',NAME:'voice.ogg',SIZE:'1024',UPDATE_TIME:'2026-11-01T00:00:00Z',DOWNLOAD_URL:`${env.base}/audio`};
  let current=original;
  let hasOnlyAudio=true;
  const transcribe=createSttClient({bitrix:{async request(){return {result:current};}},sttUrl:env.base,sttKey:key,tempRoot:env.tempRoot,
   probeAudioOnly:async()=>hasOnlyAudio});
  const options={...meta,channel_count:1,speaker_role:'Участник чата',require_audio_only:true,voice_file_snapshot:{id:'100',name:'voice.ogg',size:'1024',modified:'2026-11-01T00:00:00Z'}};
  for(const change of [{ID:'101'},{NAME:'other.ogg'},{SIZE:'2048'},{UPDATE_TIME:'другая'},
   {MIME_TYPE:'video/mp4'},{type:'image'},{ID:null}]){
   current={...original,...change};assert.equal((await transcribe(options)).success,false);
  }
  assert.equal(gets,0);assert.equal(uploads,0);
  current=original;hasOnlyAudio=false;assert.equal((await transcribe(options)).success,false);assert.equal(gets,1);assert.equal(uploads,0);
  hasOnlyAudio=true;const result=await transcribe(options);assert.equal(result.success,true);assert.equal(gets,2);assert.equal(uploads,1);
  assert.equal(verifiedAudioOnly(result,options),true);assert.equal(verifiedAudioOnly(JSON.parse(JSON.stringify(result)),options),false);
  assert.equal(verifiedAudioOnly(result,{...options,file_id:'101'}),false);
  result.formatted_dialog='Подменённый текст';assert.equal(verifiedAudioOnly(result,options),false);
 } finally {await env.close();}
});

test('реальный ffprobe пропускает звук и отклоняет видео со звуковой дорожкой даже в .ogg', async () => {
 const fixtureDir=await mkdtemp(join(tmpdir(),'voice-probe-fixture-'));
 const audio=join(fixtureDir,'audio.wav'),ogg=join(fixtureDir,'audio.ogg'),mp3=join(fixtureDir,'audio.mp3'),
  video=join(fixtureDir,'disguised.ogg'),twoAudio=join(fixtureDir,'two-audio.ogg');
 const ffmpeg=resolveBinary('ffmpeg');
 execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','pcm_s16le',audio],{windowsHide:true});
 execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','libopus','-f','ogg',ogg],{windowsHide:true});
 execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','libmp3lame','-f','mp3',mp3],{windowsHide:true});
 execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','color=c=black:s=64x64:r=5:d=1',
  '-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','mpeg4','-c:a','mp3','-shortest','-f','matroska',video],{windowsHide:true});
 execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=1',
  '-f','lavfi','-i','sine=frequency=880:duration=1','-map','0:a','-map','1:a','-c:a','libopus','-f','ogg',twoAudio],{windowsHide:true});
 const info=JSON.parse(execFileSync(resolveBinary('ffprobe'),['-v','error','-show_entries','stream=codec_type:format=format_name',
  '-of','json',twoAudio],{encoding:'utf8',windowsHide:true}));
 assert.equal(info.format.format_name,'ogg');assert.deepEqual(info.streams.map(item=>item.codec_type),['audio','audio']);
 let data=await readFile(audio),uploads=0;
 const env=await setup(async(req,res)=>{
  if(req.url==='/audio'){res.end(data);return;}
  uploads++;for await(const chunk of req)void chunk;
  sendJson(res,200,{ok:true,model:'ai-sage/gigaam-v3',channels:1,segments:[{channel:0,start:0,end:1,text:'Текст'}]});
 });
 try {
  const client=createSttClient({sttUrl:env.base,sttKey:key,tempRoot:env.tempRoot});
  const options={file_id:'link0',download_url:`${env.base}/audio`,channel_count:1,speaker_role:'Участник чата',require_audio_only:true};
  const good=await client(options);assert.equal(good.success,true);assert.equal(verifiedAudioOnly(good,options),true);assert.equal(uploads,1);
  data=await readFile(ogg);const validOgg=await client(options);assert.equal(validOgg.success,true);assert.equal(verifiedAudioOnly(validOgg,options),true);
  data=await readFile(mp3);const validMp3=await client(options);assert.equal(validMp3.success,true);assert.equal(verifiedAudioOnly(validMp3,options),true);
  assert.equal(uploads,3);
  data=await readFile(video);
  const bad=await client(options);assert.equal(bad.success,false);assert.equal(verifiedAudioOnly(bad,options),false);assert.equal(uploads,3);
  data=await readFile(twoAudio);assert.equal((await client(options)).success,false);assert.equal(uploads,3);
 } finally {await env.close();for(const file of [audio,ogg,mp3,video,twoAudio])await unlink(file);await rmdir(fixtureDir);}
});

test('ffprobe не открывает вложенный адрес подменённого плейлиста', async () => {
 let nestedRequests=0,uploads=0;
 const env=await setup(async(req,res)=>{
  if(req.url==='/audio'){
   res.writeHead(200,{'Content-Type':'application/octet-stream'});
   const port=req.socket.localPort;
   res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:10\n${'#padding\n'.repeat(180)}#EXTINF:10,\nhttp://127.0.0.1:${port}/nested\n#EXT-X-ENDLIST\n`);
   return;
  }
  if(req.url==='/nested'){nestedRequests++;res.end(Buffer.alloc(2048));return;}
  uploads++;for await(const chunk of req)void chunk;res.end('{}');
 });
 const playlist=join(env.tempRoot,'proof-playlist.m3u8');
 try {
  // Контроль: тот же плейлист способен открыть локальный адрес при явно
  // разрешённых сетевых протоколах. Иначе отрицательный тест был бы пустым.
  await writeFile(playlist,`#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n${env.base}/nested\n#EXT-X-ENDLIST\n`);
  await new Promise(resolve=>execFile(resolveBinary('ffprobe'),['-v','error','-protocol_whitelist','file,http,tcp,crypto,data',playlist],
   {timeout:3000,windowsHide:true},()=>resolve()));
  assert.ok(nestedRequests>0);nestedRequests=0;
  const client=createSttClient({sttUrl:env.base,sttKey:key,tempRoot:env.tempRoot});
  const result=await client({file_id:'link0',download_url:`${env.base}/audio`,channel_count:1,
   speaker_role:'Участник чата',require_audio_only:true});
  assert.equal(result.success,false);assert.equal(nestedRequests,0);assert.equal(uploads,0);
 } finally {await unlink(playlist);await env.close();}
});

test('стерео скачивается через disk.file.get, передаётся по потоку, каналы сохраняют роли', async () => {
  let uploaded = 0;
  const env = await setup(async (req, res) => {
    if (req.url === '/audio') { res.end(Buffer.alloc(2048)); return; }
    assert.equal(req.url, '/v1/transcribe?channels=stereo');
    assert.equal(req.headers['x-stt-key'], key);
    for await (const chunk of req) uploaded += chunk.length;
    sendJson(res, 200, { ok: true, model: 'ai-sage/gigaam-v3', channels: 2, segments, duration_sec: 10 });
  });
  try {
    const { transcribe, calls } = makeClient(env);
    // Числовой file_id разрешается заново через Битрикс, входная ссылка игнорируется.
    const result = await transcribe({ ...meta, download_url: 'https://untrusted.invalid/never-requested' });
    assert.deepEqual(calls, [{ method: 'disk.file.get', body: { id: 100 } }]);
    assert.equal(uploaded, 2048);
    assert.equal(result.success, true);
    assert.equal(result.transcript_engine, 'reserve:gigaam');
    assert.equal(result.formatted_dialog, 'Менеджер: Добрый день\nКлиент: Здравствуйте Мне нужна цена');
    assert.equal(result.manager_text, 'Добрый день');
    assert.equal(result.client_text, 'Здравствуйте Мне нужна цена');
  } finally { await env.close(); }
});

test('моно голосовое по роли клиента получает client_text, без повторного прохода', async () => {
  let reserveCalls = 0;
  const env = await setup(async (req, res) => {
    if (req.url === '/audio') { res.end(Buffer.alloc(1024)); return; }
    reserveCalls++;
    assert.equal(req.url, '/v1/transcribe?channels=mono');
    for await (const chunk of req) void chunk;
    sendJson(res, 200, { ok: true, model: 'aiesa/transcribe', channels: 1, segments: [{ channel: 0, start: 0, text: 'Текст' }] });
  });
  try {
    const { transcribe } = makeClient(env);
    const result = await transcribe({ ...meta, channel_count: 1, speaker_role: 'Клиент' });
    assert.equal(result.formatted_dialog, 'Клиент: Текст');
    assert.equal(result.client_text, 'Текст');
    assert.equal(result.manager_text, '');
    assert.equal(result._transcript_mode, 'mono');
    assert.equal(result.transcript_engine, 'reserve:aiesa');
    assert.equal(reserveCalls, 1);
  } finally { await env.close(); }
});

test('подтверждённое несовпадение каналов запускает моно', async () => {
  const modes = [];
  const env = await setup(async (req, res) => {
    if (req.url === '/audio') { res.end(Buffer.alloc(1024)); return; }
    for await (const chunk of req) void chunk;
    modes.push(req.url);
    if (req.url.includes('stereo')) return sendJson(res, 422, { ok: false, error: { code: 'channels_mismatch', retryable: false } });
    return sendJson(res, 200, { ok: true, model: 'ai-sage/gigaam-v3', channels: 1, segments: [{ channel: 0, start: 0, text: 'Разговор' }] });
  });
  try {
    const { transcribe } = makeClient(env);
    const result = await transcribeCalls({ dealData: { deal_id: 42, communications: [{
      type: 'call', activity_id: '123', _needs_transcription: true, audio_url: 'https://example.test/?fileId=100',
    }] }, transcribe });
    assert.deepEqual(modes, ['/v1/transcribe?channels=stereo', '/v1/transcribe?channels=mono']);
    assert.equal(result.communications[0]._transcript_mode, 'mono');
    assert.equal(result.communications[0].transcript, 'Говорящий: Разговор');
    assert.equal(result.transcription_errors.length, 0);
  } finally { await env.close(); }
});

test('bad_audio без доказательства одного канала не включает моно', async () => {
  const modes=[];
  const env=await setup(async(req,res)=>{
    if(req.url==='/audio'){res.end(Buffer.alloc(1024));return;}
    for await(const chunk of req)void chunk;
    modes.push(req.url);sendJson(res,422,{ok:false,error:{code:'bad_audio',retryable:false}});
  });
  try {
    const {transcribe}=makeClient(env);
    const result=await transcribeCalls({dealData:{deal_id:42,communications:[{
      type:'call',activity_id:'123',_needs_transcription:true,audio_url:'https://example.test/?fileId=100'}]},transcribe});
    assert.deepEqual(modes,['/v1/transcribe?channels=stereo']);
    assert.equal(result.transcription_errors.length,1);
    assert.equal(result.communications[0]._transcribed,undefined);
  } finally {await env.close();}
});

test('размер проверяется до передачи в сервис при малом и неизвестном заранее большом файле', async () => {
  let bytes = 1023;
  let uploads = 0;
  const env = await setup(async (req, res) => {
    if (req.url === '/audio') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Transfer-Encoding': 'chunked' });
      res.write(Buffer.alloc(Math.min(bytes, 1500)));
      res.end(Buffer.alloc(Math.max(bytes - 1500, 0)));
      return;
    }
    uploads++;
    for await (const chunk of req) void chunk;
    sendJson(res, 200, { ok: true, channels: 2, segments: [] });
  });
  try {
    const { transcribe } = makeClient(env, { maxAudioBytes: 2048 });
    const short = await transcribe(meta);
    assert.equal(short.success, false);
    assert.equal(short.retryable, true);
    assert.equal(short.download_failed, true);
    bytes = 2049;
    const large = await transcribe(meta);
    assert.equal(large.success, false);
    assert.equal(large.retryable, false);
    assert.match(large.error, /размер/);
    assert.equal(uploads, 0);
  } finally { await env.close(); }
});

test('провал скачивания и HTML не отправляют данные в распознавание', async () => {
  let mode = '404';
  let uploads = 0;
  const env = await setup(async (req, res) => {
    if (req.url === '/audio') {
      if (mode === '404') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>' + 'x'.repeat(2048) + '</html>');
      return;
    }
    uploads++;
    res.end();
  });
  try {
    const { transcribe } = makeClient(env);
    assert.equal((await transcribe(meta)).retryable, true);
    mode = 'html';
    assert.equal((await transcribe(meta)).retryable, true);
    assert.equal(uploads, 0);
  } finally { await env.close(); }
});

test('ошибка сервиса сохраняет retryable, но не отдаёт его сообщения с секретами', async () => {
  const env = await setup(async (req, res) => {
    if (req.url === '/audio') { res.end(Buffer.alloc(1024)); return; }
    for await (const chunk of req) void chunk;
    sendJson(res, 401, { ok: false, error: { code: 'unauthorized', retryable: false, message: 'secret https://example.test/?auth=secret' } });
  });
  try {
    const { transcribe } = makeClient(env);
    const result = await transcribe(meta);
    assert.equal(result.retryable, false, JSON.stringify(result));
    assert.equal(result.success, false);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(JSON.stringify(result).includes('https://'), false);
  } finally { await env.close(); }
});

test('ранний отказ сервиса до чтения файла не приводит к успешному распознаванию', async () => {
  const env = await setup(async (req, res) => {
    if (req.url === '/audio') { res.end(Buffer.alloc(2 * 1024 * 1024)); return; }
    res.writeHead(401, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', retryable: false } }), () => req.destroy());
  });
  try {
    const { transcribe } = makeClient(env);
    const result = await transcribe(meta);
    assert.equal(result.success, false);
    assert.equal(result.reserve_failed, true);
    // Сервер вправе разорвать соединение вместе с ответом, тогда HTTP-код не получен.
    if (result.retryable === false) assert.match(result.error, /unauthorized/);
    else assert.match(result.error, /недоступен/);
  } finally { await env.close(); }
});

test('произвольный код ошибки сервиса не выводится в диагностике', async () => {
  const env = await setup(async (req, res) => {
    if (req.url === '/audio') { res.end(Buffer.alloc(1024)); return; }
    for await (const chunk of req) void chunk;
    sendJson(res, 502, { ok: false, error: { code: 'privatevalue', retryable: true } });
  });
  try {
    const { transcribe } = makeClient(env);
    const result = await transcribe(meta);
    assert.equal(result.retryable, true);
    assert.equal(JSON.stringify(result).includes('privatevalue'), false);
    assert.match(result.error, /HTTP 502/);
  } finally { await env.close(); }
});

test('ограничитель прекращает чтение потока раньше конца большого ответа', async () => {
  let chunksRead = 0;
  const env = await setup((req, res) => { res.writeHead(500); res.end(); });
  try {
    const fetchImpl = async () => new Response(new ReadableStream({
      pull(controller) {
        chunksRead++;
        controller.enqueue(new Uint8Array(1024));
        if (chunksRead === 100) controller.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    const { transcribe } = makeClient(env, { maxAudioBytes: 2048, fetchImpl });
    const result = await transcribe(meta);
    assert.equal(result.success, false);
    assert.equal(result.retryable, false);
    assert.ok(chunksRead < 100);
  } finally { await env.close(); }
});

test('таймаут скачивания возвращает повторяемую ошибку и удаляет временный файл', async () => {
  const env = await setup((req, res) => {
    if (req.url === '/audio') { setTimeout(() => res.end(Buffer.alloc(1024)), 250); return; }
    res.end();
  });
  try {
    const { transcribe } = makeClient(env, { downloadTimeoutMs: 40 });
    const result = await transcribe(meta);
    assert.equal(result.success, false);
    assert.equal(result.download_failed, true);
    assert.equal(result.retryable, true);
  } finally { await env.close(); }
});

test('таймаут ответа сервиса и неверный JSON считаются техническими сбоями', async () => {
  let mode = 'timeout';
  const env = await setup(async (req, res) => {
    if (req.url === '/audio') { res.end(Buffer.alloc(1024)); return; }
    for await (const chunk of req) void chunk;
    if (mode === 'timeout') { setTimeout(() => res.end('{}'), 250); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{');
  });
  try {
    const { transcribe } = makeClient(env, { reserveTimeoutMs: 50 });
    assert.equal((await transcribe(meta)).retryable, true);
    mode = 'invalid';
    assert.equal((await transcribe(meta)).retryable, true);
  } finally { await env.close(); }
});

test('success без segments/channels и невалидные каналы не принимаются за тишину', async () => {
  let body = { ok: true };
  const env = await setup(async (req, res) => {
    if (req.url === '/audio') { res.end(Buffer.alloc(1024)); return; }
    for await (const chunk of req) void chunk;
    sendJson(res, 200, body);
  });
  try {
    const { transcribe } = makeClient(env);
    assert.equal((await transcribe(meta)).retryable, true);
    body = { ok: true, channels: 2, segments: [{ channel: null, start: 0, text: 'Текст' }] };
    assert.equal((await transcribe(meta)).retryable, true);
    body = { ok: true, channels: 2, segments: [] };
    const silence = await transcribe(meta);
    assert.equal(silence.success, true);
    assert.equal(silence.formatted_dialog, '');
  } finally { await env.close(); }
});

test('моно-запрос с двухканальным ответом не приписывает обе стороны одному говорящему', async () => {
  const env = await setup(async (req, res) => {
    if (req.url === '/audio') { res.end(Buffer.alloc(1024)); return; }
    for await (const chunk of req) void chunk;
    sendJson(res, 200, { ok: true, channels: 2, segments });
  });
  try {
    const { transcribe } = makeClient(env);
    const result = await transcribe({ ...meta, channel_count: 1, speaker_role: 'Клиент' });
    assert.equal(result.success, false);
    assert.equal(result.retryable, true);
    assert.equal(result.formatted_dialog, undefined);
    assert.throws(() => reserveToTranscript({ channels: 2, segments }, { ...meta, channel_count: 1 }), /число каналов/);
  } finally { await env.close(); }
});

test('прямые ссылки голосового используются только переданными внутренним вызывающим кодом', async () => {
  let downloaded = 0;
  const env = await setup(async (req, res) => {
    if (req.url === '/audio') { downloaded++; res.end(Buffer.alloc(1024)); return; }
    for await (const chunk of req) void chunk;
    sendJson(res, 200, { ok: true, channels: 1, segments: [] });
  });
  try {
    const { transcribe, calls } = makeClient(env);
    const result = await transcribe({ ...meta, file_id: 'link0', channel_count: 1, download_url: `${env.base}/audio` });
    assert.equal(result.success, true);
    assert.equal(downloaded, 1);
    assert.equal(calls.length, 0);
  } finally { await env.close(); }
});

test('нормализатор голосового сохраняет неизвестного автора при настоящем контракте адаптера', async () => {
  const env = await setup(async (req, res) => {
    if (req.url === '/audio') { res.end(Buffer.alloc(1024)); return; }
    for await (const chunk of req) void chunk;
    sendJson(res, 200, { ok: true, model: 'ai-sage/gigaam-v3', channels: 1, segments: [{ channel: 0, start: 0, text: 'Нужны окна' }] });
  });
  try {
    const { transcribe, calls } = makeClient(env);
    const collection = {
      deal_id: 42, silent: true, _status: 'pending_normalization', deal_data: { deal_id: 42 },
      _sources: Object.fromEntries(['calls', 'openlines', 'comments', 'tasks'].map(id => [id, { complete: true }])),
      raw: { calls: [], comments: [], tasks: [], chats: [{ CHAT_ID: 2, CONNECTOR_ID: 'wz_test' }], sessions: [{
        session_id: 1, history: { chat: { 2: {} }, files: [{ id: 100, type: 'audio', name: 'voice.ogg' }],
          message: { 1: { senderid: 0, text: '', params: { FILE_ID: [100] } } } },
      }] },
    };
    const result = await normalizeCommunications({ collection, transcribeVoice: transcribe,
      async resolveFile() { return { NAME: 'voice.ogg', DOWNLOAD_URL: `${env.base}/audio` }; },
    });
    assert.equal(result.deal_data.communications[0].text, 'Участник чата: Нужны окна');
    assert.equal(result.deal_data.communications[0].transcript_client_text, '');
    assert.equal(result.deal_data.communications[0].transcript_manager_text, '');
    assert.equal(result.deal_data.communications[0]._wazzup_author_ambiguous, true);
    assert.deepEqual(result.voice_failures, []);
    assert.equal(calls.length, 1);
  } finally { await env.close(); }
});

test('формат отрезков совпадает с исходником для стерео и моно', () => {
  const source = readFileSync('prototype/lib/stt-reliability.js', 'utf8');
  const reference = runInNewContext(`${source}\n;sttReserveToTranscript;`);
  for (const [body, request] of [
    [{ model: 'ai-sage/gigaam-v3', channels: 2, segments }, meta],
    [{ model: 'aiesa/transcribe', channels: 1, segments: [{ channel: 0, start: 0, text: 'текст' }] }, { ...meta, channel_count: 1, speaker_role: 'Говорящий' }],
    [{ model: 'ai-sage/gigaam-v3', channels: 2, segments: [] }, meta],
  ]) {
    const actual = reserveToTranscript(body, request);
    delete actual._transcript_mode;
    if (body.model.includes('gigaam')) {
      assert.deepEqual(actual.transcription_coverage, {version:0,status:'unknown_legacy'});
      delete actual.transcription_coverage;
    }
    // VM создаёт объекты другого контекста, поэтому сравниваем сериализованные данные.
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(reference(body, request))));
  }
});
