import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createSttClient } from '../../app/src/stt-client.mjs';
import { PrejudgeStageError, prepareTranscriptArtifact, prepareRawCollectionArtifact, prepareCommunicationsArtifact,
  prepareJudgeInputArtifact, savePrejudgeArtifact, hasPrejudgeArtifacts, markPrejudgeNeedsReview } from '../../app/src/persistence/prejudge.mjs';

const pglite = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const job = '00000000-0000-4000-8000-000000000101';
const lease = '00000000-0000-4000-8000-000000000102';
const scope = { operationId:job, leaseToken:lease, dealId:42, stageHistoryId:'101', loseDate:'2026-11-04T00:00:00Z' };
const request = { deal_id:42, file_id:7, activity_id:99, call_date:'2026-11-03T00:00:00Z',
  channel_count:2, download_url:'https://example.invalid/secret-url' };
const response = { success:true, formatted_dialog:'Клиент: Пока не готов', client_text:'Пока не готов',
  manager_text:'', transcript_engine:'reserve:gigaam', total_replicas:1, channel_count:2 };
const communication = { type:'call', activity_id:99, date:'2026-11-03T00:00:00Z', audio_url:'https://example.invalid/secret-url',
  _needs_transcription:true, transcript:response.formatted_dialog, transcript_client_text:response.client_text };

test('пустой ответ сохраняется только с проверенными аудиобайтами и непротиворечивым покрытием mono/stereo', async () => {
  let body;
  const server=createServer(async(req,res)=>{
    if(req.url==='/audio'){res.end(Buffer.alloc(2048,17));return;}
    for await(const _ of req){};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(body));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const client=createSttClient({bitrix:{request:async()=>({result:{DOWNLOAD_URL:`${base}/audio`}})},
      sttUrl:base,sttKey:'test-only',tempRoot:resolve('tmp')});
    for(const channels of [1,2])for(const count of [0,1]){
      const meta={deal_id:42,file_id:'7',activity_id:'99',channel_count:channels,call_date:'2026-11-03T00:00:00Z'};
      body={ok:true,model:'ai-sage/gigaam-v3',channels,duration_sec:12,segments:[],transcription_coverage:{version:1,
        status:count?'incomplete':'no_empty_fragments',total_fragments:count,unrecognized_count:count,
        unrecognized_segments:count?[{channel:channels-1,start:1,end:2}]:[]}};
      const result=await client(meta);assert.equal(result.success,true);assert.equal(result.formatted_dialog,'');
      assert.throws(()=>prepareTranscriptArtifact(meta,result));
      const artifact=prepareTranscriptArtifact(meta,result,{allowEmpty:true});
      assert.equal(artifact.payload.status,'verified_stt_response');
      assert.equal(artifact.payload.transcript.formatted_dialog,'');
      assert.deepEqual(artifact.payload.transcript.transcription_coverage,body.transcription_coverage);
      assert.throws(()=>prepareTranscriptArtifact(meta,{...result,audio_sha256:'a'.repeat(64)},{allowEmpty:true}));
    }
    // Клиент получил пустую реплику в segments, а карта ошибочно заявляет,
    // что она распознана: корректный хеш источника не делает ответ согласованным.
    const meta={deal_id:42,file_id:'7',activity_id:'99',channel_count:2,call_date:'2026-11-03T00:00:00Z'};
    body={ok:true,model:'ai-sage/gigaam-v3',channels:2,duration_sec:12,
      segments:[{channel:0,start:1,end:2,text:''}],transcription_coverage:{version:1,status:'no_empty_fragments',
        total_fragments:1,unrecognized_count:0,unrecognized_segments:[]}};
    const contradiction=await client(meta);assert.equal(contradiction.success,true);assert.equal(contradiction.formatted_dialog,'');
    assert.throws(()=>prepareTranscriptArtifact(meta,contradiction,{allowEmpty:true}),/покрытия/);
    // Старый GigaAM может вернуть пустой ответ без карты покрытия. Даже
    // реальный SHA источника не подтверждает в нём границы пропусков.
    body={ok:true,model:'ai-sage/gigaam-v3',channels:2,duration_sec:12,segments:[]};
    const legacy=await client(meta);assert.equal(legacy.success,true);assert.equal(legacy.formatted_dialog,'');
    assert.throws(()=>prepareTranscriptArtifact(meta,legacy,{allowEmpty:true}),/покрытия/);
  } finally {server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
});

test('подготовка записывает текст, но не сохраняет адрес источника как секрет', () => {
  const t = prepareTranscriptArtifact(request, response);
  assert.equal(t.payload.transcript.client_text, 'Пока не готов');
  assert.equal(t.payload.source.audio_bytes_sha256, null);
  assert.doesNotMatch(JSON.stringify(t), /secret-url/);
  const c = prepareCommunicationsArtifact(42,[communication],[]);
  const f = prepareJudgeInputArtifact(42,[communication],{ facts:[{content:'Ссылка https://example.invalid/audio.ogg?token=SECRET'},
    {content:'Обычная ссылка https://shop.example.invalid/products/door?id=42'}] });
  assert.doesNotMatch(JSON.stringify([c,f]), /secret-url/);
  assert.doesNotMatch(JSON.stringify(f), /token=SECRET/);
  assert.match(f.payload.facts_packet.facts[0].content,/https:\/\/example\.invalid\/audio\.ogg\?token=/);
  assert.equal(f.payload.facts_packet.facts[1].content,'Обычная ссылка https://shop.example.invalid/products/door?id=42');
  assert.equal(c.payload.communications[0].transcript_client_text, 'Пока не готов');
  const raw=prepareRawCollectionArtifact({raw:{calls:[{ID:99,SETTINGS:{RECORD_URL:'https://example.invalid/secret-url'}}],
    comments:[],tasks:[],chats:[],sessions:[{session_id:1,history:{chatId:2,
      message:{3:{id:3,TEXT:'Сообщение клиента https://example.invalid/audio.ogg?token=SECRET',DATE:'2026-11-03T00:00:00Z',SENDER_ID:55,params:{fileId:7}}},
      files:{7:{id:7,name:'a.ogg',type:'audio',downloadUrl:'https://example.invalid/secret-url'}}}}]}});
  assert.match(raw.payload.sessions[0].messages[0].text,/^Сообщение клиента https:\/\/example\.invalid\/audio\.ogg\?token=/);
  assert.equal(raw.payload.sessions[0].messages[0].sender_id,55);
  assert.equal(raw.payload.sessions[0].messages[0].date,'2026-11-03T00:00:00Z');
  assert.deepEqual(raw.payload.sessions[0].messages[0].file_ids,['7']);
  assert.doesNotMatch(JSON.stringify(raw),/secret-url|token=SECRET/);
  const links=prepareJudgeInputArtifact(42,[],{facts:[{content:'https://portal.example.invalid/rest/17/VERYSECRET/crm.deal.get'},
    {content:'https://cdn.example.invalid/x?X-Amz-Signature=VERYSECRET&size=12'},
    {content:'https://user:VERYSECRET@portal.example.invalid/page'}]});
  assert.doesNotMatch(JSON.stringify(links.payload),/VERYSECRET/);
  assert.match(links.payload.facts_packet.facts[1].content,/size=12/);
});

test('запись в изолированную БД требует действующую аренду и подтверждённый переход', { skip:!existsSync(pglite) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglite).href);
  const db = new PGlite();
  try {
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated');
    await db.exec(`CREATE TABLE public.lost_processing_jobs (id uuid PRIMARY KEY, deal_id integer NOT NULL,
      status text NOT NULL, lease_token uuid, lease_until timestamptz, request_key text NOT NULL, lose_date timestamptz NOT NULL,
      trigger_type text NOT NULL DEFAULT 'live',last_error text,updated_at timestamptz,origin_stage_history_id text);
      CREATE TABLE public.lost_audio_wait (deal_id integer PRIMARY KEY, lose_date timestamptz NOT NULL,
        origin_stage_history_id text,state text NOT NULL,next_check_at timestamptz NOT NULL)`);
    await db.exec(readFileSync('db/proposals/20261109_prejudge_artifacts.sql','utf8'));
    await db.query(`INSERT INTO public.lost_processing_jobs (id,deal_id,status,lease_token,lease_until,request_key,lose_date,trigger_type)
      VALUES ($1,42,'processing',$2,now()+interval '1 hour','bitrix24:deal-stage-history:101','2026-11-04T00:00:00Z','live')`,[job,lease]);
    const pool = { async connect() { return { query(q) { return typeof q==='string' ? db.query(q) : db.query(q.text,q.values); }, release(){} }; } };
    const artifact = prepareTranscriptArtifact(request,response);
    assert.equal(await hasPrejudgeArtifacts(pool,scope),false);
    assert.equal((await savePrejudgeArtifact(pool,{...scope,artifact})).saved,true);
    assert.equal(await hasPrejudgeArtifacts(pool,scope),true);
    assert.equal((await savePrejudgeArtifact(pool,{...scope,artifact})).saved,true);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_prejudge_artifacts')).rows[0].n,1);
    const secondJob='00000000-0000-4000-8000-000000000105';
    await db.query(`INSERT INTO public.lost_processing_jobs (id,deal_id,status,lease_token,lease_until,request_key,lose_date,trigger_type)
      VALUES ($1,42,'processing',$2,now()+interval '1 hour','manual:test','2026-11-04T00:00:00Z','manual')`,[secondJob,lease]);
    assert.equal(await hasPrejudgeArtifacts(pool,{...scope,operationId:secondJob}),true);
    assert.equal(await hasPrejudgeArtifacts(pool,{...scope,operationId:secondJob,stageHistoryId:'102'}),false);
    assert.equal(await markPrejudgeNeedsReview(pool,{...scope,operationId:secondJob}),true);
    const secondState=(await db.query('SELECT status,last_error FROM public.lost_processing_jobs WHERE id=$1',[secondJob])).rows[0];
    assert.deepEqual(secondState,{status:'needs_review',last_error:'prejudge_materials_need_review'});
    const altered = prepareTranscriptArtifact(request,{...response,client_text:'Изменённый текст'});
    assert.notEqual(altered.key,artifact.key);
    await assert.rejects(savePrejudgeArtifact(pool,{...scope,artifact:{...altered,key:artifact.key}}),PrejudgeStageError);
    await assert.rejects(savePrejudgeArtifact(pool,{...scope,stageHistoryId:'102',artifact}),PrejudgeStageError);
    await assert.rejects(savePrejudgeArtifact(pool,{...scope,loseDate:'2026-11-04T00:00:00.001Z',artifact}),PrejudgeStageError);
    await assert.rejects(savePrejudgeArtifact(pool,{...scope,leaseToken:'00000000-0000-4000-8000-000000000103',artifact}),PrejudgeStageError);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_prejudge_artifacts')).rows[0].n,1);
    await db.query("UPDATE public.lost_prejudge_artifacts SET payload='{}'::jsonb WHERE job_id=$1",[job]);
    await assert.rejects(savePrejudgeArtifact(pool,{...scope,artifact}),PrejudgeStageError);
    await db.query(`INSERT INTO public.lost_audio_wait VALUES (42,'2026-11-04T00:00:00Z','101','waiting','2026-11-04T01:00:00Z')`);
    const audioJob='00000000-0000-4000-8000-000000000104';
    await db.query(`INSERT INTO public.lost_processing_jobs (id,deal_id,status,lease_token,lease_until,request_key,lose_date,trigger_type)
      SELECT $1,42,'processing',$2,now()+interval '1 hour',
      'audio-wait:' || deal_id::text || ':' || (extract(epoch from lose_date)*1000000)::bigint::text || ':' ||
      (extract(epoch from next_check_at)*1000000)::bigint::text,lose_date,'audio_wait' FROM public.lost_audio_wait`,[audioJob,lease]);
    assert.equal((await savePrejudgeArtifact(pool,{...scope,operationId:audioJob,artifact})).saved,true);
    await db.query("UPDATE public.lost_audio_wait SET origin_stage_history_id='102' WHERE deal_id=42");
    await assert.rejects(savePrejudgeArtifact(pool,{...scope,operationId:audioJob,artifact}),PrejudgeStageError);
  } finally { await db.close(); }
});
