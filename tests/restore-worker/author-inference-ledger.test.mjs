import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createRoleInferenceLedger, getRoleInferenceLedgerScope } from '../../app/src/worker/role-inference-ledger.mjs';

const pglite = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const job = '00000000-0000-4000-8000-000000000001';
const lease = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const binding = {jobId:job,leaseToken:lease,dealId:'42',stageHistoryId:'123',cutoff:'2026-10-28T05:35:03.000Z'};

// PGlite использует одно соединение; эта очередь лишь моделирует сериализацию
// локальных транзакций. Межсерверную гонку она сама по себе не доказывает.
function serialPool(db, { lostCommit = false } = {}) {
  let tail = Promise.resolve(), inject = lostCommit;
  return { async connect() {
    const previous = tail;let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    return { async query(sql, args) {
      if (inject && /^COMMIT\b/i.test(sql)) {
        inject = false;await db.query(sql,args);throw new Error('SECRET_TEST_COMMIT');
      }
      return db.query(sql,args);
    }, release() { release(); } };
  } };
}
async function fixture(t, options = {}) {
  const { PGlite } = await import(pathToFileURL(pglite).href);
  const db = new PGlite();t.after(() => db.close());
  // Синтетический контракт, существует только в памяти этого PGlite.
  await db.exec(`CREATE TABLE public.lost_processing_jobs (
    id uuid PRIMARY KEY,deal_id bigint NOT NULL,lose_date timestamptz NOT NULL,request_key text NOT NULL,trigger_type text NOT NULL,
    status text NOT NULL,lease_token uuid,lease_until timestamptz,origin_stage_history_id text DEFAULT '123',silent boolean DEFAULT true
  );
  CREATE TABLE public.lost_role_inference_scopes (
    deal_id bigint NOT NULL,stage_history_id text NOT NULL CHECK (stage_history_id ~ '^[1-9][0-9]{0,29}$'),
    PRIMARY KEY(deal_id,stage_history_id)
  );
  CREATE TABLE public.lost_role_inference_attempts (
    job_id uuid NOT NULL REFERENCES public.lost_processing_jobs(id),
    attempt_no smallint NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
    deal_id bigint NOT NULL,stage_history_id text NOT NULL,
    lease_token uuid NOT NULL,run_id uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('reserved','settled','unknown')),
    created_at timestamptz NOT NULL,finished_at timestamptz,
    CHECK ((state='reserved' AND finished_at IS NULL) OR (state IN ('settled','unknown') AND finished_at IS NOT NULL)),
    PRIMARY KEY (job_id,attempt_no),
    FOREIGN KEY(deal_id,stage_history_id) REFERENCES public.lost_role_inference_scopes(deal_id,stage_history_id)
  );
  CREATE TABLE public.lost_audio_wait (deal_id bigint,lose_date timestamptz,origin_stage_history_id text,
    state text,next_check_at timestamptz);`);
  await db.query(`INSERT INTO public.lost_processing_jobs VALUES ($1,42,$3::timestamptz,'manual:test:1','manual','processing',$2,clock_timestamp()+interval '1 hour')`,[job,lease,binding.cutoff]);
  return {db,pool:serialPool(db,options)};
}
const enabled = {skip:!existsSync(pglite)};

test('до трёх подтверждённых последовательных попыток, без данных запроса в таблице',enabled,async t=>{
  const {db,pool}=await fixture(t), ledger=createRoleInferenceLedger(pool,binding);
  for(let n=1;n<=3;n++){
    assert.deepEqual(await ledger.reserve(),{status:'reserved',attempt_no:n});
    assert.deepEqual(await ledger.finish(n,'settled'),{status:'settled'});
  }
  assert.deepEqual(await ledger.reserve(),{status:'limit_reached'});
  const rows=(await db.query('SELECT * FROM public.lost_role_inference_attempts ORDER BY attempt_no')).rows;
  assert.deepEqual(rows.map(r=>[r.attempt_no,r.state]),[[1,'settled'],[2,'settled'],[3,'settled']]);
  assert.deepEqual(Object.keys(rows[0]).sort(),['attempt_no','created_at','deal_id','finished_at','job_id','lease_token','run_id','stage_history_id','state']);
});
test('scope неизменяем, нормализован в UTC и не содержит аренды или ключей',()=>{
  const pool={connect(){}}, ledger=createRoleInferenceLedger(pool,{...binding,cutoff:'2026-10-28T12:35:03+07:00'});
  assert.deepEqual(ledger.scope(),{dealId:'42',stageHistoryId:'123',cutoff:'2026-10-28T05:35:03.000Z'});
  assert.equal(Object.isFrozen(ledger.scope()),true);assert.throws(()=>{ledger.scope().dealId='43';},TypeError);
  assert.equal(getRoleInferenceLedgerScope(ledger),ledger.scope());
  for(const fake of [null,undefined,'ledger',{},Object.create(ledger),{...ledger},new Proxy(ledger,{})])
    assert.equal(getRoleInferenceLedgerScope(fake),null);
});
test('другая дата отказа не создаёт ни попытки, ни scope, микросекунды не округляются',enabled,async t=>{
  const {db,pool}=await fixture(t);
  assert.deepEqual(await createRoleInferenceLedger(pool,{...binding,cutoff:'2026-10-28T05:35:04.000Z'}).reserve(),{status:'lease_lost'});
  await db.query("UPDATE public.lost_processing_jobs SET lose_date='2026-10-28T05:35:03.000500Z'");
  assert.deepEqual(await createRoleInferenceLedger(pool,binding).reserve(),{status:'lease_lost'});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_role_inference_attempts')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_role_inference_scopes')).rows[0].n,0);
});
test('смена cutoff задания после reserve запрещает preSend и finish и сохраняет reserved',enabled,async t=>{
  const {db,pool}=await fixture(t), ledger=createRoleInferenceLedger(pool,binding);
  assert.equal((await ledger.reserve()).status,'reserved');
  await db.query("UPDATE public.lost_processing_jobs SET lose_date='2026-10-28T05:35:04Z'");
  assert.deepEqual(await ledger.preSend(1),{status:'lease_lost'});
  assert.deepEqual(await ledger.finish(1,'settled'),{status:'lease_lost'});
  assert.equal((await db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'reserved');
});
test('незавершённый, unknown и повторная отметка никогда не открывают новую попытку',enabled,async t=>{
  const {pool}=await fixture(t), ledger=createRoleInferenceLedger(pool,binding);
  assert.deepEqual(await ledger.reserve(),{status:'reserved',attempt_no:1});
  assert.deepEqual(await ledger.reserve(),{status:'needs_review'});
  assert.deepEqual(await ledger.finish(1,'unknown'),{status:'unknown'});
  assert.deepEqual(await ledger.finish(1,'settled'),{status:'needs_review'});
  assert.deepEqual(await ledger.reserve(),{status:'needs_review'});
});
test('новый процесс блокируется и после settled, и после незавершённой попытки даже при том же lease',enabled,async t=>{
  const {db,pool}=await fixture(t), first=createRoleInferenceLedger(pool,binding);
  assert.equal((await first.reserve()).status,'reserved');
  assert.deepEqual(await createRoleInferenceLedger(pool,binding).reserve(),{status:'needs_review'});
  assert.equal((await first.finish(1,'settled')).status,'settled');
  assert.deepEqual(await createRoleInferenceLedger(pool,binding).reserve(),{status:'needs_review'});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_role_inference_attempts')).rows[0].n,1);
});
test('другое задание того же перехода не повторяет ни reserved, ни settled попытку',enabled,async t=>{
  const {db,pool}=await fixture(t), second='00000000-0000-4000-8000-000000000004';
  await db.query("INSERT INTO public.lost_processing_jobs VALUES ($1,42,$3::timestamptz,'manual:test:2','manual','processing',$2,clock_timestamp()+interval '1 hour')",[second,lease,binding.cutoff]);
  const first=createRoleInferenceLedger(pool,binding), next=createRoleInferenceLedger(pool,{...binding,jobId:second});
  assert.equal((await first.reserve()).status,'reserved');
  assert.deepEqual(await next.reserve(),{status:'needs_review'});
  assert.equal((await first.finish(1,'settled')).status,'settled');
  assert.deepEqual(await next.reserve(),{status:'needs_review'});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_role_inference_attempts')).rows[0].n,1);
});
test('другое задание на тот же переход не получает право при локальной гонке',enabled,async t=>{
  const {db,pool}=await fixture(t), second='00000000-0000-4000-8000-000000000004';
  await db.query("INSERT INTO public.lost_processing_jobs VALUES ($1,42,$3::timestamptz,'manual:test:2','manual','processing',$2,clock_timestamp()+interval '1 hour')",[second,lease,binding.cutoff]);
  const a=createRoleInferenceLedger(pool,binding),b=createRoleInferenceLedger(pool,{...binding,jobId:second});
  const results=await Promise.all([a.reserve(),b.reserve()]);
  assert.deepEqual(results.map(x=>x.status).sort(),['needs_review','reserved']);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_role_inference_attempts')).rows[0].n,1);
});
test('одно задание нельзя переназначить другому переходу, а чужая сделка не проходит проверку аренды',enabled,async t=>{
  const {db,pool}=await fixture(t), first=createRoleInferenceLedger(pool,binding);
  assert.equal((await first.reserve()).status,'reserved');assert.equal((await first.finish(1,'settled')).status,'settled');
  assert.deepEqual(await createRoleInferenceLedger(pool,{...binding,stageHistoryId:'124'}).reserve(),{status:'lease_lost'});
  assert.deepEqual(await createRoleInferenceLedger(pool,{...binding,dealId:'43'}).reserve(),{status:'lease_lost'});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_role_inference_attempts')).rows[0].n,1);
});
test('live/backfill задание допускает только history ID из канонического ключа',enabled,async t=>{
  const {db,pool}=await fixture(t);
  await db.query("UPDATE public.lost_processing_jobs SET request_key='bitrix24:deal-stage-history:123',trigger_type='live'");
  assert.deepEqual(await createRoleInferenceLedger(pool,{...binding,stageHistoryId:'124'}).reserve(),{status:'lease_lost'});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_role_inference_attempts')).rows[0].n,0);
  assert.equal((await createRoleInferenceLedger(pool,binding).reserve()).status,'reserved');
});
test('manual/nightly допускает только подтверждённый origin, независимо от доставки',enabled,async t=>{
  for(const trigger of ['manual','nightly']) {
    const {db,pool}=await fixture(t);
    await db.query('UPDATE public.lost_processing_jobs SET trigger_type=$1,origin_stage_history_id=$2',[trigger,'124']);
    assert.deepEqual(await createRoleInferenceLedger(pool,binding).reserve(),{status:'lease_lost'});
    await db.query("INSERT INTO public.lost_audio_wait VALUES (42,$1,'123','done',NULL)",[binding.cutoff]);
    assert.deepEqual(await createRoleInferenceLedger(pool,binding).reserve(),{status:'lease_lost'});
    await db.query("UPDATE public.lost_processing_jobs SET origin_stage_history_id='123',silent=false");
    assert.equal((await createRoleInferenceLedger(pool,binding).reserve()).status,'reserved');
  }
});
test('audio_wait требует исходный переход и актуальный ключ расписания',enabled,async t=>{
  const {db,pool}=await fixture(t), next='2026-10-28T05:40:03.000Z';
  const key=`audio-wait:42:${Date.parse(binding.cutoff)*1000}:${Date.parse(next)*1000}`;
  await db.query("UPDATE public.lost_processing_jobs SET trigger_type='audio_wait',request_key=$1",[key]);
  await db.query("INSERT INTO public.lost_audio_wait VALUES (42,$1,'123','waiting',$2)",[binding.cutoff,next]);
  await db.query("UPDATE public.lost_processing_jobs SET request_key='audio-wait:stale'");
  assert.deepEqual(await createRoleInferenceLedger(pool,binding).reserve(),{status:'lease_lost'});
  await db.query('UPDATE public.lost_processing_jobs SET request_key=$1',[key]);
  assert.equal((await createRoleInferenceLedger(pool,binding).reserve()).status,'reserved');
});
test('manual с пустым origin может опираться на подтверждённую очередь аудио',enabled,async t=>{
  const {db,pool}=await fixture(t);
  await db.query('UPDATE public.lost_processing_jobs SET origin_stage_history_id=NULL');
  await db.query("INSERT INTO public.lost_audio_wait VALUES (42,$1,'123','done',NULL)",[binding.cutoff]);
  assert.equal((await createRoleInferenceLedger(pool,binding).reserve()).status,'reserved');
});
test('потеря или смена аренды сохраняет reserved и исключает отметку settled',enabled,async t=>{
  const {db,pool}=await fixture(t), ledger=createRoleInferenceLedger(pool,binding);
  assert.equal((await ledger.reserve()).status,'reserved');
  await db.query(`UPDATE public.lost_processing_jobs SET lease_token=$2,lease_until=clock_timestamp()+interval '1 hour' WHERE id=$1`,[job,other]);
  assert.deepEqual(await ledger.finish(1,'settled'),{status:'lease_lost'});
  assert.deepEqual(await createRoleInferenceLedger(pool,{...binding,leaseToken:other}).reserve(),{status:'needs_review'});
  assert.equal((await db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'reserved');
});
test('preSend разрешает только фактически зарезервированную попытку своей аренды',enabled,async t=>{
  const {db,pool}=await fixture(t), ledger=createRoleInferenceLedger(pool,binding);
  assert.deepEqual(await ledger.preSend(1),{status:'needs_review'});
  assert.equal((await ledger.reserve()).status,'reserved');
  assert.deepEqual(await ledger.preSend(2),{status:'needs_review'});
  assert.deepEqual(await ledger.preSend(1),{status:'allowed'});
  assert.equal((await db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'reserved');
  assert.equal((await ledger.finish(1,'settled')).status,'settled');
  assert.deepEqual(await ledger.preSend(1),{status:'needs_review'});
});
test('preSend после потери аренды не разрешает POST и оставляет reserved',enabled,async t=>{
  const {db,pool}=await fixture(t), ledger=createRoleInferenceLedger(pool,binding);
  assert.equal((await ledger.reserve()).status,'reserved');
  await db.query("UPDATE public.lost_processing_jobs SET lease_token=$2 WHERE id=$1",[job,other]);
  assert.deepEqual(await ledger.preSend(1),{status:'lease_lost'});
  assert.equal((await db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'reserved');
});
test('неизвестный COMMIT preSend не разрешает POST',enabled,async t=>{
  const {db,pool:base}=await fixture(t);let commits=0;
  const pool={async connect(){const c=await base.connect();return {async query(sql,args){
    if(/^COMMIT\b/i.test(sql)&&++commits===3){await c.query(sql,args);throw new Error('SECRET_COMMIT');}
    return c.query(sql,args);
  },release:c.release};}};
  const ledger=createRoleInferenceLedger(pool,binding);let sent=0;
  assert.equal((await ledger.reserve()).status,'reserved');
  await assert.rejects(async()=>{if((await ledger.preSend(1)).status==='allowed')sent++;},/ROLE_LEDGER_COMMIT_OUTCOME_UNKNOWN/);
  assert.equal(sent,0);await assert.rejects(ledger.preSend(1),/ROLE_LEDGER_CLOSED/);
  assert.equal((await db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'reserved');
});
test('истёкшая аренда не резервирует новый POST',enabled,async t=>{
  const {db,pool}=await fixture(t);await db.query(`UPDATE public.lost_processing_jobs SET lease_until=clock_timestamp()-interval '1 second'`);
  assert.deepEqual(await createRoleInferenceLedger(pool,binding).reserve(),{status:'lease_lost'});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_role_inference_attempts')).rows[0].n,0);
});
test('локально параллельные процессы не получают одновременно право на POST',enabled,async t=>{
  const {db,pool}=await fixture(t);
  const one=createRoleInferenceLedger(pool,binding);
  const two=createRoleInferenceLedger(pool,binding);
  const results=await Promise.all([one.reserve(),two.reserve()]);
  assert.deepEqual(results.map(x=>x.status).sort(),['needs_review','reserved']);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.lost_role_inference_attempts')).rows[0].n,1);
});
test('потерянное подтверждение COMMIT не выдаёт право на отправку и сохраняет блокировку в базе',enabled,async t=>{
  const {db,pool}=await fixture(t,{lostCommit:true});let sent=0;
  const ledger=createRoleInferenceLedger(pool,binding);
  await assert.rejects(async()=>{const result=await ledger.reserve();if(result.status==='reserved')sent++;},/ROLE_LEDGER_COMMIT_OUTCOME_UNKNOWN/);
  assert.equal(sent,0);await assert.rejects(ledger.reserve(),/ROLE_LEDGER_CLOSED/);
  assert.equal((await db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'reserved');
  assert.deepEqual(await createRoleInferenceLedger(pool,binding).reserve(),{status:'needs_review'});
});
test('ожидающий reserve не проходит после неизвестного COMMIT параллельного finish',enabled,async t=>{
  const {db,pool:base}=await fixture(t);let commits=0,entered,release;
  const waiting=new Promise(resolve=>{entered=resolve;}), hold=new Promise(resolve=>{release=resolve;});
  const pool={async connect(){const c=await base.connect();return {async query(sql,args){
    if(/^COMMIT\b/i.test(sql) && ++commits===3){
      await c.query(sql,args);entered();await hold;throw new Error('SECRET_LOST_COMMIT');
    }
    return c.query(sql,args);
  },release:c.release};}};
  const ledger=createRoleInferenceLedger(pool,binding);
  assert.equal((await ledger.reserve()).status,'reserved'); // резерв и fence = 2 COMMIT
  const finishing=ledger.finish(1,'settled');await waiting;
  await assert.rejects(ledger.reserve(),/ROLE_LEDGER_BUSY/);
  release();await assert.rejects(finishing,/ROLE_LEDGER_COMMIT_OUTCOME_UNKNOWN/);
  await assert.rejects(ledger.reserve(),/ROLE_LEDGER_CLOSED/);
  assert.equal((await db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'settled');
});
test('истечение аренды во время COMMIT резерва не выдаёт право на POST',enabled,async t=>{
  const {db,pool:base}=await fixture(t);let first=true;
  const pool={async connect(){const c=await base.connect();return {async query(sql,args){
    const result=await c.query(sql,args);
    if(/^COMMIT\b/i.test(sql)&&first){first=false;await db.query("UPDATE public.lost_processing_jobs SET lease_until=clock_timestamp()-interval '1 second'");}
    return result;
  },release:c.release};}};
  let sent=0;const result=await createRoleInferenceLedger(pool,binding).reserve();
  if(result.status==='reserved')sent++;
  assert.deepEqual(result,{status:'lease_lost'});assert.equal(sent,0);
  assert.equal((await db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'reserved');
});
test('долгий COMMIT проверки аренды не выдаёт право на POST при истечении срока',enabled,async t=>{
  const {db,pool:base}=await fixture(t);let commits=0;
  await db.query("UPDATE public.lost_processing_jobs SET lease_until=clock_timestamp()+interval '1500 milliseconds'");
  const pool={async connect(){const c=await base.connect();return {async query(sql,args){
    const result=await c.query(sql,args);
    if(/^COMMIT\b/i.test(sql)&&++commits===2)await new Promise(resolve=>setTimeout(resolve,1700));
    return result;
  },release:c.release};}};
  const result=await createRoleInferenceLedger(pool,binding).reserve();
  assert.deepEqual(result,{status:'lease_lost'});
  assert.equal((await db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'reserved');
});
test('неверные идентификаторы и исход не принимаются до работы с базой',()=>{
  const pool={async connect(){throw Error('must not connect');}};
  assert.throws(()=>createRoleInferenceLedger(pool,{...binding,jobId:'1'}),TypeError);
  assert.throws(()=>createRoleInferenceLedger(pool,{...binding,dealId:'0'}),TypeError);
  assert.throws(()=>createRoleInferenceLedger(pool,{...binding,stageHistoryId:null}),TypeError);
  assert.throws(()=>createRoleInferenceLedger(pool,{...binding,stageHistoryId:'0123'}),TypeError);
  assert.throws(()=>createRoleInferenceLedger(pool,{...binding,cutoff:null}),TypeError);
  assert.throws(()=>createRoleInferenceLedger(pool,{...binding,cutoff:'2026-10-28'}),TypeError);
  assert.throws(()=>createRoleInferenceLedger(pool,{...binding,cutoff:'2026-10-28T05:35:03.000001Z'}),TypeError);
  const ledger=createRoleInferenceLedger(pool,binding);
  return Promise.all([
    assert.rejects(ledger.finish(0,'settled'),TypeError),
    assert.rejects(ledger.finish(1,'sent'),TypeError),
  ]);
});
test('ошибка release не раскрывает текст и закрывает экземпляр без права на отправку',async()=>{
  const pool={async connect(){return {async query(sql){
    if(/^SELECT id\b/i.test(sql))return {rows:[]};return {rows:[]};
  },release(){throw new Error('SECRET_RELEASE');}};}};
  const ledger=createRoleInferenceLedger(pool,binding);
  await assert.rejects(ledger.reserve(),error=>error.message==='ROLE_LEDGER_UNAVAILABLE');
  await assert.rejects(ledger.reserve(),/ROLE_LEDGER_CLOSED/);
});
