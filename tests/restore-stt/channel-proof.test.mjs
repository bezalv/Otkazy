import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const ffmpegPackage = resolve('tmp/fftools/node_modules/ffmpeg-static');
const ffprobePackage = resolve('tmp/fftools/node_modules/@derhuerst/ffprobe-static');

// Это отдельный процесс с заглушкой ffprobe; любые сетевые запросы модели
// запрещены, аудио синтетическое и никуда за пределы loopback не передаётся.
const preloadSource = `
  const cp = require('node:child_process');
  global.fetch = async () => { throw new Error('external network forbidden'); };
  cp.execFile = (command, args, options, callback) => {
    const name = process.env.OTKAZY_TEST_PROBE;
    if (command !== 'ffprobe') {
      setImmediate(() => callback(new Error('unexpected media processing'), '', ''));
      return {};
    }
    if (name === 'error') {
      setImmediate(() => callback(new Error('synthetic ffprobe failure'), '', ''));
      return {};
    }
    const streams = name === 'non_audio' ? [{codec_type:'video'}]
      : [{ codec_type:'audio', ...(name === 'missing' ? {} : {channels: name === 'mono' ? 1 : name === 'zero' ? 0 : 'NaN'}) }];
    setImmediate(() => callback(null, JSON.stringify({streams,format:{duration:2}}), ''));
    return {};
  };
`;

async function freePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

test('моно подтверждается только корректным результатом ffprobe', async t => {
  const work = await mkdtemp(join(tmpdir(), 'otkazy-stt-channel-proof-'));
  t.after(async () => { await rm(work, {recursive:true,force:true}); });
  const preload = join(work, 'mock.cjs');
  await writeFile(preload, preloadSource, 'utf8');
  for (const [scenario, expected] of [
    ['mono', 'channels_mismatch'], ['error', 'bad_audio'], ['non_audio', 'bad_audio'],
    ['missing', 'bad_audio'], ['zero', 'bad_audio'], ['nonnumeric', 'bad_audio'],
  ]) {
    await t.test(scenario, async () => {
      const port = await freePort();
      const key = 'test-local-stt-key-24-symbols';
      const child = spawn(process.execPath, ['--require', preload, resolve('app/src/stt/server.cjs')], {
        env: { PATH:process.env.PATH, ...(process.env.SystemRoot ? {SystemRoot:process.env.SystemRoot} : {}),
          STT_KEY:key, STT_BIND:'127.0.0.1', STT_PORT:String(port), STT_FFPROBE_PATH:'ffprobe',
          OTKAZY_TEST_PROBE:scenario, WORK_DIR:join(work,scenario), LOG_FILE:join(work,`${scenario}.log`),
          RESERVE_MODEL:'gigaam', POLZA_API_KEY:'test-only' },
        stdio:['ignore','ignore','pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      try {
        const base = `http://127.0.0.1:${port}`;
        let ready = false;
        for (let i = 0; i < 100; i++) {
          if (child.exitCode !== null) throw new Error(`Тестовый сервис завершился: ${stderr}`);
          try { ready = (await fetch(`${base}/health`)).ok; if (ready) break; } catch { /* запускается */ }
          await delay(30);
        }
        assert.equal(ready, true, 'локальный сервис не запустился');
        const response = await fetch(`${base}/v1/transcribe?channels=stereo`, {
          method:'POST', headers:{'X-STT-Key':key}, body:Buffer.alloc(2048,1),
        });
        assert.equal(response.status, 422);
        assert.equal((await response.json()).error.code, expected);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise(resolveExit => child.once('exit', resolveExit));
          child.kill();
          await exited;
        }
      }
    });
  }
});

test('реальный ffprobe отличает одноканальное аудио от нечитаемого файла',
  {skip:!existsSync(ffmpegPackage) || !existsSync(ffprobePackage)}, async t => {
    const work=await mkdtemp(join(tmpdir(),'otkazy-stt-real-channel-'));
    const preload=join(work,'network-guard.cjs');
    await writeFile(preload,`global.fetch=async()=>{throw new Error('external network forbidden')};`,'utf8');
    const wav=join(work,'mono.wav');
    await promisify(execFile)(require(ffmpegPackage),['-v','error','-y','-f','lavfi','-i',
      'anullsrc=r=16000:cl=mono','-t','1','-c:a','pcm_s16le',wav]);
    const port=await freePort(), key='test-local-stt-key-24-symbols';
    const child=spawn(process.execPath,['--require',preload,resolve('app/src/stt/server.cjs')],{
      env:{ PATH:process.env.PATH, ...(process.env.SystemRoot ? {SystemRoot:process.env.SystemRoot} : {}),
        STT_KEY:key,STT_BIND:'127.0.0.1',STT_PORT:String(port),STT_FFPROBE_PATH:require(ffprobePackage),
        WORK_DIR:join(work,'service'),LOG_FILE:join(work,'service.log'),RESERVE_MODEL:'gigaam',POLZA_API_KEY:'test-only'},
      stdio:'ignore',
    });
    t.after(async()=>{
      if(child.exitCode===null && child.signalCode===null) {const exit=new Promise(r=>child.once('exit',r));child.kill();await exit;}
      await rm(work,{recursive:true,force:true});
    });
    const base=`http://127.0.0.1:${port}`;
    let ready=false;
    for(let i=0;i<100;i++) {
      if(child.exitCode!==null) throw new Error('Тестовый сервис не запустился');
      try {ready=(await fetch(`${base}/health`)).ok;if(ready) break;} catch {}
      await delay(30);
    }
    assert.equal(ready,true);
    for (const [body,expected] of [[await readFile(wav),'channels_mismatch'],[Buffer.alloc(2048,1),'bad_audio']]) {
      const response=await fetch(`${base}/v1/transcribe?channels=stereo`,{
        method:'POST',headers:{'X-STT-Key':key},body,
      });
      assert.equal(response.status,422);
      assert.equal((await response.json()).error.code,expected);
    }
  });
