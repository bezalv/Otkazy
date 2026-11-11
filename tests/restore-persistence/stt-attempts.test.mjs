import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createSttClient} from '../../app/src/stt-client.mjs';
import {claimSttAttempt,completeSttAttempt} from '../../app/src/persistence/stt-attempts.mjs';
import {hasUnsafePrejudgeResume,markPrejudgeNeedsReview,prepareBeginArtifact,prepareJudgeInputArtifact,prepareTranscriptArtifact,savePrejudgeArtifact,transcriptSourceKey} from '../../app/src/persistence/prejudge.mjs';
import {transcribeCalls} from '../../app/src/calls/index.mjs';
const pglite=resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
test('скачанные байты переиспользуются в пределах перехода; новая версия и переход распознаются отдельно', {skip:!existsSync(pglite)}, async()=>{
  const {PGlite}=await import(pathToFileURL(pglite).href),db=new PGlite();
  let audio=Buffer.alloc(2048,11), uploads=0, mode='normal', model='gigaam';
  const server=createServer(async(req,res)=>{
    if(req.url==='/audio'){res.end(audio);return;}
    for await(const _ of req){} uploads++;
    const mono=req.url.includes('channels=mono');
    if(mode==='mismatch' && !mono) {res.writeHead(400,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:{code:'channels_mismatch',retryable:false}}));return;}
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true,model,channels:mono?1:2,...(mode==='legacy_silent'?{}:{duration_sec:60}),
      segments:mode==='silent' || mode==='legacy_silent' || (mode==='empty' && !mono) ? [] : [{channel:mono?0:1,start:1,text:'Нужна скидка'}],
      ...(mode==='silent' || (mode==='empty' && !mono) ? {transcription_coverage:{version:1,status:'no_empty_fragments',
        total_fragments:0,unrecognized_count:0,unrecognized_segments:[]}} : {}),
      ...(mode==='partial' ? {transcription_coverage:{version:1,status:'incomplete',total_fragments:2,
        unrecognized_count:1,unrecognized_segments:[{channel:0,start:2,end:3}]}} : {})}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE public.lost_processing_jobs (id uuid PRIMARY KEY,deal_id int,status text,lease_token uuid,
        lease_until timestamptz,request_key text,lose_date timestamptz,trigger_type text,origin_stage_history_id text);
      CREATE TABLE public.lost_audio_wait (deal_id int,lose_date timestamptz,origin_stage_history_id text,state text,next_check_at timestamptz)`);
    await db.exec(readFileSync('db/proposals/20261109_prejudge_artifacts.sql','utf8'));
    const job='00000000-0000-4000-8000-000000000101',lease='00000000-0000-4000-8000-000000000102';
    const scope={operationId:job,leaseToken:lease,dealId:42,stageHistoryId:'101',loseDate:'2026-11-04T00:00:00Z'};
    await db.query(`INSERT INTO public.lost_processing_jobs VALUES ($1,42,'processing',$2,now()+interval '1 hour',
      'bitrix24:deal-stage-history:101','2026-11-04T00:00:00Z','live')`,[job,lease]);
    const pool={async connect(){return {query(q){return typeof q==='string'?db.query(q):db.query(q.text,q.values)},release(){}}}};
    const base=`http://127.0.0.1:${server.address().port}`;
    const client=createSttClient({bitrix:{request:async()=>({result:{DOWNLOAD_URL:`${base}/audio`}})},sttUrl:base,sttKey:'test'});
    const request={file_id:'10',activity_id:'20',call_date:'2026-11-03T00:00:00Z',channel_count:2};
    const opts={scope,policySha256:'a'.repeat(64),expectedEngine:'reserve:gigaam'};
    const hooks={beforeStt:args=>claimSttAttempt(pool,{...opts,...args}),afterStt:args=>completeSttAttempt(pool,{...opts,...args})};
    const first=await client(request,hooks);assert.equal(first.success,true);assert.equal(uploads,1);
    const cached=await client(request,hooks);assert.equal(cached.formatted_dialog,first.formatted_dialog);assert.equal(uploads,1);
    mode='partial';const partialRequest={...request,file_id:'777'},beforePartial=uploads;
    const partial=await client(partialRequest,hooks);const partialCached=await client(partialRequest,hooks);
    assert.equal(uploads,beforePartial+1);assert.equal(partial.transcription_coverage.status,'incomplete');
    assert.deepEqual(partialCached.transcription_coverage,partial.transcription_coverage);
    assert.deepEqual(prepareTranscriptArtifact(partialRequest,partial).payload.transcript.transcription_coverage,partial.transcription_coverage);
    mode='normal';
    audio=Buffer.alloc(2048,12);const changed=await client(request,hooks);assert.equal(changed.success,true);assert.equal(uploads,3);
    assert.notEqual(first.audio_sha256,changed.audio_sha256);
    const firstArtifact=prepareTranscriptArtifact(request,first), changedArtifact=prepareTranscriptArtifact(request,changed);
    assert.notEqual(firstArtifact.key,changedArtifact.key);
    await savePrejudgeArtifact(pool,{...scope,artifact:firstArtifact});
    await savePrejudgeArtifact(pool,{...scope,artifact:changedArtifact});
    const makeDeal=id=>({deal_id:42,communications:[{type:'call',activity_id:`${id}`,date:'2026-11-03T00:00:00Z',
      duration_start:'2026-11-03T00:00:00Z',duration_end:'2026-11-03T00:01:00Z',direction:'incoming',
      _needs_transcription:true,audio_url:`https://example.invalid/call?fileId=${id}`}]});
    for (const [scenario,id] of [['empty',201],['mismatch',202]]) {
      mode=scenario;const before=uploads;
      const run=()=>transcribeCalls({dealData:makeDeal(id),transcribe:req=>client(req,hooks)});
      const firstRun=await run();assert.equal(firstRun.transcription_errors.length,0);assert.equal(uploads,before+2);
      const secondRun=await run();assert.equal(secondRun.transcription_errors.length,0);assert.equal(uploads,before+2);
      assert.equal(secondRun.communications[0]._transcript_mode,'mono');
    }
    mode='silent';const quietStart=uploads;
    const quiet=()=>transcribeCalls({dealData:makeDeal(203),transcribe:req=>client(req,hooks)});
    assert.equal((await quiet()).transcription_errors.length,0);assert.equal(uploads,quietStart+2);
    assert.equal((await quiet()).transcription_errors.length,0);assert.equal(uploads,quietStart+2);
    // Пустой подтверждённый результат сохраняется с длительностью, затем
    // восстанавливается без второго POST и проходит ту же проверку артефакта.
    for(const channels of [2,1]) {
      const req={...request,file_id:String(800+channels),activity_id:String(900+channels),channel_count:channels};
      const before=uploads,original=await client(req,hooks),again=await client(req,hooks);
      assert.equal(uploads,before+1);assert.equal(original.formatted_dialog,'');assert.equal(again.formatted_dialog,'');
      assert.equal(again.reserve_duration_sec,60);
      const freshArtifact=prepareTranscriptArtifact(req,original,{allowEmpty:true});
      const cachedArtifact=prepareTranscriptArtifact(req,again,{allowEmpty:true});
      assert.deepEqual(cachedArtifact.payload,freshArtifact.payload);
    }
    // Исторический completed без длительности не считается доказанным пустым
    // ответом: старая запись не меняется, разрешена только вторая попытка.
    const legacyReq={...request,file_id:'850',activity_id:'950'},legacyBefore=uploads;
    await client(legacyReq,hooks);
    const saved=(await db.query(`SELECT attempt_id,transcript FROM public.lost_prejudge_stt_attempts
      WHERE source_key=$1 AND status='completed'`,[transcriptSourceKey(legacyReq)])).rows[0];
    assert.ok(saved);const legacy=structuredClone(saved.transcript);delete legacy.transcript.reserve_duration_sec;
    const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'
      ?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
    const checksum=createHash('sha256').update(canonical(legacy)).digest('hex');
    await db.query('UPDATE public.lost_prejudge_stt_attempts SET transcript=$2::jsonb,transcript_sha256=$3 WHERE attempt_id=$1',
      [saved.attempt_id,JSON.stringify(legacy),checksum]);
    const renewed=await client(legacyReq,hooks);assert.equal(uploads,legacyBefore+2);
    assert.equal(prepareTranscriptArtifact(legacyReq,renewed,{allowEmpty:true}).payload.status,'verified_stt_response');
    const preserved=(await db.query('SELECT status,transcript,transcript_sha256 FROM public.lost_prejudge_stt_attempts WHERE attempt_id=$1',[saved.attempt_id])).rows[0];
    assert.equal(preserved.status,'completed');assert.deepEqual(preserved.transcript,legacy);assert.equal(preserved.transcript_sha256,checksum);
    const reused=await client(legacyReq,hooks);assert.equal(uploads,legacyBefore+2);
    assert.equal(prepareTranscriptArtifact(legacyReq,reused,{allowEmpty:true}).payload.status,'verified_stt_response');
    // Новый legacy-ответ без duration/coverage также не кешируется.
    mode='legacy_silent';const legacyNewReq={...request,file_id:'851',activity_id:'951'};
    const legacyResult=await client(legacyNewReq,hooks);assert.equal(legacyResult.success,true);
    assert.equal(legacyResult.transcription_coverage.status,'unknown_legacy');
    const legacyState=await db.query(`SELECT status,transcript FROM public.lost_prejudge_stt_attempts WHERE source_key=$1`,
      [transcriptSourceKey(legacyNewReq)]);
    assert.equal(legacyState.rows[0].status,'unknown');assert.equal(legacyState.rows[0].transcript,null);
    mode='normal'; model='aiesa';
    const mismatchedEngineRequest={...request,file_id:'104'};
    await assert.rejects(client(mismatchedEngineRequest,hooks));
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM public.lost_prejudge_stt_attempts WHERE status='pending'`)).rows[0].n,1);
    opts.expectedEngine=['reserve:gigaam','reserve:aiesa'];
    const fallbackRequest={...request,file_id:'103'},beforeFallback=uploads;
    assert.equal((await client(fallbackRequest,hooks)).transcript_engine,'reserve:aiesa');
    assert.equal((await client(fallbackRequest,hooks)).transcript_engine,'reserve:aiesa');assert.equal(uploads,beforeFallback+1);
    model='gigaam';opts.expectedEngine='reserve:gigaam';
    await db.query(`UPDATE public.lost_processing_jobs SET request_key='bitrix24:deal-stage-history:102' WHERE id=$1`,[job]);
    scope.stageHistoryId='102';const beforeOther=uploads,other=await client(request,hooks);assert.equal(other.success,true);assert.equal(uploads,beforeOther+1);
    const unknownRequest={...request,file_id:'11'}, audioSha256='c'.repeat(64);
    const firstAttempt=await claimSttAttempt(pool,{...opts,request:unknownRequest,audioSha256});
    assert.equal(firstAttempt.allowed,true);
    await assert.rejects(claimSttAttempt(pool,{...opts,request:unknownRequest,audioSha256}));
    const nextLease='00000000-0000-4000-8000-000000000103';
    await db.query('UPDATE public.lost_processing_jobs SET lease_token=$2 WHERE id=$1',[job,nextLease]);scope.leaseToken=nextLease;
    assert.equal((await claimSttAttempt(pool,{...opts,request:unknownRequest,audioSha256})).allowed,true);
    const statuses=(await db.query(`SELECT status FROM public.lost_prejudge_stt_attempts WHERE source_key=(
      SELECT source_key FROM public.lost_prejudge_stt_attempts WHERE attempt_id=$1) ORDER BY created_at`,[firstAttempt.attemptId])).rows.map(x=>x.status);
    assert.deepEqual(statuses,['unknown','pending']);
    const lastLease='00000000-0000-4000-8000-000000000104';
    await db.query('UPDATE public.lost_processing_jobs SET lease_token=$2 WHERE id=$1',[job,lastLease]);scope.leaseToken=lastLease;
    await assert.rejects(claimSttAttempt(pool,{...opts,request:unknownRequest,audioSha256}));
    const secondStatuses=(await db.query(`SELECT status FROM public.lost_prejudge_stt_attempts WHERE source_key=(
      SELECT source_key FROM public.lost_prejudge_stt_attempts WHERE attempt_id=$1)`,[firstAttempt.attemptId])).rows.map(x=>x.status);
    assert.deepEqual(secondStatuses.sort(),['unknown','unknown']);
    await assert.rejects(claimSttAttempt(pool,{...opts,scope:{...scope,leaseToken:lease},request,audioSha256:changed.audio_sha256}));
    await savePrejudgeArtifact(pool,{...scope,artifact:prepareBeginArtifact({sttAttempts:true})});
    assert.equal(await hasUnsafePrejudgeResume(pool,scope),false);
    await savePrejudgeArtifact(pool,{...scope,artifact:prepareJudgeInputArtifact(42,[],{facts:[]})});
    assert.equal(await hasUnsafePrejudgeResume(pool,scope),true);
    await db.query(`UPDATE public.lost_processing_jobs SET status='done' WHERE id=$1`,[job]);
    const manual='00000000-0000-4000-8000-000000000105';
    await db.query(`INSERT INTO public.lost_processing_jobs VALUES ($1,42,'processing',$2,now()+interval '1 hour',
      'manual:test','2026-11-04T00:00:00Z','manual')`,[manual,lastLease]);
    await db.query(`INSERT INTO public.lost_audio_wait VALUES (42,'2026-11-04T00:00:00Z','102','done',now())`);
    assert.equal(await hasUnsafePrejudgeResume(pool,{...scope,operationId:manual}),false);
    await db.exec(`ALTER TABLE public.lost_processing_jobs ADD COLUMN last_error text, ADD COLUMN updated_at timestamptz`);
    await markPrejudgeNeedsReview(pool,{...scope,operationId:manual,reason:'stt_attempts_exhausted'});
    assert.equal((await db.query(`SELECT last_error FROM public.lost_processing_jobs WHERE id=$1`,[manual])).rows[0].last_error,'stt_attempts_exhausted');
  } finally {server.closeAllConnections?.();await new Promise(r=>server.close(r));await db.close();}
});
