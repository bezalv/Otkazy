import test, {before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createSttClient} from '../../app/src/stt-client.mjs';
import {claimSttAttempt,completeSttAttempt} from '../../app/src/persistence/stt-attempts.mjs';
import {prepareTranscriptArtifact,savePrejudgeArtifact,transcriptSourceKey} from '../../app/src/persistence/prejudge.mjs';
import {createJobQueue} from '../../app/src/queue/index.mjs';

// Разрешён только socket, созданный локальным harness. Никаких DATABASE_URL и TCP к БД.
const socket=process.env.OTKAZY_LOCAL_PG_SOCKET;
const enabled=process.env.OTKAZY_LOCAL_PG_TEST==='1'
  && /^\/tmp\/otkazy-local-pg-[A-Za-z0-9]{8}$/.test(socket || '')
  && process.env.OTKAZY_LOCAL_PG_PORT==='56471';
const local={skip:!enabled,timeout:15000};
const requireApp=createRequire(new URL('../../app/package.json',import.meta.url));
const job='00000000-0000-4000-8000-000000000101';
const job2='00000000-0000-4000-8000-000000000102';
const lease='00000000-0000-4000-8000-000000000103';
const nextLease='00000000-0000-4000-8000-000000000104';
const scope={operationId:job,leaseToken:lease,dealId:42,stageHistoryId:'123',loseDate:'2026-10-28T05:35:03.000Z'};
const request={file_id:'10',activity_id:'20',call_date:'2026-10-27T05:35:03.000Z',channel_count:2};
const fixed={request,audioSha256:'b'.repeat(64),policySha256:'a'.repeat(64),expectedEngine:'reserve:gigaam'};
let pool,server,base,uploads=0;

before(async()=>{
  if(!enabled)return;
  const {Pool}=requireApp('pg');
  pool=new Pool({host:socket,port:56471,user:'otkazytest',database:'otkazytest',ssl:false,max:8,
    connectionTimeoutMillis:3000,application_name:'otkazy_prejudge_isolated_test'});
  const identity=await pool.query("SELECT current_database() AS db,inet_server_addr() AS addr,current_setting('data_directory') AS data,current_setting('listen_addresses') AS listens");
  assert.deepEqual(identity.rows[0],{db:'otkazytest',addr:null,data:`${socket}/data`,listens:''});
  const absent=await pool.query("SELECT to_regclass('public.lost_processing_jobs') AS jobs,to_regclass('public.lost_prejudge_artifacts') AS artifacts,to_regclass('public.lost_prejudge_stt_attempts') AS attempts");
  assert.deepEqual(absent.rows[0],{jobs:null,artifacts:null,attempts:null});
  await pool.query(`CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE public.lost_processing_jobs (id uuid PRIMARY KEY,deal_id integer NOT NULL,status text NOT NULL,
      lease_token uuid,lease_until timestamptz,request_key text NOT NULL,lose_date timestamptz NOT NULL,trigger_type text NOT NULL,origin_stage_history_id text,updated_at timestamptz);
    CREATE TABLE public.lost_audio_wait (deal_id integer PRIMARY KEY,lose_date timestamptz NOT NULL,
      origin_stage_history_id text,state text NOT NULL,next_check_at timestamptz NOT NULL)`);
  await pool.query(await readFile(new URL('../../db/proposals/20261109_prejudge_artifacts.sql',import.meta.url),'utf8'));
  // Только локальная заглушка: запросы к реальному провайдеру не выполняются.
  server=createServer(async(req,res)=>{
    if(req.url==='/audio'){res.end(Buffer.alloc(2048,11));return;}
    for await(const _ of req){} uploads++;
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true,model:'gigaam',channels:2,segments:[{channel:1,start:1,text:'Нужна скидка'}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{
  if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
  if(pool)await pool.end();
});
beforeEach(async()=>{
  if(!enabled)return;
  uploads=0;
  await pool.query('TRUNCATE public.lost_prejudge_stt_attempts,public.lost_prejudge_artifacts,public.lost_audio_wait,public.lost_processing_jobs');
  await pool.query(`INSERT INTO public.lost_processing_jobs VALUES ($1,42,'processing',$2,clock_timestamp()+interval '1 hour',
    'bitrix24:deal-stage-history:123',$3::timestamptz,'live')`,[job,lease,scope.loseDate]);
});

function client(){
  return createSttClient({bitrix:{request:async()=>({result:{DOWNLOAD_URL:`${base}/audio`}})},sttUrl:base,sttKey:'local-test'});
}
function hooks(database, selectedScope=scope){
  const args={scope:selectedScope,policySha256:fixed.policySha256,expectedEngine:fixed.expectedEngine};
  return {beforeStt:part=>claimSttAttempt(database,{...args,...part}),
    afterStt:part=>completeSttAttempt(database,{...args,...part})};
}
function lostCommitPool({commitApplied=true}={}) {
  let inject=true;
  return {async connect(){
    const c=await pool.connect();
    return {async query(query,params){
      const text=typeof query==='string'?query:query?.text;
      if(inject && /^COMMIT\b/i.test(text || '')){inject=false;if(commitApplied)await c.query(query,params);throw new Error('simulated lost COMMIT reply');}
      return c.query(query,params);
    },release(error){c.release(error);}};
  }};
}
async function waitForLocks(part, expected){
  for(let n=0;n<100;n++){
    const x=await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name='otkazy_prejudge_isolated_test' AND wait_event_type='Lock' AND query LIKE $1`,[`%${part}%`]);
    if(x.rows[0].n>=expected)return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail('Ожидаемая блокировка не наблюдалась');
}

test('две независимые сессии действительно доступны',local,async()=>{
  const a=await pool.connect(),b=await pool.connect();
  try {const [x,y]=await Promise.all([a.query('SELECT pg_backend_pid() AS pid'),b.query('SELECT pg_backend_pid() AS pid')]);
    assert.notEqual(x.rows[0].pid,y.rows[0].pid);
  } finally {a.release();b.release();}
});

test('ручной и ночной переход привязываются к арендованному заданию и проверяются при записи',local,async()=>{
  const queue=createJobQueue(pool);
  const artifact={type:'begin',key:'a'.repeat(64),payload:{state:'processing_started',protocol_version:2}};
  for(const trigger of ['manual','nightly']) {
    await pool.query('TRUNCATE public.lost_prejudge_stt_attempts,public.lost_prejudge_artifacts,public.lost_processing_jobs');
    await pool.query(`INSERT INTO public.lost_processing_jobs (id,deal_id,status,lease_token,lease_until,request_key,lose_date,trigger_type)
      VALUES ($1,42,'processing',$2,clock_timestamp()+interval '1 hour',$3,$4,$5)`,[job,lease,`${trigger}:42`,scope.loseDate,trigger]);
    const binding={id:job,token:lease,dealId:42,loseDate:scope.loseDate,stageHistoryId:'123'};
    await assert.rejects(savePrejudgeArtifact(pool,{...scope,artifact}));
    assert.equal(await queue.bindRetryTransition(binding),true);
    assert.equal(await queue.bindRetryTransition({...binding,stageHistoryId:'124'}),false);
    assert.equal((await savePrejudgeArtifact(pool,{...scope,artifact})).saved,true);
    await assert.rejects(savePrejudgeArtifact(pool,{...scope,stageHistoryId:'124',artifact}));
    assert.equal((await claimSttAttempt(pool,{scope,...fixed})).allowed,true);
    await assert.rejects(claimSttAttempt(pool,{scope:{...scope,stageHistoryId:'124'},...fixed}));
    await pool.query(`UPDATE public.lost_processing_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[job]);
    assert.equal(await queue.bindRetryTransition(binding),false);
    await assert.rejects(savePrejudgeArtifact(pool,{...scope,artifact}));
  }
});

test('два разных задания одного перехода не резервируют один POST одновременно',local,async()=>{
  await pool.query(`INSERT INTO public.lost_processing_jobs VALUES ($1,42,'processing',$2,clock_timestamp()+interval '1 hour',
    'bitrix24:deal-stage-history:123',$3::timestamptz,'live')`,[job2,lease,scope.loseDate]);
  const blocker=await pool.connect();let pending;
  const lock=`lost-stt:${scope.dealId}:${scope.stageHistoryId}:${new Date(scope.loseDate).toISOString()}:${transcriptSourceKey(request)}`;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
    pending=Promise.allSettled([claimSttAttempt(pool,{scope,...fixed}),claimSttAttempt(pool,{scope:{...scope,operationId:job2},...fixed})]);
    await waitForLocks('pg_advisory_xact_lock',2);
    await blocker.query('COMMIT');
    const outcomes=await pending;
    assert.equal(outcomes.filter(x=>x.status==='fulfilled'&&x.value.allowed===true).length,1);
    assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
    assert.deepEqual((await pool.query('SELECT status FROM public.lost_prejudge_stt_attempts')).rows,[{status:'pending'}]);
  } finally {await blocker.query('ROLLBACK').catch(()=>{});blocker.release();if(pending)await pending;}
});

test('готовый результат и staging сохраняются повторно без второго POST',local,async()=>{
  const transcribe=client();
  const result=await transcribe(request,hooks(pool));
  assert.equal(result.success,true);assert.equal(uploads,1);
  const artifact=prepareTranscriptArtifact(request,result);
  assert.equal((await savePrejudgeArtifact(pool,{...scope,artifact})).saved,true);
  assert.equal((await savePrejudgeArtifact(pool,{...scope,artifact})).saved,true);
  const cached=await transcribe(request,hooks(pool));
  assert.equal(cached.formatted_dialog,result.formatted_dialog);assert.equal(uploads,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.lost_prejudge_artifacts')).rows[0].n,1);
  assert.deepEqual((await pool.query('SELECT status FROM public.lost_prejudge_stt_attempts')).rows,[{status:'completed'}]);
  // Намеренный ручной повтор — новая операция с подтверждённым тем же переходом.
  await pool.query(`UPDATE public.lost_processing_jobs SET status='done' WHERE id=$1`,[job]);
  await pool.query(`INSERT INTO public.lost_processing_jobs VALUES ($1,42,'processing',$2,clock_timestamp()+interval '1 hour',
    'manual:test',$3::timestamptz,'manual')`,[job2,lease,scope.loseDate]);
  await pool.query(`INSERT INTO public.lost_audio_wait VALUES (42,$1::timestamptz,'123','done',clock_timestamp())`,[scope.loseDate]);
  const manualScope={...scope,operationId:job2};
  const replay=await transcribe(request,hooks(pool,manualScope));
  assert.equal(replay.formatted_dialog,result.formatted_dialog);assert.equal(uploads,1);
  assert.equal((await savePrejudgeArtifact(pool,{...manualScope,artifact:prepareTranscriptArtifact(request,replay)})).saved,true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.lost_prejudge_artifacts')).rows[0].n,2);
});

test('смена аренды под блокировкой не разрешает POST и запись staging',local,async()=>{
  const blocker=await pool.connect();let pending;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM public.lost_processing_jobs WHERE id=$1 FOR UPDATE',[job]);
    pending=claimSttAttempt(pool,{scope,...fixed});
    await waitForLocks('FROM public.lost_processing_jobs',1);
    await blocker.query('UPDATE public.lost_processing_jobs SET lease_token=$2 WHERE id=$1',[job,nextLease]);
    await blocker.query('COMMIT');
    await assert.rejects(pending);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.lost_prejudge_stt_attempts')).rows[0].n,0);
    const dummy={type:'begin',key:'a'.repeat(64),payload:{state:'processing_started'}};
    await assert.rejects(savePrejudgeArtifact(pool,{...scope,artifact:dummy}));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.lost_prejudge_artifacts')).rows[0].n,0);
  } finally {await blocker.query('ROLLBACK').catch(()=>{});blocker.release();if(pending)await pending.catch(()=>{});}
});

test('потеря ответа COMMIT при резервировании не разрешает одновременный POST',local,async()=>{
  await assert.rejects(claimSttAttempt(lostCommitPool(),{scope,...fixed}));
  assert.deepEqual((await pool.query('SELECT status FROM public.lost_prejudge_stt_attempts')).rows,[{status:'pending'}]);
  await assert.rejects(claimSttAttempt(pool,{scope,...fixed}));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.lost_prejudge_stt_attempts')).rows[0].n,1);
});

test('если COMMIT не прошёл, новая попытка создаёт единственную запись',local,async()=>{
  await assert.rejects(claimSttAttempt(lostCommitPool({commitApplied:false}),{scope,...fixed}));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.lost_prejudge_stt_attempts')).rows[0].n,0);
  assert.equal((await claimSttAttempt(pool,{scope,...fixed})).allowed,true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.lost_prejudge_stt_attempts')).rows[0].n,1);
});

test('потерянный COMMIT готового транскрипта восстанавливается из БД без второго POST',local,async()=>{
  const transcribe=client(), opts={scope,policySha256:fixed.policySha256,expectedEngine:fixed.expectedEngine};
  const fault={beforeStt:part=>claimSttAttempt(pool,{...opts,...part}),
    afterStt:part=>completeSttAttempt(lostCommitPool(),{...opts,...part})};
  await assert.rejects(transcribe(request,fault));assert.equal(uploads,1);
  assert.deepEqual((await pool.query('SELECT status FROM public.lost_prejudge_stt_attempts')).rows,[{status:'completed'}]);
  const cached=await transcribe(request,hooks(pool));assert.equal(cached.success,true);assert.equal(uploads,1);
  const artifact=prepareTranscriptArtifact(request,cached);
  await assert.rejects(savePrejudgeArtifact(lostCommitPool(),{...scope,artifact}));
  assert.equal((await savePrejudgeArtifact(pool,{...scope,artifact})).saved,true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.lost_prejudge_artifacts')).rows[0].n,1);
});
