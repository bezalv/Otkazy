import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveBinary } from '../../app/src/stt/binaries.mjs';
import { exportAudio, runAudioExport, sealAudioReport, MAX_AUDIO, MAX_STDOUT } from '../../app/src/pilot/audio-export.mjs';

const keyPair=generateKeyPairSync('rsa',{modulusLength:2048});
const encodedKey=Buffer.from(keyPair.publicKey.export({type:'spki',format:'pem'})).toString('base64');
function unseal(envelope, privateKey=keyPair.privateKey){
  const key=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(envelope.encrypted_key,'base64'));
  try {const d=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));d.setAuthTag(Buffer.from(envelope.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(envelope.ciphertext,'base64')),d.final()]).toString('utf8'));}finally{key.fill(0);}
}
function fixture(){
  const out=spawnSync(resolveBinary('ffmpeg'),['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=400:duration=1','-ac','2','-acodec','libmp3lame','-f','mp3','pipe:1'],{windowsHide:true,maxBuffer:1024*1024});
  assert.equal(out.status,0);assert.ok(out.stdout.length>44);return out.stdout;
}
function mocked(bytes=fixture()){
  const calls=[];const client={async request(method,body){calls.push([method,body]);
    if(method==='crm.activity.get')return{result:{ID:1660320,OWNER_TYPE_ID:2,OWNER_ID:126554,TYPE_ID:2,FILES:[{urlDownload:'https://dinalnsk.bitrix24.ru/?fileId=45'}]}};
    if(method==='disk.file.get')return{result:{DOWNLOAD_URL:'https://dinalnsk.bitrix24.ru/audio'}};
    throw new Error('unexpected');}};
  const fetchImpl=async(url,options)=>{assert.equal(url.hostname,'dinalnsk.bitrix24.ru');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.headers,undefined);return new Response(bytes,{status:200,headers:{'content-type':'audio/mpeg'}});};
  return {client,fetchImpl,calls,bytes};
}
test('исходные аудиобайты отдаются только через проверенные read-only методы',async()=>{
  const m=mocked();let closed=false;
  const report=await runAudioExport({dealId:'126554',activityId:'1660320',client:m.client,fetchImpl:m.fetchImpl,closeLimiter:()=>{closed=true;}});
  assert.equal(report.status,'completed');assert.equal(report.service_closed,true);assert.equal(report.resources_closed,true);assert.equal(closed,true);
  assert.deepEqual(m.calls.map(x=>x[0]),['crm.activity.get','disk.file.get']);assert.deepEqual(Buffer.from(report.audio_base64,'base64'),m.bytes);
  assert.equal(report.format,'mp3');assert.equal(report.bytes,m.bytes.length);assert.match(report.sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(unseal(sealAudioReport(report,encodedKey)),report);
});
test('конверт реально расшифровывает запись 438048 байт, не раскрывает её и не превышает лимит stdout',()=>{
  const audio=randomBytes(438048),report={status:'completed',deal_id:'126554',activity_id:'1660320',format:'mp3',bytes:audio.length,sha256:'a'.repeat(64),audio_base64:audio.toString('base64'),resources_closed:true,service_closed:true};
  const sealed=sealAudioReport(report,encodedKey),serialized=JSON.stringify(sealed)+'\n';
  assert.ok(Buffer.byteLength(serialized)<MAX_STDOUT);assert.equal(serialized.includes(report.audio_base64),false);
  assert.deepEqual(Buffer.from(unseal(sealed).audio_base64,'base64'),audio);
  const corrupted={...sealed,tag:Buffer.alloc(16).toString('base64')};assert.throws(()=>unseal(corrupted));
  assert.throws(()=>sealAudioReport(report,'invalid'));assert.throws(()=>sealAudioReport({...report,service_closed:false},encodedKey));
  const max=Buffer.alloc(MAX_AUDIO).toString('base64');assert.ok(Buffer.byteLength(JSON.stringify(sealAudioReport({...report,bytes:MAX_AUDIO,audio_base64:max},encodedKey))+'\n')<=MAX_STDOUT);
  assert.throws(()=>sealAudioReport({...report,bytes:MAX_AUDIO+1,audio_base64:Buffer.alloc(MAX_AUDIO+1).toString('base64')},encodedKey));
});
test('чужая сделка, владелец и редирект останавливают выгрузку',async()=>{
  const m=mocked();const signal=new AbortController().signal;
  await assert.rejects(()=>exportAudio({dealId:'1',activityId:'1660320',client:m.client,fetchImpl:m.fetchImpl,signal}));assert.equal(m.calls.length,0);
  const wrong={async request(){return{result:{ID:1660320,OWNER_TYPE_ID:2,OWNER_ID:1,TYPE_ID:2}};}};
  await assert.rejects(()=>exportAudio({dealId:'126554',activityId:'1660320',client:wrong,fetchImpl:m.fetchImpl,signal}));
  const evil=async()=>new Response(null,{status:302,headers:{location:'https://example.invalid/audio'}});
  const denied=await runAudioExport({dealId:'126554',activityId:'1660320',client:m.client,fetchImpl:evil,closeLimiter:()=>{}});
  assert.deepEqual(denied,{status:'error',phase:'audio_download',error_code:'audio_unavailable',resources_closed:true,service_closed:true});
});
test('ограничение размера и формат проверяются до формирования результата',async()=>{
  const m=mocked();
  const large=async()=>new Response(Buffer.alloc(MAX_AUDIO+1),{status:200,headers:{'content-type':'audio/mpeg'}});
  const report=await runAudioExport({dealId:'126554',activityId:'1660320',client:m.client,fetchImpl:large,closeLimiter:()=>{}});
  assert.equal(report.error_code,'too_large');assert.equal(report.service_closed,true);
  const html=async()=>new Response('<html>secret</html>',{status:200,headers:{'content-type':'text/html'}});
  assert.equal((await runAudioExport({dealId:'126554',activityId:'1660320',client:m.client,fetchImpl:html,closeLimiter:()=>{}})).error_code,'audio_unavailable');
});
test('abort ждёт закрытия ресурсов и скрывает детали ошибки',async()=>{
  const m=mocked();let closed=false;
  const fetchImpl=async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('secret')),{once:true}));
  const report=await runAudioExport({dealId:'126554',activityId:'1660320',client:m.client,fetchImpl,closeLimiter:()=>{closed=true;},deadlineMs:30,closeGraceMs:1000});
  assert.equal(report.error_code,'deadline');assert.equal(report.service_closed,true);assert.equal(closed,true);assert.equal(JSON.stringify(report).includes('secret'),false);
});
test('CLI требует правильную пару и sealed-ключ до сетевых действий',()=>{
  const cli=spawnSync(process.execPath,['app/src/pilot/audio-export.mjs','1','1660320','--sealed','bad'],{encoding:'utf8'});
  assert.notEqual(cli.status,0);assert.equal(cli.stdout,'');assert.match(cli.stderr,/не завершена/);
});
