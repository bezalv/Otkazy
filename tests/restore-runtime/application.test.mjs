import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication, assertAudioOriginSchema } from '../../app/src/application.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('пилот запускает опрос и worker без webhook и ночного повтора',async()=>{
  const calls=[];const timers=fakeTimers();const at='2026-11-05T00:00:00.000Z';let settings;
  const app=createApplication({pool:{async query(){return {rows:[{matches:true}]};}},pilotMode:true,liveEnabledAt:at,
    bitrixBaseUrl:'fixture',polzaKey:'fixture',intervals:{inbox:1000,worker:1000,nightly:1000}}, {
    timers,inspectAudioOriginSchema:async()=>{},createBitrixClient:()=>({}),
    createLiveInbox:()=>{throw Error('webhook forbidden');},createLiveHttpHandler:()=>{throw Error('webhook forbidden');},
    inspectInbox:async()=>false,inspectDelivery:async()=>false,
    prepareRuntime:async x=>{settings=x;return {pollPilot:async()=>{calls.push('poll');return {queued:0};},
      tick:async()=>{calls.push('worker');},nightly:async()=>{calls.push('nightly');},close:async()=>({status:'drained'})};},
  });
  await app.start();assert.equal(settings.deliveryMode,'pilot65');assert.equal(settings.pilotEnabledAt,at);
  for(const [id,timer] of [...timers.pending])if(timer.ms===0)timers.fire(id);
  await flush();await flush();assert.ok(calls.includes('poll'));assert.ok(calls.includes('worker'));assert.ok(!calls.includes('nightly'));
  await app.stop();
});
function fakeTimers() {
  let next = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, ms) { const id = ++next; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    fire(id) { const item = pending.get(id); assert.ok(item); pending.delete(id); item.fn(); },
  };
}
class Response extends EventEmitter {
  constructor() { super(); this.headersSent = false; this.destroyed = false; this.headers = {}; }
  setHeader(name, value) { this.headers[name] = value; }
  writeHead(status) { this.statusCode = status; this.headersSent = true; }
  end() { this.emit('finish'); }
}
function fixture(overrides = {}) {
  const calls = [];
  const timers = fakeTimers();
  const inbox = {
    async assertConfig() { calls.push('config'); },
    async recoverExpired() { calls.push('recover'); },
    async claim() { calls.push('claim'); return null; },
    async retry() { calls.push('retry'); return true; },
    async acceptForm() { calls.push('accept'); return { status: 'accepted' }; },
    ...overrides.inbox,
  };
  const runtime = {
    async tick() { calls.push('worker'); },
    async nightly() { calls.push('nightly'); },
    async close() { calls.push('close'); return { status: 'drained' }; },
    ...overrides.runtime,
  };
  const dependencies = {
    timers,
    async inspectAudioOriginSchema() {},
    createLiveInbox() { calls.push('inbox'); return inbox; },
    createBitrixClient() { calls.push('bitrix'); return {}; },
    async prepareRuntime() { calls.push('runtime'); return runtime; },
    createLiveHttpHandler({ inbox: tracked }) {
      return (req, res) => {
        tracked.acceptForm(Buffer.from('fixture')).then(() => { res.writeHead(204); res.end(); }, () => { res.writeHead(503); res.end(); });
      };
    },
    async processLiveEvent() { calls.push('process'); return { status: 'queued' }; },
    async inspectInbox() { return false; },
    async inspectDelivery() { return false; },
    ...overrides.dependencies,
  };
  const options = { pool: {}, bitrixBaseUrl: 'fixture', polzaKey: 'secret-polza', applicationToken: 'secret-event',
    domain: 'example.invalid', memberId: 'member', liveEnabledAt: '2026-11-05T00:00:00Z',
    intervals: { inbox: 10, worker: 10, nightly: 10 }, ...overrides.options };
  return { application: createApplication(options, dependencies), calls, timers, inbox, runtime };
}

test('клиенты событий и обработки используют один ограничитель до завершения runtime', async () => {
  const limiter = { closed: false, close() { this.closed = true; } };
  let liveLimiter, workerLimiter;
  const { application } = fixture({
    runtime: { async close() { assert.equal(limiter.closed, false); return { status: 'drained' }; } },
    dependencies: {
      createBitrixLimiter: () => limiter,
      createBitrixClient: ({ limiter: value }) => { liveLimiter = value; return {}; },
      prepareRuntime: async ({ bitrixLimiter }) => {
        workerLimiter = bitrixLimiter;
        return { tick: async () => {}, nightly: async () => {}, close: async () => {
          assert.equal(limiter.closed, false); return { status: 'drained' };
        } };
      },
    },
  });
  await application.start();
  assert.equal(liveLimiter, limiter);
  assert.equal(workerLimiter, limiter);
  await application.stop();
  assert.equal(limiter.closed, true);
});

test('конструктор бездействует; cutoff проверяется до запуска сервиса и таймеров', async () => {
  const { application, calls, timers } = fixture();
  assert.deepEqual(calls, []);
  assert.equal(timers.pending.size, 0);
  const response = new Response();
  application.handleLive({ resume() {} }, response);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(await application.start(), { status: 'running' });
  assert.deepEqual(calls, ['inbox', 'config', 'bitrix', 'runtime']);
  assert.equal(timers.pending.size, 4);
  assert.deepEqual(await application.stop(), { status: 'drained' });
  assert.equal(timers.pending.size, 0);
});

test('несовпадающий cutoff не запускает STT и не открывает обработчик', async () => {
  const { application, calls, timers } = fixture({ inbox: { async assertConfig() { throw new Error('secret-event'); } } });
  await assert.rejects(application.start(), error => !String(error).includes('secret-event'));
  assert.deepEqual(calls, ['inbox']);
  assert.equal(timers.pending.size, 0);
  assert.equal(application.getStatus(), 'failed');
});

test('отсутствующая схема останавливает active до настройки приёма и запуска runtime', async () => {
  const { application, calls, timers } = fixture({ dependencies: { async inspectAudioOriginSchema() { throw new Error('schema-secret'); } } });
  await assert.rejects(application.start(), error => !String(error).includes('schema-secret'));
  assert.deepEqual(calls, []);
  assert.equal(timers.pending.size, 0);
  assert.equal(application.getStatus(), 'failed');
  const response = new Response();
  application.handleLive({ resume() {} }, response);
  assert.equal(response.statusCode, 503);
});

test('варианты форматирования CHECK допустимы, ослабленное ограничение нет', async () => {
  const valid = [
    "CHECK (((origin_stage_history_id IS NULL) OR (origin_stage_history_id ~ '^[1-9][0-9]{0,29}$'::text)))",
    "CHECK ((origin_stage_history_id IS NULL) OR (origin_stage_history_id ~ '^[1-9][0-9]{0,29}$'))",
    "CHECK ((origin_stage_history_id IS NULL) OR (origin_stage_history_id ~ '^[1-9][0-9]{0,29}$'::pg_catalog.text))",
  ];
  for (const value of valid) await assertAudioOriginSchema({ async query() { return { rows: [{ check_definition: value }] }; } });
  for (const value of [null, "CHECK (origin_stage_history_id IS NULL OR true)",
    "CHECK (origin_stage_history_id IS NULL OR origin_stage_history_id ~ '.*'::text)",
    "CHECK (origin_stage_history_id IS NULL OR origin_stage_history_id ~ '^[1-9] [0-9]{0,29}$'::text)",
    "CHECK (origin_stage_history_id IS NULL OR origin_stage_history_id ~ '^[1-9]([0-9]){0,29}$'::text)"]) {
    await assert.rejects(assertAudioOriginSchema({ async query() { return { rows: [{ check_definition: value }] }; } }));
  }
});

test('каждый цикл запускается отдельно и не пересекается с самим собой', async () => {
  const hold = deferred();
  const { application, timers, calls } = fixture({ runtime: { async tick() { calls.push('worker'); await hold.promise; } } });
  await application.start();
  const [inboxTimer, workerTimer, nightlyTimer] = [...timers.pending.keys()];
  timers.fire(workerTimer);
  await flush();
  assert.equal(calls.filter(value => value === 'worker').length, 1);
  assert.equal(timers.pending.has(inboxTimer), true);
  assert.equal(timers.pending.has(nightlyTimer), true);
  assert.equal(timers.pending.size, 3);
  hold.resolve();
  await flush();
  assert.equal(timers.pending.size, 4);
  await application.stop();
});

test('ошибки цикла не раскрывают секреты в сообщениях состояния', async () => {
  const events = [];
  const { application, timers } = fixture({ options: { onEvent: value => events.push(value) },
    runtime: { async tick() { throw new Error('secret-event'); } } });
  await application.start();
  timers.fire([...timers.pending.keys()][1]);
  await flush();
  assert.deepEqual(events, ['processing_degraded']);
  assert.equal(application.getReadiness().ready, false);
  assert.equal(application.getReadiness().checks.worker, 'error');
  timers.fire([...timers.pending.keys()].at(-1));
  await flush();
  assert.deepEqual(events, ['processing_degraded']);
  await application.stop();
});

test('STT деградация сигнализируется один раз, а webhook продолжает сохраняться', async () => {
  const events = [];
  let available = false;
  const { application, timers } = fixture({ options: { onEvent: value => events.push(value),
    intervals: { inbox: 11, worker: 12, nightly: 13, database: 14 } },
    runtime: {
      async tick() { return { status: available ? 'idle' : 'stt_unavailable' }; },
      async nightly() { return available ? { current: { status: 'not_due' } } : { status: 'stt_unavailable' }; },
    } });
  assert.equal(application.getReadiness().status, 'not_running');
  await application.start();
  assert.equal(application.getReadiness().status, 'checking');
  for (const id of [...timers.pending.keys()]) timers.fire(id);
  await flush();
  assert.equal(application.getReadiness().status, 'degraded');
  assert.equal(application.getReadiness().checks.stt, 'unavailable');
  assert.deepEqual(events, ['processing_degraded']);
  const response = new Response();
  application.handleLive({ resume() {} }, response);
  await flush();
  assert.equal(response.statusCode, 204);
  const timerFor = ms => [...timers.pending].find(([, item]) => item.ms === ms)?.[0];
  timers.fire(timerFor(12));
  await flush();
  assert.deepEqual(events, ['processing_degraded']);
  available = true;
  timers.fire(timerFor(12));
  timers.fire(timerFor(13));
  await flush();
  assert.equal(application.getReadiness().ready, true);
  assert.deepEqual(events, ['processing_degraded', 'processing_recovered']);
  await application.stop();
  assert.equal(application.getReadiness().status, 'not_running');
});

test('поздний успешный результат не скрывает более свежий сбой STT', async () => {
  const delayed = deferred();
  const events = [];
  const { application, timers } = fixture({ options: { onEvent: value => events.push(value) },
    runtime: { tick: () => delayed.promise, async nightly() { return { status: 'stt_unavailable' }; } } });
  await application.start();
  const [inboxTimer, workerTimer, nightlyTimer] = [...timers.pending.keys()];
  timers.fire(inboxTimer);
  timers.fire(workerTimer);
  await flush();
  timers.fire(nightlyTimer);
  await flush();
  assert.equal(application.getReadiness().checks.stt, 'unavailable');
  delayed.resolve({ status: 'idle' });
  await flush();
  assert.equal(application.getReadiness().checks.stt, 'unavailable');
  assert.deepEqual(events, ['processing_degraded']);
  await application.stop();
});

test('поздний сбой ранней проверки STT не скрывается более ранним успехом', async () => {
  const delayed = deferred();
  const events = [];
  const { application, timers } = fixture({ options: { onEvent: value => events.push(value),
    intervals: { inbox: 11, worker: 12, nightly: 13 } },
    runtime: { tick: () => delayed.promise, async nightly() { return { current: { status: 'not_due' } }; } } });
  await application.start();
  const [inboxTimer, workerTimer, nightlyTimer] = [...timers.pending.keys()];
  timers.fire(inboxTimer);
  timers.fire(workerTimer);
  await flush();
  timers.fire(nightlyTimer);
  await flush();
  assert.equal(application.getReadiness().checks.stt, 'ok');
  delayed.resolve({ status: 'stt_unavailable' });
  await flush();
  assert.equal(application.getReadiness().checks.stt, 'unavailable');
  assert.equal(application.getReadiness().status, 'degraded');
  assert.deepEqual(events, ['processing_degraded']);
  await application.stop();
});

test('пустой claim не скрывает сохранённое на повтор событие', async () => {
  let retryPending = true;
  const events = [];
  const { application, timers } = fixture({ options: { onEvent: event => events.push(event),
    intervals: { inbox: 11, worker: 12, nightly: 13, database: 14 } },
    dependencies: { async inspectInbox() { return retryPending; } } });
  await application.start();
  for (const id of [...timers.pending.keys()]) timers.fire(id);
  await flush();
  assert.equal(application.getReadiness().checks.inbox, 'error');
  assert.equal(application.getReadiness().status, 'degraded');
  assert.deepEqual(events, ['processing_degraded']);
  const inboxTimer = () => [...timers.pending].find(([, item]) => item.ms === 11)[0];
  timers.fire(inboxTimer());
  await flush();
  assert.equal(application.getReadiness().checks.inbox, 'error');
  assert.deepEqual(events, ['processing_degraded']);
  retryPending = false;
  timers.fire(inboxTimer());
  timers.fire([...timers.pending].find(([, item]) => item.ms === 14)[0]);
  await flush();
  assert.equal(application.getReadiness().ready, true);
  assert.deepEqual(events, ['processing_degraded', 'processing_recovered']);
  await application.stop();
});

test('результат retry сразу отражается в готовности', async () => {
  let first = true;
  const events = [];
  const { application, timers } = fixture({ options: { onEvent: event => events.push(event) },
    inbox: { async claim() { if (first) { first = false; return { id: 'fixture', lease_token: 'lease' }; } return null; } },
    dependencies: { async processLiveEvent() { return { status: 'retry' }; }, async inspectInbox() { return false; } } });
  await application.start();
  for (const id of [...timers.pending.keys()]) timers.fire(id);
  await flush();
  assert.equal(application.getReadiness().checks.inbox, 'error');
  assert.deepEqual(events, ['processing_degraded']);
  await application.stop();
});

test('неизвестная доставка отображается как needs_review без личных данных', async () => {
  let reviewPending = true;
  const events = [];
  const { application, timers } = fixture({ options: { onEvent: event => events.push(event),
    intervals: { inbox: 11, worker: 12, nightly: 13, database: 14 } },
    dependencies: { async inspectDelivery() { return reviewPending; } } });
  await application.start();
  for (const id of [...timers.pending.keys()]) timers.fire(id);
  await flush();
  assert.equal(application.getReadiness().checks.delivery_review, 'needs_review');
  assert.equal(application.getReadiness().status, 'degraded');
  assert.deepEqual(events, ['processing_degraded']);
  assert.doesNotMatch(JSON.stringify(application.getReadiness()), /secret|deal/i);
  reviewPending = false;
  const workerTimer = [...timers.pending].find(([, item]) => item.ms === 12)[0];
  timers.fire(workerTimer);
  timers.fire([...timers.pending].find(([, item]) => item.ms === 14)[0]);
  await flush();
  assert.equal(application.getReadiness().ready, true);
  assert.deepEqual(events, ['processing_degraded', 'processing_recovered']);
  await application.stop();
});

test('зависшая проверка БД снижает готовность без накопления запросов и без прерывания обработки', async () => {
  const stuck = deferred();
  const longWorker = deferred();
  const events = [];
  let hang = false, workerLong = false, probes = 0;
  const { application, timers } = fixture({
    options: { onEvent: event => events.push(event), databaseDeadlineMs: 9,
      intervals: { inbox: 11, worker: 12, nightly: 13, database: 14 } },
    dependencies: { async inspectInbox() { probes++; return hang ? stuck.promise : false; } },
    runtime: { tick() { return workerLong ? longWorker.promise : Promise.resolve({ status: 'idle' }); } },
  });
  const timerFor = ms => [...timers.pending].find(([, item]) => item.ms === ms)?.[0];
  await application.start();
  for (const id of [...timers.pending.keys()]) timers.fire(id);
  await flush();
  assert.equal(application.getReadiness().ready, true);
  workerLong = true;
  timers.fire(timerFor(12));
  hang = true;
  timers.fire(timerFor(14));
  await flush();
  const callsBeforeTimeout = probes;
  timers.fire(timerFor(9));
  assert.equal(application.getReadiness().checks.database, 'error');
  assert.deepEqual(events, ['processing_degraded']);
  for (let i = 0; i < 3; i++) timers.fire(timerFor(14));
  assert.equal(probes, callsBeforeTimeout);
  assert.deepEqual(events, ['processing_degraded']);
  const response = new Response();
  application.handleLive({ resume() {} }, response);
  await flush();
  assert.equal(response.statusCode, 204);
  hang = false;
  stuck.resolve(false);
  await flush();
  assert.equal(application.getReadiness().checks.database, 'error');
  timers.fire(timerFor(14));
  await flush();
  assert.equal(application.getReadiness().ready, true);
  assert.deepEqual(events, ['processing_degraded', 'processing_recovered']);
  longWorker.resolve({ status: 'idle' });
  await flush();
  await application.stop();
});

test('остановка не ждёт зависший только читающий монитор и не запускает его повторно', async () => {
  const stuck = deferred();
  let probes = 0;
  const { application, timers } = fixture({ options: { databaseDeadlineMs: 9 },
    dependencies: { inspectInbox() { probes++; return stuck.promise; } } });
  await application.start();
  const databaseTimer = [...timers.pending.keys()].at(-1);
  timers.fire(databaseTimer);
  await flush();
  assert.equal(probes, 1);
  assert.deepEqual(await application.stop({ graceMs: 100 }), { status: 'drained' });
  stuck.resolve(false);
  await flush();
  assert.equal(timers.pending.size, 0);
  assert.equal(probes, 1);
});

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
test('активный запуск проверяет колонку и валидированный CHECK в локальном PostgreSQL', { skip: !existsSync(pglitePath) }, async t => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  t.after(() => db.close());
  const check = () => assertAudioOriginSchema(db);
  await assert.rejects(check());
  await db.exec('CREATE TABLE public.lost_audio_wait (id integer)');
  await assert.rejects(check());
  await db.exec('ALTER TABLE public.lost_audio_wait ADD COLUMN origin_stage_history_id text');
  await assert.rejects(check());
  await db.exec('ALTER TABLE public.lost_audio_wait ADD CONSTRAINT lost_audio_wait_origin_stage_history_id_check CHECK (origin_stage_history_id IS NULL OR true)');
  await assert.rejects(check());
  await db.exec('ALTER TABLE public.lost_audio_wait DROP CONSTRAINT lost_audio_wait_origin_stage_history_id_check');
  await db.exec("ALTER TABLE public.lost_audio_wait ADD CONSTRAINT lost_audio_wait_origin_stage_history_id_check CHECK (origin_stage_history_id IS NULL OR origin_stage_history_id ~ '^[1-9][0-9]{0,29}$') NOT VALID");
  await assert.rejects(check());
  await db.exec('ALTER TABLE public.lost_audio_wait VALIDATE CONSTRAINT lost_audio_wait_origin_stage_history_id_check');
  await check();
  const { application } = fixture({ options: { pool: db }, dependencies: { inspectAudioOriginSchema: undefined } });
  assert.deepEqual(await application.start(), { status: 'running' });
  await application.stop();
});

test('готовность читает реальные состояния очередей в изолированной базе', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8'));
    await db.exec(readFileSync('db/proposals/worker-migration-fixtures/20261105052525_lost_processing_jobs.sql', 'utf8'));
    await db.exec(readFileSync('db/proposals/worker-migration-fixtures/20261105065540_lost_bitrix_events.sql', 'utf8'));
    await db.query(`INSERT INTO public.lost_bitrix_events (id,deal_id,attempts,status)
      VALUES ('00000000-0000-4000-8000-000000000001',42,1,'pending')`);
    await db.query(`INSERT INTO public.lost_processing_jobs (id,request_key,deal_id,lose_date,trigger_type,status)
      VALUES ('00000000-0000-4000-8000-000000000002','fixture',42,'2026-11-01T00:00:00Z','live','needs_review')`);
    const events = [];
    const { application, timers } = fixture({ options: { pool: db, onEvent: event => events.push(event),
      intervals: { inbox: 11, worker: 12, nightly: 13, database: 14 } },
      dependencies: { inspectInbox: undefined, inspectDelivery: undefined } });
    await application.start();
    for (const id of [...timers.pending.keys()]) timers.fire(id);
    // PGlite выполняет SQL асинхронно, поэтому ждём окончания обоих запросов.
    for (let i = 0; i < 100 && ['inbox', 'delivery_review', 'database'].some(key => application.getReadiness().checks[key] === 'checking'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(application.getReadiness().checks.inbox, 'error');
    assert.equal(application.getReadiness().checks.delivery_review, 'needs_review');
    assert.equal(application.getReadiness().status, 'degraded');
    await db.query("UPDATE public.lost_bitrix_events SET status='done',outcome='queued'");
    await db.query("UPDATE public.lost_processing_jobs SET status='done'");
    for (const [id, item] of [...timers.pending]) if ([11, 12, 14].includes(item.ms)) timers.fire(id);
    for (let i = 0; i < 100 && !application.getReadiness().ready; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(application.getReadiness().ready, true);
    assert.deepEqual(events, ['processing_degraded', 'processing_recovered']);
    await application.stop();
  } finally { await db.close(); }
});

test('остановка во время приёма webhook ждёт сохранения, после таймаута сообщает timeout', async () => {
  const insert = deferred();
  const { application, calls, timers } = fixture({ inbox: { acceptForm: () => insert.promise } });
  await application.start();
  const response = new Response();
  application.handleLive({ resume() {} }, response);
  const firstStop = await application.stop({ graceMs: 10 });
  assert.equal(firstStop.status, 'timeout');
  assert.equal(timers.pending.size, 0);
  assert.equal(calls.includes('close'), false);
  const rejected = new Response();
  application.handleLive({ resume() {} }, rejected);
  assert.equal(rejected.statusCode, 503);
  insert.resolve({ status: 'accepted' });
  await flush();
  assert.equal(response.statusCode, 204);
  assert.deepEqual(await application.stop({ graceMs: 1000 }), { status: 'drained' });
  assert.equal(calls.includes('close'), true);
});

test('остановка во время инициализации не включает таймеры и закрывает runtime', async () => {
  const starting = deferred();
  const { application, calls, timers, runtime } = fixture({ dependencies: { prepareRuntime: async () => starting.promise } });
  const start = application.start();
  await flush();
  const stopping = application.stop({ graceMs: 10 });
  assert.equal((await stopping).status, 'timeout');
  starting.resolve(runtime);
  assert.deepEqual(await start, { status: 'stopping' });
  assert.deepEqual(await application.stop({ graceMs: 1000 }), { status: 'drained' });
  assert.equal(calls.includes('close'), true);
  assert.equal(timers.pending.size, 0);
});

test('задание события, захваченное во время остановки, возвращается на повтор', async () => {
  const claim = deferred();
  const { application, calls, timers } = fixture({ inbox: { claim: () => claim.promise } });
  await application.start();
  timers.fire([...timers.pending.keys()][0]);
  await flush();
  const stopping = application.stop({ graceMs: 10 });
  assert.equal((await stopping).status, 'timeout');
  claim.resolve({ id: 'fixture', lease_token: 'lease' });
  assert.deepEqual(await application.stop({ graceMs: 1000 }), { status: 'drained' });
  assert.equal(calls.includes('retry'), true);
  assert.equal(calls.includes('process'), false);
});

test('таймер перед остановкой не запускает новую работу после остановки', async () => {
  const { application, calls, timers } = fixture();
  await application.start();
  timers.fire([...timers.pending.keys()][1]);
  const stopping = application.stop();
  assert.deepEqual(await stopping, { status: 'drained' });
  assert.equal(calls.includes('worker'), false);
});
