import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCurrentTransition } from '../../app/src/collect/index.mjs';
import { runJob } from '../../app/src/worker/run-job.mjs';
import { PrejudgeStageError } from '../../app/src/persistence/prejudge.mjs';
import { savePrejudgeArtifact, prepareBeginArtifact } from '../../app/src/persistence/prejudge.mjs';
import { claimSttAttempt } from '../../app/src/persistence/stt-attempts.mjs';
import { createJobQueue } from '../../app/src/queue/index.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const date='2026-11-04T00:00:00.000Z';
const job={id:'00000000-0000-4000-8000-000000000101',lease_token:'00000000-0000-4000-8000-000000000102',
  deal_id:42,lose_date:date,trigger_type:'manual',request_key:'manual:42',silent:true};
const event={ID:'101',STAGE_ID:'C23:LOSE',CREATED_TIME:date};
const earlier={ID:'100',STAGE_ID:'C23:PREPARATION',CREATED_TIME:'2026-11-03T00:00:00Z'};
const bitrix=(history,stage='C23:LOSE')=>({request:async method=>method==='crm.deal.get'
  ? {result:{STAGE_ID:stage}} : {result:history,total:history.length}});
const check=client=>resolveCurrentTransition({client,dealId:42,loseDate:date,wait:async()=>{}});

test('повтор берёт ID только из подтверждённой текущей истории',async()=>{
  assert.deepEqual(await check(bitrix([event,earlier])),{status:'current',stageHistoryId:'101'});
  assert.deepEqual(await check(bitrix([{...event,CREATED_TIME:'2026-11-05T00:00:00Z'},earlier])),{status:'obsolete'});
  assert.deepEqual(await check(bitrix([event,earlier],'C23:WON')),{status:'obsolete'});
  await assert.rejects(check(bitrix([event,earlier],'')),/стадия/);
  await assert.rejects(check(bitrix([event,{...earlier,CREATED_TIME:date}])),/порядок/);
  await assert.rejects(check(bitrix([{...event,CREATED_TIME:'2026-11-02T00:00:00Z'}])),/дату/);
  await assert.rejects(check(bitrix([{...event,ID:'0'}])),/истории/);
});

test('ручной и ночной повторы фиксируют подтверждённый ID под арендой до процесса',async()=>{
  for(const trigger of ['manual','nightly']){
    const events=[];
    const queue={renew:async()=>{events.push('lease');return true;},finishObsoleteNightly:async()=>false,
      bindRetryTransition:async args=>{events.push('bind');assert.equal(args.stageHistoryId,'101');return true;}};
    const store={loadResumableResult:async()=>null,persistResult:async()=>({status:'processed',needsExternalActions:false}),
      hasPrejudgeArtifacts:async args=>{events.push('check');assert.equal(args.stageHistoryId,'101');return false;},
      markPrejudgeNeedsReview:async()=>true,savePrejudgeArtifact:async()=>({saved:true})};
    const result=await runJob({job:{...job,trigger_type:trigger},queue,store,loadAudioWait:async()=>null,
      processOptions:{persistInputsBeforeJudge:true,bitrix:bitrix([event,earlier]),wait:async()=>{}},
      process:async args=>{events.push('process');assert.equal(args.expectedHistoryId,'101');return {status:'processed',analysis:{},dealData:{}};}});
    assert.equal(result.status,'processed');
    assert.ok(events.indexOf('bind')<events.indexOf('check') && events.indexOf('check')<events.indexOf('process'));
  }
});

test('смена перехода или потеря аренды не запускают процесс',async()=>{
  let processed=false,finished=false;
  const queue={renew:async()=>true,bindRetryTransition:async()=>false,
    finishObsoleteTransition:async()=>{finished=true;return true;}};
  const store={loadResumableResult:async()=>null,persistResult:async()=>({}),
    hasPrejudgeArtifacts:async()=>false,markPrejudgeNeedsReview:async()=>true,savePrejudgeArtifact:async()=>({saved:true})};
  const base={job,queue,store,loadAudioWait:async()=>null,process:async()=>{processed=true;},
    processOptions:{persistInputsBeforeJudge:true,bitrix:bitrix([event,earlier]),wait:async()=>{}}};
  await assert.rejects(runJob(base),PrejudgeStageError);
  assert.equal(processed,false);
  const later=bitrix([{...event,CREATED_TIME:'2026-11-05T00:00:00Z'},earlier]);
  assert.deepEqual(await runJob({...base,processOptions:{...base.processOptions,bitrix:later}}),{status:'obsolete'});
  assert.equal(finished,true);assert.equal(processed,false);
});

test('смена стадии завершает ручной и ночной повторы без платного анализа',async()=>{
  for(const trigger of ['manual','nightly']) {
    let finished=0,processed=0,bound=0;
    const result=await runJob({job:{...job,trigger_type:trigger},queue:{renew:async()=>true,finishObsoleteNightly:async()=>false,
      bindRetryTransition:async()=>{bound++;return true;},finishObsoleteTransition:async()=>{finished++;return true;}},
      store:{loadResumableResult:async()=>null,persistResult:async()=>({}),hasPrejudgeArtifacts:async()=>false,
        markPrejudgeNeedsReview:async()=>true,savePrejudgeArtifact:async()=>({saved:true})},loadAudioWait:async()=>null,
      processOptions:{persistInputsBeforeJudge:true,bitrix:bitrix([event,earlier],'C23:WON'),wait:async()=>{}},
      process:async()=>{processed++;}});
    assert.deepEqual(result,{status:'obsolete'});assert.equal(finished,1);assert.equal(processed,0);assert.equal(bound,0);
  }
});

test('ошибка Битрикса и неполная история не объявляются устаревшим заданием',async()=>{
  for(const broken of [{request:async()=>{throw Error('api');}}, {request:async method=>method==='crm.deal.get'
    ? {result:{STAGE_ID:'C23:LOSE'}} : {result:[event],total:2}}]) {
    let finished=0,processed=0;
    await assert.rejects(runJob({job,queue:{renew:async()=>true,bindRetryTransition:async()=>true,
      finishObsoleteTransition:async()=>{finished++;return true;}},
      store:{loadResumableResult:async()=>null,persistResult:async()=>({}),hasPrejudgeArtifacts:async()=>false,
        markPrejudgeNeedsReview:async()=>true,savePrejudgeArtifact:async()=>({saved:true})},loadAudioWait:async()=>null,
      processOptions:{persistInputsBeforeJudge:true,bitrix:broken,wait:async()=>{}},process:async()=>{processed++;}}));
    assert.equal(finished,0);assert.equal(processed,0);
  }
});

const pglite=resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
test('SQL под арендой закрепляет ID и не принимает другой ID для артефакта и STT', {skip:!existsSync(pglite)},async()=>{
  const {PGlite}=await import(pathToFileURL(pglite).href);const db=new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE public.lost_processing_jobs (id uuid PRIMARY KEY,deal_id integer,status text,lease_token uuid,
        lease_until timestamptz,request_key text,lose_date timestamptz,trigger_type text,updated_at timestamptz,origin_stage_history_id text);
      CREATE TABLE public.lost_audio_wait (deal_id integer,lose_date timestamptz,origin_stage_history_id text,state text,next_check_at timestamptz)`);
    await db.exec(readFileSync('db/proposals/20261109_prejudge_artifacts.sql','utf8'));
    const pool={query:(...args)=>db.query(...args),async connect(){return {query:q=>typeof q==='string'?db.query(q):db.query(q.text,q.values),release(){}};}};
    const queue=createJobQueue(pool);
    for(const trigger of ['manual','nightly']) {
      await db.exec('TRUNCATE public.lost_prejudge_stt_attempts,public.lost_prejudge_artifacts,public.lost_processing_jobs');
      await db.query(`INSERT INTO public.lost_processing_jobs (id,deal_id,status,lease_token,lease_until,request_key,lose_date,trigger_type)
        VALUES ($1,42,'processing',$2,clock_timestamp()+interval '1 hour',$3,$4,$5)`,[job.id,job.lease_token,`${trigger}:42`,date,trigger]);
      const binding={id:job.id,token:job.lease_token,dealId:42,loseDate:date,stageHistoryId:'101'};
      const scope={operationId:job.id,leaseToken:job.lease_token,dealId:42,loseDate:date,stageHistoryId:'101'};
      const artifact=prepareBeginArtifact({sttAttempts:true});
      await assert.rejects(savePrejudgeArtifact(pool,{...scope,artifact}),PrejudgeStageError);
      assert.equal(await queue.bindRetryTransition(binding),true);
      assert.equal(await queue.bindRetryTransition(binding),true);
      assert.equal(await queue.bindRetryTransition({...binding,stageHistoryId:'102'}),false);
      assert.equal((await savePrejudgeArtifact(pool,{...scope,artifact})).saved,true);
      await assert.rejects(savePrejudgeArtifact(pool,{...scope,stageHistoryId:'102',artifact}),PrejudgeStageError);
      const request={file_id:'10',activity_id:'20',call_date:'2026-11-03T00:00:00Z',channel_count:2};
      const stt={scope,request,audioSha256:'b'.repeat(64),policySha256:'a'.repeat(64),expectedEngine:'reserve:gigaam'};
      assert.equal((await claimSttAttempt(pool,stt)).allowed,true);
      await assert.rejects(claimSttAttempt(pool,{...stt,scope:{...scope,stageHistoryId:'102'}}),PrejudgeStageError);
      await db.query(`INSERT INTO public.lost_audio_wait VALUES (42,$1,'102','done',clock_timestamp())`,[date]);
      await assert.rejects(savePrejudgeArtifact(pool,{...scope,stageHistoryId:'102',artifact}),PrejudgeStageError);
      await assert.rejects(claimSttAttempt(pool,{...stt,scope:{...scope,stageHistoryId:'102'}}),PrejudgeStageError);
      await db.exec('TRUNCATE public.lost_audio_wait');
      await db.query(`UPDATE public.lost_processing_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[job.id]);
      assert.equal(await queue.bindRetryTransition(binding),false);
      await assert.rejects(savePrejudgeArtifact(pool,{...scope,artifact}),PrejudgeStageError);
    }
  } finally {await db.close();}
});
