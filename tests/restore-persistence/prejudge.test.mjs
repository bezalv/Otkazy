import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
