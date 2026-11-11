import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { claimSttAttempt } from '../../app/src/persistence/stt-attempts.mjs';
import { prepareBeginArtifact, savePrejudgeArtifact } from '../../app/src/persistence/prejudge.mjs';

// Никаких DATABASE_URL и TCP к БД: только сокет, созданный локальным harness.
const socket = process.env.OTKAZY_LOCAL_PG_SOCKET;
const enabled = process.env.OTKAZY_LOCAL_PG_TEST === '1'
  && /^\/tmp\/otkazy-local-pg-[A-Za-z0-9]{8}$/.test(socket || '')
  && process.env.OTKAZY_LOCAL_PG_PORT === '56471';
const local = { skip: !enabled, timeout: 15000 };
const requireApp = createRequire(new URL('../../app/package.json', import.meta.url));
const job = '00000000-0000-4000-8000-000000000101';
const otherJob = '00000000-0000-4000-8000-000000000102';
const lease = '00000000-0000-4000-8000-000000000103';
const scope = { operationId:job, leaseToken:lease, dealId:42, stageHistoryId:'123', loseDate:'2026-10-28T05:35:03.000Z' };
const request = { file_id:'10', activity_id:'20', call_date:'2026-10-27T05:35:03.000Z', channel_count:2 };
const attempt = { request, audioSha256:'b'.repeat(64), policySha256:'a'.repeat(64), expectedEngine:'reserve:gigaam' };
let pool;

before(async () => {
  if (!enabled) return;
  const { Pool } = requireApp('pg');
  pool = new Pool({ host:socket, port:56471, user:'otkazytest', database:'otkazytest', ssl:false, max:4,
    connectionTimeoutMillis:3000, application_name:'otkazy_manual_schema_test' });
  const identity = await pool.query("SELECT current_database() AS db, inet_server_addr() AS addr, current_setting('data_directory') AS data, current_setting('listen_addresses') AS listens");
  assert.deepEqual(identity.rows[0], { db:'otkazytest', addr:null, data:`${socket}/data`, listens:'' });
  const absent = await pool.query("SELECT to_regclass('public.lost_processing_jobs') AS jobs, to_regclass('public.lost_audio_wait') AS audio, to_regclass('public.lost_prejudge_artifacts') AS artifacts, to_regclass('public.lost_prejudge_stt_attempts') AS attempts");
  assert.deepEqual(absent.rows[0], { jobs:null, audio:null, artifacts:null, attempts:null });
  // Существующая таблица в такой форме намеренно не имеет колонки origin.
  await pool.query(`CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE public.lost_audio_wait (deal_id integer PRIMARY KEY, lose_date timestamptz NOT NULL,
      state text NOT NULL, next_check_at timestamptz NOT NULL)`);
  await pool.query(await readFile(new URL('../../db/proposals/20261109_manual_staging_queue.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../../db/proposals/20261109_prejudge_artifacts.sql', import.meta.url), 'utf8'));
});

beforeEach(async () => {
  if (!enabled) return;
  await pool.query('TRUNCATE public.lost_prejudge_stt_attempts, public.lost_prejudge_artifacts, public.lost_audio_wait, public.lost_processing_jobs');
  await pool.query(`INSERT INTO public.lost_processing_jobs
    (id,request_key,deal_id,lose_date,trigger_type,silent,status,lease_token,lease_until)
    VALUES ($1,'bitrix24:deal-stage-history:123',42,$3::timestamptz,'manual',true,'processing',$2,clock_timestamp()+interval '1 hour')`,
    [job, lease, scope.loseDate]);
});

after(async () => { if (pool) await pool.end(); });

test('фрагмент queue совпадает с готовой миграцией и не меняет других таблиц', async () => {
  const original = await readFile(new URL('../../db/proposals/worker-migration-fixtures/20261105052525_lost_processing_jobs.sql', import.meta.url), 'utf8');
  const proposal = await readFile(new URL('../../db/proposals/20261109_manual_staging_queue.sql', import.meta.url), 'utf8');
  const statements = text => text.replace(/--[^\n]*/g,'').split(';').map(s=>s.replace(/\s+/g,' ').trim().toLowerCase()).filter(Boolean);
  const source = statements(original), selected = statements(proposal);
  assert.deepEqual(selected.slice(0,6), source.slice(0,6));
  assert.deepEqual(selected.slice(6), ['alter table public.lost_processing_jobs enable row level security',
    'revoke all on public.lost_processing_jobs from public, anon, authenticated']);
});

test('каноническая ручная запись и резервирование работают без origin-колонки', local, async () => {
  const column = await pool.query(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='lost_audio_wait' AND column_name='origin_stage_history_id') AS present`);
  assert.equal(column.rows[0].present,false);
  const artifact = prepareBeginArtifact({ sttAttempts:true });
  assert.equal((await savePrejudgeArtifact(pool,{ ...scope,artifact })).saved,true);
  assert.equal((await savePrejudgeArtifact(pool,{ ...scope,artifact })).saved,true);
  assert.equal((await claimSttAttempt(pool,{ scope,...attempt })).allowed,true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.lost_prejudge_artifacts')).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.lost_prejudge_stt_attempts WHERE status='pending'")).rows[0].n,1);
});

test('неканонический ключ без origin не разрешает запись или отправку', local, async () => {
  await pool.query("UPDATE public.lost_processing_jobs SET request_key='manual:unit' WHERE id=$1",[job]);
  await assert.rejects(savePrejudgeArtifact(pool,{ ...scope,artifact:prepareBeginArtifact({sttAttempts:true}) }));
  await assert.rejects(claimSttAttempt(pool,{ scope,...attempt }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.lost_prejudge_artifacts')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.lost_prejudge_stt_attempts')).rows[0].n,0);
});

test('ограничения настоящей очереди запрещают двойную обработку и аренду без токена', local, async () => {
  await assert.rejects(pool.query(`INSERT INTO public.lost_processing_jobs
    (id,request_key,deal_id,lose_date,trigger_type,silent,status,lease_token,lease_until)
    VALUES ($1,'manual:second',42,$3::timestamptz,'manual',true,'processing',$2,clock_timestamp()+interval '1 hour')`,
    [otherJob,lease,scope.loseDate]), e => e.code==='23505' && e.constraint==='lost_jobs_one_processing_per_deal');
  await assert.rejects(pool.query(`INSERT INTO public.lost_processing_jobs
    (id,request_key,deal_id,lose_date,trigger_type,silent,status,lease_until)
    VALUES ($1,'manual:other',43,$2::timestamptz,'manual',true,'processing',clock_timestamp()+interval '1 hour')`,
    [otherJob,scope.loseDate]), e => e.code==='23514' && e.constraint==='lost_jobs_lease_consistent');
  const row = (await pool.query('SELECT silent,status,comment_state,notify_state FROM public.lost_processing_jobs WHERE id=$1',[job])).rows[0];
  assert.deepEqual(row,{silent:true,status:'processing',comment_state:'pending',notify_state:'pending'});
});

test('RLS включён и anon/authenticated не имеют прямых прав на новые таблицы', local, async () => {
  const tables=['lost_processing_jobs','lost_prejudge_artifacts','lost_prejudge_stt_attempts'];
  const flags=await pool.query(`SELECT relname,relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND relname = ANY($1::text[]) ORDER BY relname`,[tables]);
  assert.equal(flags.rowCount,3);assert.ok(flags.rows.every(row=>row.relrowsecurity));
  for (const role of ['anon','authenticated']) for (const table of tables) for (const privilege of ['SELECT','INSERT','UPDATE','DELETE']) {
    const row=(await pool.query('SELECT has_table_privilege($1,$2,$3) AS allowed',[role,`public.${table}`,privilege])).rows[0];
    assert.equal(row.allowed,false,`${role} ${privilege} ${table}`);
  }
});
