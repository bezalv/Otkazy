import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createRoleInferenceLedger } from '../../app/src/worker/role-inference-ledger.mjs';

// Запускается исключительно явным локальным harness: никакого DATABASE_URL,
// TCP и рабочей базы. Сокет и каталог данных должны принадлежать mktemp.
const socket = process.env.OTKAZY_LOCAL_PG_SOCKET;
const enabled = process.env.OTKAZY_LOCAL_PG_TEST === '1'
  && /^\/tmp\/otkazy-local-pg-[A-Za-z0-9]{8}$/.test(socket || '')
  && process.env.OTKAZY_LOCAL_PG_PORT === '56471';
const local = { skip: !enabled, timeout: 15000 };
const requireApp = createRequire(new URL('../../app/package.json', import.meta.url));
let pool;
const job = '00000000-0000-4000-8000-000000000001';
const job2 = '00000000-0000-4000-8000-000000000004';
const lease = '00000000-0000-4000-8000-000000000002';
const otherLease = '00000000-0000-4000-8000-000000000003';
const binding = { jobId:job, leaseToken:lease, dealId:'42', stageHistoryId:'123', cutoff:'2026-10-28T05:35:03.000Z' };

before(async () => {
  if (!enabled) return;
  const { Pool } = requireApp('pg');
  pool = new Pool({ host:socket, port:56471, user:'otkazytest', database:'otkazytest', ssl:false,
    max:6, connectionTimeoutMillis:3000, application_name:'otkazy_ledger_isolated_test' });
  const identity = await pool.query("SELECT current_database() AS db, inet_server_addr() AS addr, current_setting('data_directory') AS data, current_setting('listen_addresses') AS listens");
  assert.deepEqual(identity.rows[0], { db:'otkazytest', addr:null, data:`${socket}/data`, listens:'' });
  const absent = await pool.query("SELECT to_regclass('public.lost_processing_jobs') AS jobs, to_regclass('public.lost_role_inference_attempts') AS attempts, to_regclass('public.lost_role_inference_scopes') AS scopes");
  assert.deepEqual(absent.rows[0], { jobs:null, attempts:null, scopes:null });
  await pool.query(`CREATE TABLE public.lost_processing_jobs (
    id uuid PRIMARY KEY, deal_id bigint NOT NULL, lose_date timestamptz NOT NULL,
    request_key text NOT NULL, trigger_type text NOT NULL, status text NOT NULL,
    lease_token uuid, lease_until timestamptz
  );
  CREATE TABLE public.lost_role_inference_scopes (
    deal_id bigint NOT NULL, stage_history_id text NOT NULL CHECK(stage_history_id ~ '^[1-9][0-9]{0,29}$'),
    PRIMARY KEY(deal_id,stage_history_id)
  );
  CREATE TABLE public.lost_role_inference_attempts (
    job_id uuid NOT NULL REFERENCES public.lost_processing_jobs(id),
    attempt_no smallint NOT NULL CHECK(attempt_no BETWEEN 1 AND 3),
    deal_id bigint NOT NULL, stage_history_id text NOT NULL, lease_token uuid NOT NULL,
    run_id uuid NOT NULL, state text NOT NULL CHECK(state IN ('reserved','settled','unknown')),
    created_at timestamptz NOT NULL, finished_at timestamptz,
    CHECK((state='reserved' AND finished_at IS NULL) OR (state IN ('settled','unknown') AND finished_at IS NOT NULL)),
    PRIMARY KEY(job_id,attempt_no),
    FOREIGN KEY(deal_id,stage_history_id) REFERENCES public.lost_role_inference_scopes(deal_id,stage_history_id)
  )`);
});
after(async () => { if (pool) await pool.end(); });
beforeEach(async () => {
  if (!enabled) return;
  await pool.query('TRUNCATE public.lost_role_inference_attempts, public.lost_role_inference_scopes, public.lost_processing_jobs');
  await pool.query("INSERT INTO public.lost_processing_jobs VALUES ($1,42,$3,'manual:test:1','manual','processing',$2,clock_timestamp()+interval '1 hour')", [job,lease,binding.cutoff]);
});

test('две независимые сессии PostgreSQL доступны одновременно',local,async () => {
  const a = await pool.connect(), b = await pool.connect();
  try {
    const [x,y] = await Promise.all([a.query('SELECT pg_backend_pid() AS pid'), b.query('SELECT pg_backend_pid() AS pid')]);
    assert.notEqual(x.rows[0].pid, y.rows[0].pid);
  } finally { a.release(); b.release(); }
});

test('два разных задания одного перехода не могут одновременно зарезервировать POST',local,async () => {
  await pool.query("INSERT INTO public.lost_processing_jobs VALUES ($1,42,$3,'manual:test:2','manual','processing',$2,clock_timestamp()+interval '1 hour')", [job2,lease,binding.cutoff]);
  await pool.query("INSERT INTO public.lost_role_inference_scopes VALUES (42,'123')");
  const a = createRoleInferenceLedger(pool,binding), b = createRoleInferenceLedger(pool,{...binding,jobId:job2});
  const blocker = await pool.connect();
  let pending;
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT deal_id FROM public.lost_role_inference_scopes WHERE deal_id=42 AND stage_history_id='123' FOR UPDATE");
    pending = Promise.all([a.reserve(),b.reserve()]);
    let blocked = 0;
    for (let n=0; n<100 && blocked<2; n++) {
      const x = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='otkazy_ledger_isolated_test' AND wait_event_type='Lock' AND query LIKE '%FROM public.lost_role_inference_scopes%'");
      blocked = x.rows[0].n;
      if (blocked<2) await new Promise(resolve => setTimeout(resolve,20));
    }
    assert.equal(blocked,2,'оба независимых соединения одновременно ожидают одну область');
    await blocker.query('COMMIT');
    const result = await pending;
    assert.deepEqual(result.map(x => x.status).sort(), ['needs_review','reserved']);
  } finally {
    await blocker.query('ROLLBACK').catch(()=>{});
    blocker.release();
    if (pending) await pending.catch(()=>{});
  }
  const rows = await pool.query('SELECT state FROM public.lost_role_inference_attempts');
  assert.deepEqual(rows.rows,[{state:'reserved'}]);
});

test('два экземпляра ledger с одной арендой не могут одновременно зарезервировать POST',local,async () => {
  const a = createRoleInferenceLedger(pool,binding), b = createRoleInferenceLedger(pool,binding);
  const blocker = await pool.connect();
  let pending;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM public.lost_processing_jobs WHERE id=$1 FOR UPDATE',[job]);
    pending = Promise.all([a.reserve(),b.reserve()]);
    let blocked = 0;
    for (let n=0; n<100 && blocked<2; n++) {
      const x = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='otkazy_ledger_isolated_test' AND wait_event_type='Lock' AND query LIKE '%FROM public.lost_processing_jobs%'");
      blocked = x.rows[0].n;
      if (blocked<2) await new Promise(resolve => setTimeout(resolve,20));
    }
    assert.equal(blocked,2,'оба соединения одновременно ожидают строку задания');
    await blocker.query('COMMIT');
    const result = await pending;
    assert.deepEqual(result.map(x => x.status).sort(), ['needs_review','reserved']);
  } finally {
    await blocker.query('ROLLBACK').catch(()=>{});
    blocker.release();
    if (pending) await pending.catch(()=>{});
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.lost_role_inference_attempts')).rows[0].n,1);
});

test('разные подтверждённые переходы одного клиента не блокируют друг друга',local,async () => {
  await pool.query("INSERT INTO public.lost_processing_jobs VALUES ($1,42,$3,'manual:test:2','manual','processing',$2,clock_timestamp()+interval '1 hour')", [job2,lease,binding.cutoff]);
  await pool.query("INSERT INTO public.lost_role_inference_scopes VALUES (42,'123')");
  const a = createRoleInferenceLedger(pool,binding), b = createRoleInferenceLedger(pool,{...binding,jobId:job2,stageHistoryId:'124'});
  const blocker = await pool.connect();
  let pendingA, pendingB, timer;
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT deal_id FROM public.lost_role_inference_scopes WHERE deal_id=42 AND stage_history_id='123' FOR UPDATE");
    pendingA = a.reserve();
    let blocked = false;
    for (let n=0; n<100 && !blocked; n++) {
      const x = await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='otkazy_ledger_isolated_test' AND wait_event_type='Lock' AND query LIKE '%FROM public.lost_role_inference_scopes%') AS blocked");
      blocked = x.rows[0].blocked;
      if (!blocked) await new Promise(resolve => setTimeout(resolve,20));
    }
    assert.equal(blocked,true,'первый переход действительно ожидает блокировку');
    pendingB = b.reserve();
    const independent = await Promise.race([pendingB,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('второй переход оказался заблокирован')),2000);})]);
    clearTimeout(timer);
    assert.equal(independent.status,'reserved');
    await blocker.query('COMMIT');
    assert.equal((await pendingA).status,'reserved');
  } finally {
    clearTimeout(timer);
    await blocker.query('ROLLBACK').catch(()=>{});
    blocker.release();
    await Promise.allSettled([pendingA,pendingB].filter(Boolean));
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.lost_role_inference_scopes')).rows[0].n,2);
});

test('смена аренды во время ожидания блокировки запрещает отправку',local,async () => {
  const ledger = createRoleInferenceLedger(pool,binding);
  assert.equal((await ledger.reserve()).status,'reserved');
  const locked = await pool.connect();
  let check;
  try {
    await locked.query('BEGIN');
    await locked.query('SELECT id FROM public.lost_processing_jobs WHERE id=$1 FOR UPDATE',[job]);
    check = ledger.preSend(1);
    let blocked = false;
    for (let n=0; n<100 && !blocked; n++) {
      const x = await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='otkazy_ledger_isolated_test' AND wait_event_type='Lock' AND query LIKE '%FROM public.lost_processing_jobs%') AS blocked");
      blocked = x.rows[0].blocked;
      if (!blocked) await new Promise(resolve => setTimeout(resolve,20));
    }
    assert.equal(blocked,true,'второе соединение действительно ждёт блокировку');
    await locked.query('UPDATE public.lost_processing_jobs SET lease_token=$2 WHERE id=$1',[job,otherLease]);
    await locked.query('COMMIT');
    assert.deepEqual(await check,{status:'lease_lost'});
    assert.equal((await pool.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'reserved');
  } finally {
    await locked.query('ROLLBACK').catch(()=>{});
    locked.release();
    if (check) await check.catch(()=>{});
  }
});

test('потерянный ответ COMMIT не разрешает повтор после нового соединения',local,async () => {
  let inject = true;
  const faultPool = { async connect() {
    const c = await pool.connect();
    return { async query(sql,args) {
      if (inject && /^COMMIT\b/i.test(sql)) { inject=false; await c.query(sql,args); throw new Error('simulated lost COMMIT response'); }
      return c.query(sql,args);
    }, release(error) { c.release(error); } };
  } };
  const first = createRoleInferenceLedger(faultPool,binding);
  await assert.rejects(first.reserve(),/ROLE_LEDGER_COMMIT_OUTCOME_UNKNOWN/);
  const second = createRoleInferenceLedger(pool,binding);
  assert.deepEqual(await second.reserve(),{status:'needs_review'});
  assert.equal((await pool.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'reserved');
});
