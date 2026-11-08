import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJobQueue } from '../../app/src/queue/index.mjs';
import { loadAudioWait, enqueueDueAudioChecks } from '../../app/src/audio-wait/scheduler.mjs';
import { persistResult, loadResumableResult } from '../../app/src/persistence/index.mjs';
import { runJob } from '../../app/src/worker/run-job.mjs';
import { randomUUID } from 'node:crypto';

const path = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const date = '2026-11-04T00:00:00Z';
const orig = { ID: '101', STAGE_ID: 'C23:LOSE', CREATED_TIME: date };

test('ожидание хранит ID при перезапуске, неоднозначный повтор не отменяет очередь', { skip: !existsSync(path) }, async t => {
  const { PGlite } = await import(pathToFileURL(path).href);
  const db = new PGlite();
  t.after(() => db.close());
  for (const filename of ['tests/restore-persistence/synthetic-schema.sql',
    'supabase/migrations/20261105052525_lost_processing_jobs.sql',
    'supabase/migrations/20261105065551_lost_overwrite_history.sql',
    'supabase/migrations/20261106031734_lost_audio_wait_origins.sql']) await db.exec(readFileSync(filename, 'utf8'));
  const query = (q, values) => typeof q === 'string' ? db.query(q, values) : db.query(q.text, q.values);
  const pool = { query, async connect() { return { query, release() {} }; } };
  const deps = () => ({ queue: createJobQueue(pool), store: { persistResult: data => persistResult(pool, data),
    loadResumableResult: data => loadResumableResult(pool, data) }, loadAudioWait: job => loadAudioWait(pool, job) });
  let history = [orig, { ID: '100', STAGE_ID: 'C23:NEW', CREATED_TIME: '2026-11-03T00:00:00Z' }];
  let fetchCalls = 0, llmCalls = 0, deliveries = 0;
  const bitrix = { async request(method, body) {
    if (method === 'crm.deal.userfield.list') return { result: [{ LIST: [{ ID: '1', VALUE: 'Другая' }] }] };
    if (method === 'crm.deal.get') return { result: { ID: '42', STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: '65', UF_CRM_1584703948317: '1' } };
    if (method === 'crm.stagehistory.list') return { result: { items: history }, total: history.length };
    if (method === 'crm.activity.list' && body.filter.TYPE_ID) { fetchCalls++; return { result: [{ ID: '99', PROVIDER_ID: 'VOXIMPLANT_CALL', COMPLETED: 'Y', CREATED: '2026-11-03T23:55:00Z', START_TIME: '2026-11-03T23:55:00Z', END_TIME: '2026-11-03T23:56:00Z', FILES: [] }] }; }
    if (method === 'crm.activity.list' || method === 'crm.timeline.comment.list' || method === 'imopenlines.crm.chat.get') return { result: [] };
    if (method === 'tasks.task.list') return { result: { tasks: [] } };
    throw new Error('Неожиданный метод');
  } };
  const processOptions = { bitrix, nowMs: Date.parse('2026-11-04T01:00:00Z'), audioWaitEnabledAt: '2026-11-01T00:00:00Z',
    judgeSystemPrompt: 'Судья', writerSystemPrompt: 'Писатель', wait: async () => {},
    llm: { async complete() { llmCalls++; throw new Error('Не должна вызываться'); } } };
  const delivery = async () => { deliveries++; throw new Error('Не должна вызываться'); };

  let d = deps();
  await d.queue.enqueue({ requestKey: 'bitrix24:deal-stage-history:101', dealId: 42, loseDate: date, triggerType: 'live' });
  let job = await d.queue.claim();
  assert.equal((await runJob({ ...d, job, processOptions, delivery })).status, 'waiting_audio');
  let waiting = (await db.query('SELECT state,origin_stage_history_id FROM lost_audio_wait WHERE deal_id=42')).rows[0];
  assert.deepEqual(waiting, { state: 'waiting', origin_stage_history_id: '101' });

  // Новый экземпляр обработчика читает ID из БД, не из памяти старого процесса.
  assert.equal((await enqueueDueAudioChecks(pool)).length, 1);
  d = deps(); job = await d.queue.claim();
  history = [{ ID: '102', STAGE_ID: 'C23:LOSE', CREATED_TIME: date }, orig];
  assert.equal((await runJob({ ...d, job, processOptions, delivery })).status, 'error');
  waiting = (await db.query('SELECT state,origin_stage_history_id FROM lost_audio_wait WHERE deal_id=42')).rows[0];
  assert.deepEqual(waiting, { state: 'waiting', origin_stage_history_id: '101' });
  const analyses = (await db.query('SELECT ai_verdict,pipeline_error FROM lost_deal_analyses WHERE deal_id=42')).rows;
  assert.equal(analyses.length, 1);
  assert.equal(analyses[0].ai_verdict, null);
  assert.ok(analyses[0].pipeline_error);
  assert.equal(fetchCalls, 1);
  assert.equal(llmCalls, 0);
  assert.equal(deliveries, 0);

  // Конфликтующий ID с той же датой не меняет строку даже через прямую запись;
  // ошибка откатывает транзакцию, и затем явный skip другого ID её не отменит.
  const operation = randomUUID(), lease = randomUUID();
  await db.query(`INSERT INTO lost_processing_jobs (id,request_key,deal_id,lose_date,trigger_type,status,lease_token,lease_until)
    VALUES ($1,$2,42,$3,'manual','processing',$4,now()+interval '1 hour')`, [operation, `manual:${operation}`, date, lease]);
  const persisted = (await db.query('SELECT * FROM lost_audio_wait WHERE deal_id=42')).rows[0];
  const mismatched = { ...persisted, origin_stage_history_id: '102' };
  await assert.rejects(persistResult(pool, { operation_id: operation, lease_token: lease, deal_id: 42,
    _status: 'waiting_audio', audio_wait: mismatched }), /ожидания записи|очереди аудио/);
  assert.deepEqual((await db.query('SELECT state,origin_stage_history_id FROM lost_audio_wait WHERE deal_id=42')).rows[0],
    { state: 'waiting', origin_stage_history_id: '101' });
  assert.equal((await db.query('SELECT status FROM lost_processing_jobs WHERE id=$1', [operation])).rows[0].status, 'processing');
  await persistResult(pool, { operation_id: operation, lease_token: lease, deal_id: 42,
    _status: 'skipped', audio_origin_stage_history_id: '102' });
  assert.deepEqual((await db.query('SELECT state,origin_stage_history_id FROM lost_audio_wait WHERE deal_id=42')).rows[0],
    { state: 'waiting', origin_stage_history_id: '101' });

  // Старую строку без ID нельзя автоматически привязать к найденному событию.
  await db.query(`INSERT INTO lost_audio_wait (deal_id,lose_date,state,first_seen_at,deadline_at,next_check_at,pending_calls,observations,silent,screenshots)
    VALUES (43,$1,'waiting',$1,$1,$1,'[]'::jsonb,'{}'::jsonb,false,true)`, [date]);
  assert.equal((await enqueueDueAudioChecks(pool)).length, 1);
  d = deps(); job = await d.queue.claim();
  assert.equal(Number(job.deal_id), 43);
  assert.deepEqual(await runJob({ ...d, job, processOptions, delivery }), { status: 'needs_review', reason: 'audio_origin_missing' });
  const held = (await db.query('SELECT status,last_error,comment_state,notify_state FROM lost_processing_jobs WHERE id=$1', [job.id])).rows[0];
  assert.deepEqual(held, { status: 'needs_review', last_error: 'audio_origin_missing', comment_state: 'pending', notify_state: 'pending' });
  const legacy = (await db.query('SELECT state,origin_stage_history_id FROM lost_audio_wait WHERE deal_id=43')).rows[0];
  assert.deepEqual(legacy, { state: 'waiting', origin_stage_history_id: null });
  assert.equal((await enqueueDueAudioChecks(pool)).length, 0);

  // Новый LOSE с более поздней датой не должен перезаписать незавершённую
  // legacy-очередь с наблюдениями по предыдущей сделке.
  const later = '2026-11-05T00:00:00Z';
  await db.query(`INSERT INTO lost_audio_wait (deal_id,lose_date,state,first_seen_at,deadline_at,next_check_at,pending_calls,observations,silent,screenshots)
    VALUES (44,$1,'waiting',$1,$1,$1,'["77"]'::jsonb,'{"77":{"activity_id":"77"}}'::jsonb,false,true)`, [date]);
  d = deps();
  await d.queue.enqueue({ requestKey: 'bitrix24:deal-stage-history:202', dealId: 44, loseDate: later, triggerType: 'live' });
  job = await d.queue.claim();
  assert.equal(Number(job.deal_id), 44);
  const priorFetch = fetchCalls;
  assert.deepEqual(await runJob({ ...d, job, processOptions, delivery }), { status: 'needs_review', reason: 'audio_origin_missing' });
  assert.equal(fetchCalls, priorFetch);
  const savedLegacy = (await db.query('SELECT state,lose_date,origin_stage_history_id,pending_calls,observations FROM lost_audio_wait WHERE deal_id=44')).rows[0];
  assert.equal(savedLegacy.state, 'waiting');
  assert.equal(savedLegacy.origin_stage_history_id, null);
  assert.equal(new Date(savedLegacy.lose_date).toISOString(), new Date(date).toISOString());
  assert.deepEqual(savedLegacy.pending_calls, ['77']);
  assert.deepEqual(savedLegacy.observations, { 77: { activity_id: '77' } });

  // Тот же запрет проверяется в SQL даже если вызывающий код ошибся и
  // попытался сохранить новый результат в обход проверки runJob.
  await db.query(`INSERT INTO lost_audio_wait (deal_id,lose_date,state,first_seen_at,deadline_at,next_check_at,pending_calls,observations,silent,screenshots)
    VALUES (45,$1,'waiting',$1,$1,$1,'["77"]'::jsonb,'{"77":{"activity_id":"77"}}'::jsonb,false,true)`, [date]);
  const laterOperation = randomUUID(), laterLease = randomUUID();
  await db.query(`INSERT INTO lost_processing_jobs (id,request_key,deal_id,lose_date,trigger_type,status,lease_token,lease_until)
    VALUES ($1,$2,45,$3,'manual','processing',$4,now()+interval '1 hour')`, [laterOperation, `manual:${laterOperation}`, later, laterLease]);
  await assert.rejects(persistResult(pool, { operation_id: laterOperation, lease_token: laterLease, deal_id: 45,
    _status: 'waiting_audio', audio_wait: { lose_date: later, first_seen_at: later, deadline_at: later,
      next_check_at: later, pending_calls: ['88'], observations: { 88: { activity_id: '88' } }, origin_stage_history_id: '202' } }));
  const protectedLegacy = (await db.query('SELECT state,lose_date,origin_stage_history_id,pending_calls,observations FROM lost_audio_wait WHERE deal_id=45')).rows[0];
  assert.equal(protectedLegacy.state, 'waiting');
  assert.equal(protectedLegacy.origin_stage_history_id, null);
  assert.equal(new Date(protectedLegacy.lose_date).toISOString(), new Date(date).toISOString());
  assert.deepEqual(protectedLegacy.pending_calls, ['77']);
  assert.deepEqual(protectedLegacy.observations, { 77: { activity_id: '77' } });
});

test('миграция аудио атомарно откатывается и не заполняет старые данные предположением', { skip: !existsSync(path) }, async t => {
  const { PGlite } = await import(pathToFileURL(path).href);
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8'));
  const migration = readFileSync('supabase/migrations/20261106031734_lost_audio_wait_origins.sql', 'utf8');
  await db.exec(`BEGIN; ${migration} ROLLBACK;`);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='lost_audio_wait' AND column_name='origin_stage_history_id'")).rows[0].n, 0);
  await db.exec(migration);
  await db.query(`INSERT INTO lost_audio_wait (deal_id,lose_date,state,first_seen_at,deadline_at,next_check_at,pending_calls,observations)
    VALUES (1,$1,'waiting',$1,$1,$1,'[]'::jsonb,'{}'::jsonb)`, [date]);
  assert.equal((await db.query('SELECT origin_stage_history_id FROM lost_audio_wait WHERE deal_id=1')).rows[0].origin_stage_history_id, null);
  await assert.rejects(db.query("UPDATE lost_audio_wait SET origin_stage_history_id='invalid' WHERE deal_id=1"));
});

test('ночной повтор после ошибки события не обходит проверку неоднозначной истории', async () => {
  let communications = 0, llm = 0, deliveries = 0;
  const bitrix = { async request(method) {
    if (method === 'crm.deal.userfield.list') return { result: [{ LIST: [{ ID: '1', VALUE: 'Другая' }] }] };
    if (method === 'crm.deal.get') return { result: { ID: '42', STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: '65', UF_CRM_1584703948317: '1' } };
    if (method === 'crm.stagehistory.list') return { result: { items: [{ ID: '102', STAGE_ID: 'C23:LOSE', CREATED_TIME: date }, orig] }, total: 2 };
    communications++;
    throw new Error('Сбор общения при неоднозначной истории запрещён');
  } };
  const outcomes = [];
  for (const [trigger_type, request_key] of [['live', 'bitrix24:deal-stage-history:101'], ['nightly', 'nightly:42:2026-11-05']]) {
    const job = { id: randomUUID(), lease_token: randomUUID(), deal_id: 42, lose_date: date, trigger_type, request_key };
    const queue = { async renew() { return true; }, async finishObsoleteNightly() { return false; } };
    const store = { async loadResumableResult() { return null; }, async persistResult(result) { outcomes.push(result); return { status: result._status, needsExternalActions: false }; } };
    const result = await runJob({ job, queue, store, loadAudioWait: async () => null,
      processOptions: { bitrix, nowMs: Date.parse('2026-11-05T00:00:00Z'), audioWaitEnabledAt: '2026-11-01T00:00:00Z',
        wait: async () => {}, judgeSystemPrompt: 'Промпт', llm: { async complete() { llm++; } } },
      delivery: async () => { deliveries++; } });
    assert.equal(result.status, 'error');
  }
  assert.deepEqual(outcomes.map(x => x._status), ['error', 'error']);
  assert.equal(communications, 0);
  assert.equal(llm, 0);
  assert.equal(deliveries, 0);
});
