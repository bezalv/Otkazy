import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runManualPrejudge } from '../../app/src/pilot/manual-prejudge.mjs';
import { hasPrejudgeArtifacts, hasUnsafePrejudgeResume, PrejudgeStageError } from '../../app/src/persistence/prejudge.mjs';

const pglite=resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const runId='00000000-0000-4000-8000-000000000111';
const cutoff='2026-11-04T00:00:00Z';
async function testDb() {
  const {PGlite}=await import(pathToFileURL(pglite).href);
  const db=new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated');
  await db.exec(readFileSync('db/proposals/20261109_prejudge_artifacts.sql','utf8'));
  await db.exec(readFileSync('db/proposals/20261109_prejudge_manual_jobs.sql','utf8'));
  const pool={query(q){return typeof q==='string'?db.query(q):db.query(q.text,q.values);},
    async connect(){return {query(q){return typeof q==='string'?db.query(q):db.query(q.text,q.values);},release(){}};}};
  return {db,pool};
}
function options(events,db,{writer=false}={}) {
  const judge={verdict:'правомерен',verdict_reason_short:'Клиент отказался',recoverable_level:null,
    closure_reason_class:'competitor',misplaced:false,correct_stage:null,exact_reason:'Клиент купил в другом месте',
    manager_mistakes:[],key_signals:[],risk_factors:[],questions_for_manager:[]};
  if (writer) judge.recoverable_level='низкий';
  return {nowMs:Date.parse('2026-11-05T00:00:00Z'),wait:async()=>{},audioWaitEnabledAt:'2026-11-01T00:00:00Z',
    judgeSystemPrompt:'Промпт',writerSystemPrompt:'Писатель',
    bitrix:{async request(method,body){
      if(method==='crm.deal.userfield.list')return {result:[{LIST:[{ID:'1',VALUE:'Другая'}]}]};
      if(method==='crm.deal.get')return {result:{ID:'42',STAGE_ID:'C23:LOSE',ASSIGNED_BY_ID:'65',UF_CRM_1584703948317:'1'}};
      if(method==='crm.stagehistory.list')return {result:{items:[{ID:'101',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}]}};
      if(method==='crm.activity.list' && body.filter.TYPE_ID)return {result:[{ID:'1',PROVIDER_ID:'VOXIMPLANT_CALL',COMPLETED:'Y',
        CREATED:'2026-11-03T01:00:00Z',START_TIME:'2026-11-03T01:00:00Z',END_TIME:'2026-11-03T01:01:10Z',
        SETTINGS:{RECORD_URL:'https://example.invalid/audio?fileId=101'}}]};
      if(method==='crm.activity.list'||method==='imopenlines.crm.chat.get'||method==='crm.timeline.comment.list')return {result:[]};
      if(method==='tasks.task.list')return {result:{tasks:[]}};
      throw Error(`Недопустимый метод ${method}`);
    }},
    transcribe:async request=>{events.push('stt');return {success:true,activity_id:request.activity_id,
      formatted_dialog:'Клиент: Я уже купил в другом месте',client_text:'Я уже купил в другом месте',manager_text:'',
      total_replicas:1,channel_count:2};},
    llm:{async complete(_body,{role}={}){events.push(role);
      if(role==='judge'){
        const rows=await db.query("SELECT artifact_type,run_kind FROM public.lost_prejudge_artifacts ORDER BY created_at,artifact_type");
        assert.ok(rows.rows.some(r=>r.artifact_type==='raw_collection'));
        assert.ok(rows.rows.some(r=>r.artifact_type==='transcript'));
        assert.ok(rows.rows.some(r=>r.artifact_type==='judge_input'));
        assert.ok(rows.rows.every(r=>r.run_kind==='manual'));
      }
      return role==='writer'?{choices:[{message:{content:'Итог'}}]}:{choices:[{message:{content:JSON.stringify(judge)}}]};
    }}
  };
}

test('тихий ручной прогон пишет в staging до судьи без таблицы очереди', {skip:!existsSync(pglite)}, async()=>{
  const {db,pool}=await testDb();const events=[];
  try {
    const result=await runManualPrejudge({pool,dealId:42,stageHistoryId:'101',loseDate:cutoff,options:options(events,db),uuid:()=>runId});
    assert.equal(result.runId,runId);assert.equal(result.result.status,'processed');assert.equal(result.resultSaved,true);
    // При правомерном вердикте без ошибок писатель штатно пропускается.
    assert.deepEqual(events,['stt','judge']);
    assert.equal((await db.query("SELECT to_regclass('public.lost_processing_jobs') AS q")).rows[0].q,null);
    assert.equal((await db.query('SELECT status,request_key FROM public.lost_prejudge_manual_jobs WHERE id=$1',[runId])).rows[0].status,'completed');
    assert.equal((await db.query('SELECT request_key FROM public.lost_prejudge_manual_jobs WHERE id=$1',[runId])).rows[0].request_key,`manual-test:${runId}`);
    const saved=await db.query("SELECT payload,run_kind FROM public.lost_prejudge_artifacts WHERE job_id=$1 AND artifact_type='judge_result'",[runId]);
    assert.equal(saved.rowCount,1);assert.equal(saved.rows[0].run_kind,'manual');
    assert.equal(saved.rows[0].payload.analysis.multi_agent_analysis.verdict,'правомерен');
    assert.equal(saved.rows[0].payload.analysis.multi_agent_analysis.final_comment,result.result.analysis.multi_agent_analysis.final_comment);
    assert.equal(Object.hasOwn(saved.rows[0].payload.analysis,'communications'),false);
  } finally {await db.close();}
});

test('результат писателя сохраняется в ручном staging вместе с вердиктом', {skip:!existsSync(pglite)},async()=>{
  const {db,pool}=await testDb();const events=[];
  try {
    const out=await runManualPrejudge({pool,dealId:42,stageHistoryId:'101',loseDate:cutoff,options:options(events,db,{writer:true}),uuid:()=>runId});
    assert.equal(out.resultSaved,true);assert.deepEqual(events,['stt','judge','writer']);
    const row=(await db.query("SELECT payload FROM public.lost_prejudge_artifacts WHERE job_id=$1 AND artifact_type='judge_result'",[runId])).rows[0];
    assert.equal(row.payload.analysis.multi_agent_analysis.final_comment,'Итог');
    assert.equal(row.payload.analysis.multi_agent_analysis.verdict,'правомерен');
  } finally {await db.close();}
});

test('сбой завершения откатывает результат и не помечает прогон завершённым', {skip:!existsSync(pglite)},async()=>{
  const {db,pool}=await testDb();const events=[];
  const broken={...pool,async connect(){const conn=await pool.connect();return {...conn,async query(q){
    if(typeof q==='object' && q.text.includes("SET status='completed'"))throw Error('ошибка фиксации');
    return conn.query(q);}};}};
  try {
    await assert.rejects(runManualPrejudge({pool:broken,dealId:42,stageHistoryId:'101',loseDate:cutoff,options:options(events,db),uuid:()=>runId}),PrejudgeStageError);
    assert.deepEqual(events,['stt','judge']);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM public.lost_prejudge_artifacts WHERE artifact_type='judge_result'")).rows[0].n,0);
    assert.equal((await db.query('SELECT status FROM public.lost_prejudge_manual_jobs WHERE id=$1',[runId])).rows[0].status,'failed');
  } finally {await db.close();}
});

test('ошибка staging останавливает STT и судью, а ручной job не уходит в очередь', {skip:!existsSync(pglite)},async()=>{
  const {db,pool}=await testDb();const events=[];
  const broken={...pool,async connect(){const conn=await pool.connect();return {...conn,async query(q){
    if(typeof q==='object' && q.text.includes('INSERT INTO public.lost_prejudge_artifacts'))throw Error('ошибка записи');
    return conn.query(q);}};}};
  try {
    await assert.rejects(runManualPrejudge({pool:broken,dealId:42,stageHistoryId:'101',loseDate:cutoff,options:options(events,db),uuid:()=>runId}),PrejudgeStageError);
    assert.deepEqual(events,[]);
    assert.equal((await db.query('SELECT status FROM public.lost_prejudge_manual_jobs WHERE id=$1',[runId])).rows[0].status,'failed');
    assert.equal((await db.query("SELECT to_regclass('public.lost_processing_jobs') AS q")).rows[0].q,null);
  } finally {await db.close();}
});

test('ручной прогон отсекает некорректную дату и микросекунды до создания job', {skip:!existsSync(pglite)},async()=>{
  const {db,pool}=await testDb();
  try {
    for (const loseDate of ['2026-02-30T00:00:00Z','2026-11-04T00:00:00.000001Z','2026-11-04T00:00:00']) {
      await assert.rejects(runManualPrejudge({pool,dealId:42,stageHistoryId:'101',loseDate,options:options([],db),uuid:()=>runId}),TypeError);
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_prejudge_manual_jobs')).rows[0].n,0);
  } finally {await db.close();}
});

test('ручные данные не создают конфликт со штатной очередью при последующем включении', {skip:!existsSync(pglite)},async()=>{
  const {db,pool}=await testDb();
  const job='00000000-0000-4000-8000-000000000112',lease='00000000-0000-4000-8000-000000000113';
  try {
    await runManualPrejudge({pool,dealId:42,stageHistoryId:'101',loseDate:cutoff,options:options([],db),uuid:()=>runId});
    await db.exec('CREATE TABLE public.lost_processing_jobs (id uuid PRIMARY KEY,deal_id integer,status text,lease_token uuid,lease_until timestamptz,lose_date timestamptz,trigger_type text)');
    await db.query("INSERT INTO public.lost_processing_jobs VALUES($1,42,'processing',$2,now()+interval '1 hour',$3,'live')",[job,lease,cutoff]);
    const scope={operationId:job,leaseToken:lease,dealId:42,stageHistoryId:'101',loseDate:cutoff};
    assert.equal(await hasPrejudgeArtifacts(pool,scope),false);
    assert.equal(await hasUnsafePrejudgeResume(pool,scope),false);
  } finally {await db.close();}
});
