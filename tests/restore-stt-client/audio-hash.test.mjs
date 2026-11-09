import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createSttClient, verifiedAudioHash } from '../../app/src/stt-client.mjs';
import { prepareTranscriptArtifact } from '../../app/src/persistence/prejudge.mjs';

test('SHA привязан к скачанным байтам, запросу и неизменённому результату', async () => {
  let audio=Buffer.alloc(2048,11),onUpload=()=>{};const uploads=[];
  const server=createServer(async(req,res)=>{
    if(req.url==='/audio') {res.end(audio);return;}
    const chunks=[];for await(const part of req) chunks.push(Buffer.from(part));
    uploads.push(Buffer.concat(chunks));
    onUpload();
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true,model:'ai-sage/gigaam-v3',channels:2,
      segments:[{channel:1,start:1,end:2,text:'Мне подходит'}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const client=createSttClient({bitrix:{request:async()=>({result:{DOWNLOAD_URL:`${base}/audio`}})},
      sttUrl:base,sttKey:'test-only'});
    const meta={deal_id:42,file_id:'100',activity_id:'123',channel_count:2,call_date:'2026-11-03T00:00:00Z'};
    const first=await client(meta), expected=createHash('sha256').update(audio).digest('hex');
    assert.equal(first.success,true);assert.equal(first.audio_sha256,expected);assert.deepEqual(uploads[0],audio);
    assert.equal(verifiedAudioHash(first,meta),expected);
    assert.equal(prepareTranscriptArtifact(meta,first).payload.source.audio_bytes_sha256,expected);
    assert.equal(verifiedAudioHash({...first},meta),null);
    assert.equal(verifiedAudioHash(first,{...meta,deal_id:43}),null);
    audio=Buffer.alloc(2048,12);
    const second=await client(meta), expected2=createHash('sha256').update(audio).digest('hex');
    assert.equal(second.audio_sha256,expected2);assert.notEqual(expected,expected2);
    first.client_text='подмена';assert.equal(verifiedAudioHash(first,meta),null);
    assert.equal(prepareTranscriptArtifact(meta,first).payload.source.audio_bytes_sha256,null);
    onUpload=()=>{meta.call_direction='outgoing';};
    const changedRequest=await client(meta);
    assert.equal(changedRequest.success,false);assert.match(changedRequest.error,/изменились/);
  } finally {server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
});
