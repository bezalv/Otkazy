import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { getCACertificates, rootCertificates } from 'node:tls';
import { readMainConfig, createMainHandler, startMain } from '../../app/src/main.mjs';

const valid = {
  OTKAZY_MODE: 'active', TZ: 'UTC', PORT: '3000', HOST: '127.0.0.1',
  DATABASE_URL: 'postgresql://fixture:fixture-password@db.example.invalid:5432/postgres?sslmode=require',
  BITRIX_REST_BASE: 'https://example.bitrix24.ru/rest/1/fixture/', BITRIX_DOMAIN: 'example.bitrix24.ru',
  POLZA_API_KEY: 'fixture-polza', BITRIX_EVENT_TOKEN: 'fixture-event', BITRIX_MEMBER_ID: 'fixture-member',
  LIVE_ENABLED_AT: '2026-11-05T00:00:00Z',
};
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
class FakeServer extends EventEmitter {
  constructor(handler) { super(); this.handler = handler; this.closeCount = 0; }
  listen(port, host, callback) { this.port = port; this.host = host; queueMicrotask(callback); }
  close(callback) { this.closeCount++; queueMicrotask(callback); }
  closeIdleConnections() {}
}
class Response {
  constructor() { this.headers = {}; this.headersSent = false; this.destroyed = false; }
  setHeader(name, value) { this.headers[name] = value; }
  writeHead(status) { this.statusCode = status; this.headersSent = true; }
  end(body) { this.body = body || ''; }
}
function request(handler, url, method = 'GET') {
  const res = new Response();
  handler({ url, method, resume() {} }, res);
  return res;
}

test('по умолчанию только диагностика, без пула и обработчика webhook', async () => {
  const processRef = new EventEmitter();
  let calledPool = false, calledApplication = false;
  const result = await startMain({ env: {}, processRef,
    makePool() { calledPool = true; }, makeApplication() { calledApplication = true; },
    makeServer: handler => new FakeServer(handler), logger: { error() {} },
  });
  assert.equal(result.mode, 'setup');
  assert.equal(calledPool, false);
  assert.equal(calledApplication, false);
  assert.equal(request(result.server.handler, '/health').statusCode, 200);
  assert.equal(request(result.server.handler, '/ready').statusCode, 503);
  assert.equal(request(result.server.handler, '/webhooks/bitrix', 'POST').statusCode, 404);
  assert.deepEqual(await result.stop(), { status: 'drained' });
});

test('ошибочная конфигурация не создаёт пул, сервер или приложение', async () => {
  let resources = 0;
  await assert.rejects(startMain({ env: { ...valid, BITRIX_EVENT_TOKEN: '' },
    makePool() { resources++; }, makeApplication() { resources++; }, makeServer() { resources++; },
  }), error => /BITRIX_EVENT_TOKEN/.test(error.message) && !error.message.includes('fixture-polza'));
  assert.equal(resources, 0);
  assert.throws(() => readMainConfig({ ...valid, TZ: 'Asia/Novosibirsk' }), /TZ/);
  assert.throws(() => readMainConfig({ ...valid, LIVE_ENABLED_AT: '2026-11-05T00:00:00.000500Z' }), /LIVE_ENABLED_AT/);
  assert.doesNotThrow(() => readMainConfig({ ...valid, LIVE_ENABLED_AT: '2026-11-05T00:00:00.000000Z' }));
  assert.throws(() => readMainConfig({ ...valid, DATABASE_URL: valid.DATABASE_URL.replace('sslmode=require', 'sslmode=disable') }), /DATABASE_URL/);
  assert.throws(() => readMainConfig({ ...valid, BITRIX_DOMAIN: 'other.bitrix24.ru' }), /BITRIX_REST_BASE/);
  assert.throws(() => readMainConfig({ ...valid, DATABASE_URL: 'postgresql://user:password@aws-0-us.pooler.supabase.com:6543/db' }), /5432/);
  assert.throws(() => readMainConfig({ ...valid, DATABASE_URL: 'postgresql://user:password@aws-0-us.pooler.supabase.com.:6543/db' }), /DATABASE_URL/);
  assert.doesNotThrow(() => readMainConfig({ ...valid, DATABASE_URL: 'postgresql://user:password@aws-0-us.pooler.supabase.com:5432/db' }));
});

test('режим пилота не требует событийного токена и не открывает webhook', () => {
  const config=readMainConfig({...valid,OTKAZY_MODE:'pilot',BITRIX_EVENT_TOKEN:'',BITRIX_MEMBER_ID:''});
  assert.equal(config.mode,'pilot');assert.equal(config.applicationToken,undefined);
  const handler=createMainHandler({mode:'pilot',application:{getReadiness:()=>({ready:true})},isStarted:()=>true});
  assert.equal(request(handler,'/ready').statusCode,200);
  assert.equal(request(handler,'/webhooks/bitrix','POST').statusCode,404);
});

test('подменённый сертификат не позволяет создать пул и не раскрывает ошибку чтения', async () => {
  let created = 0;
  for (const readCertificate of [() => rootCertificates[0], () => { throw new Error('fixture-secret'); }]) {
    await assert.rejects(startMain({ env: valid, readCertificate, makePool() { created++; } }),
      error => !error.message.includes('fixture-secret'));
  }
  assert.equal(created, 0);
});

test('активный режим принудительно проверяет сертификат и открывает только нужный маршрут', async () => {
  const processRef = new EventEmitter();
  const pool = { async connect() { throw new Error('unexpected'); }, async end() { this.ended = true; } };
  let poolConfig, appOptions, started = false, live = 0;
  const application = {
    async start() { started = true; return { status: 'running' }; },
    async stop() { return { status: 'drained' }; },
    getStatus() { return 'running'; },
    getReadiness() { return { ready: true, status: 'ready' }; },
    handleLive(req, res) { live++; res.writeHead(204); res.end(); },
  };
  const result = await startMain({ env: valid, processRef,
    readCertificate: (...args) => readFileSync(...args) + rootCertificates[0],
    makePool(config) { poolConfig = config; return pool; },
    makeApplication(options) { appOptions = options; return application; },
    makeServer: handler => new FakeServer(handler), logger: { error() {} },
  });
  assert.equal(started, true);
  assert.equal(poolConfig.ssl.rejectUnauthorized, true);
  assert.deepEqual(poolConfig.ssl.ca.slice(0, -1), getCACertificates('default'));
  const certificate = new X509Certificate(poolConfig.ssl.ca.at(-1));
  assert.equal(certificate.ca, true);
  assert.equal(poolConfig.ssl.ca.at(-1), certificate.toString());
  assert.equal((poolConfig.ssl.ca.at(-1).match(/BEGIN CERTIFICATE/g) || []).length, 1);
  assert.equal(certificate.fingerprint256.replaceAll(':', ''), '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA');
  assert.equal('checkServerIdentity' in poolConfig.ssl, false);
  assert.equal(poolConfig.max, 2);
  assert.equal(new URL(poolConfig.connectionString).search, '');
  assert.equal(poolConfig.statement_timeout, 30000);
  assert.equal(poolConfig.lock_timeout, 10000);
  assert.equal(poolConfig.idle_in_transaction_session_timeout, 120000);
  assert.equal(poolConfig.keepAlive, true);
  assert.equal(poolConfig.keepAliveInitialDelayMillis, 30000);
  assert.equal('query_timeout' in poolConfig, false);
  // Проверяем именно установленный драйвер без соединения с PostgreSQL:
  // значение должно попасть в startup packet, а keepalive — в TCP-конфигурацию.
  const { Client } = createRequire(new URL('../../app/package.json', import.meta.url))('pg');
  const client = new Client(poolConfig);
  const startup = client.getStartupConf();
  assert.equal(startup.statement_timeout, '30000');
  assert.equal(startup.lock_timeout, '10000');
  assert.equal(startup.idle_in_transaction_session_timeout, '120000');
  assert.equal(client.connection._keepAlive, true);
  assert.equal(client.connection._keepAliveInitialDelayMillis, 30000);
  assert.equal(appOptions.applicationToken, 'fixture-event');
  assert.notEqual(appOptions.pool, pool);
  assert.equal(typeof appOptions.pool.query, 'function');
  assert.equal(request(result.server.handler, '/ready').statusCode, 200);
  assert.equal(request(result.server.handler, '/webhooks/bitrix', 'POST').statusCode, 204);
  assert.equal(live, 1);
  assert.equal(request(result.server.handler, '/webhooks/other', 'POST').statusCode, 404);
  await result.stop();
  assert.equal(pool.ended, true);
  assert.equal(processRef.listenerCount('SIGTERM'), 0);
});

test('активное приложение использует проверенную сессию через ограниченный пул', async () => {
  const calls = [], pool = new EventEmitter();
  let releases = 0, ended = false;
  const client = Object.assign(new EventEmitter(), {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('current_setting(')) return { rows: [{ statement_timeout: '30s', lock_timeout: '10s', idle_in_transaction_session_timeout: '2min' }] };
      return { rows: [] };
    },
    release(error) { assert.equal(error, undefined); releases++; },
  });
  pool.connect = async () => client;
  pool.end = async () => { ended = true; };
  const result = await startMain({ env: valid, processRef: new EventEmitter(), makePool: () => pool,
    makeApplication: ({ pool: db }) => ({
      async start() { await db.query('SELECT fixture'); return { status: 'running' }; },
      async stop() { return { status: 'drained' }; },
    }),
    makeServer: handler => new FakeServer(handler), logger: { error() {} },
  });
  assert.equal(calls.length, 5);
  assert.match(calls[3], /current_setting/);
  assert.equal(calls[4], 'SELECT fixture');
  assert.equal(releases, 1);
  await result.stop();
  assert.equal(ended, true);
});

test('SIGTERM при инициализации базы не запускает последующие SET и запрос приложения', async () => {
  const processRef = new EventEmitter(), entered = deferred(), pending = deferred(), pool = new EventEmitter(), calls = [];
  let releaseError, ended = false;
  const client = Object.assign(new EventEmitter(), {
    query(sql) { calls.push(sql); entered.resolve(); return pending.promise; },
    release(error) { releaseError = error; },
  });
  pool.connect = async () => client;
  pool.end = async () => { ended = true; };
  const starting = startMain({ env: valid, processRef, makePool: () => pool,
    makeApplication: ({ pool: db }) => {
      let work;
      return {
        start() { work = db.query('SELECT fixture'); return work; },
        async stop() { await work?.catch(() => {}); return { status: 'drained' }; },
      };
    },
    makeServer: handler => new FakeServer(handler), logger: { error() {} },
  });
  const failed = assert.rejects(starting);
  await entered.promise;
  processRef.emit('SIGTERM');
  await failed;
  pending.resolve({ rows: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["SET statement_timeout = '30s'"]);
  assert.equal(releaseError.code, 'DB_STARTUP_CANCELLED');
  assert.equal(ended, true);
});

test('SIGTERM прерывает зависший стартовый SELECT после установки сессии', async () => {
  const processRef = new EventEmitter(), entered = deferred(), pending = deferred(), pool = new EventEmitter(), calls = [];
  let releaseError, ended = false;
  const client = Object.assign(new EventEmitter(), {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('current_setting(')) return { rows: [{ statement_timeout: '30s', lock_timeout: '10s', idle_in_transaction_session_timeout: '2min' }] };
      if (sql === 'SELECT fixture') { entered.resolve(); return pending.promise; }
      return { rows: [] };
    },
    release(error) { releaseError = error; },
  });
  pool.connect = async () => client;
  pool.end = async () => { ended = true; };
  const starting = startMain({ env: valid, processRef, makePool: () => pool,
    makeApplication: ({ pool: db }) => {
      let work;
      return { start() { work = db.query('SELECT fixture'); return work; },
        async stop() { await work?.catch(() => {}); return { status: 'drained' }; } };
    }, makeServer: handler => new FakeServer(handler), logger: { error() {} },
  });
  const failed = assert.rejects(starting);
  await entered.promise;
  processRef.emit('SIGTERM');
  await failed;
  assert.equal(releaseError.code, 'DB_STARTUP_CANCELLED');
  assert.equal(ended, true);
  assert.equal(calls.length, 5);
  pending.resolve({ rows: [] });
});

test('обычная остановка ждёт выполняющийся COMMIT, не отменяя его', async () => {
  const pending = deferred(), pool = new EventEmitter();
  let db, releaseError, work;
  const client = Object.assign(new EventEmitter(), {
    async query(sql) {
      if (sql.includes('current_setting(')) return { rows: [{ statement_timeout: '30s', lock_timeout: '10s', idle_in_transaction_session_timeout: '2min' }] };
      if (sql === 'COMMIT') return pending.promise;
      return { rows: [] };
    }, release(error) { releaseError = error; },
  });
  pool.connect = async () => client;
  pool.end = async () => {};
  const result = await startMain({ env: valid, processRef: new EventEmitter(), makePool: () => pool,
    makeApplication: ({ pool: wrapped }) => {
      db = wrapped;
      return { async start() { return { status: 'running' }; },
        async stop() { await work; return { status: 'drained' }; } };
    }, makeServer: handler => new FakeServer(handler), logger: { error() {} },
  });
  const connection = await db.connect();
  work = connection.query('COMMIT');
  assert.deepEqual(await result.stop({ graceMs: 10 }), { status: 'timeout' });
  assert.equal(releaseError, undefined);
  pending.resolve({ rows: [] });
  await work;
  connection.release();
  assert.deepEqual(await result.stop({ graceMs: 1000 }), { status: 'drained' });
  assert.equal(releaseError, undefined);
});

test('неизвестная готовность не отображается успешной и не раскрывает детали', () => {
  const handler = createMainHandler({ mode: 'active', application: { getReadiness() { throw new Error('fixture-secret'); } } });
  const res = request(handler, '/ready');
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(res.body, /fixture-secret/);
});

test('health закрыт до старта и остаётся живым при деградации STT', async () => {
  const startup = deferred(), serverCreated = deferred();
  let server;
  const application = {
    async start() { return startup.promise; }, async stop() { return { status: 'drained' }; },
    getStatus() { return 'running'; },
    getReadiness() { return { ready: false, checks: { stt: 'unavailable' } }; },
    handleLive(req, res) { res.writeHead(204); res.end(); },
  };
  const started = startMain({ env: valid, processRef: new EventEmitter(), makePool: () => ({ async connect() {}, async end() {} }),
    makeApplication: () => application, makeServer: handler => { server = new FakeServer(handler); serverCreated.resolve(); return server; },
    logger: { error() {} },
  });
  await serverCreated.promise;
  assert.equal(request(server.handler, '/health').statusCode, 503);
  assert.equal(request(server.handler, '/webhooks/bitrix', 'POST').statusCode, 503);
  startup.resolve({ status: 'running' });
  const result = await started;
  assert.equal(request(server.handler, '/health').statusCode, 200);
  assert.equal(request(server.handler, '/ready').statusCode, 503);
  assert.equal(request(server.handler, '/webhooks/bitrix', 'POST').statusCode, 204);
  await result.stop();
});

test('ready показывает только разрешённые проверки и статусы', () => {
  const handler = createMainHandler({ mode: 'active', isStarted: () => true, application: {
    getReadiness() { return { ready: false, status: 'fixture-secret', extra: 'fixture-secret', checks: {
      inbox: 'error', worker: 'checking', nightly: 'ok', stt: 'unavailable', delivery_review: 'needs_review',
      database: 'error', database_retry: 'checking', database_delivery: 'ok',
      secret: 'fixture-secret', injected: 'ok',
    } }; },
  } });
  const response = request(handler, '/ready');
  assert.deepEqual(JSON.parse(response.body).checks, { inbox: 'error', worker: 'checking', nightly: 'ok',
    stt: 'unavailable', delivery_review: 'needs_review', database: 'error', database_retry: 'checking', database_delivery: 'ok' });
  assert.doesNotMatch(response.body, /fixture-secret|injected/);
  const unsafe = createMainHandler({ mode: 'active', isStarted: () => true, application: {
    getReadiness() { return { ready: false, checks: { inbox: 'fixture-secret', stt: { message: 'fixture-secret' } } }; },
  } });
  const unsafeBody = request(unsafe, '/ready').body;
  assert.deepEqual(JSON.parse(unsafeBody).checks, {});
  assert.doesNotMatch(unsafeBody, /fixture-secret/);
});

test('ошибка свободного соединения пула безопасно останавливает приложение', async () => {
  const pending = deferred(), processRef = new EventEmitter(), pool = new EventEmitter(), logs = [];
  let stops = 0, closes = 0;
  pool.connect = async () => { throw new Error('unexpected'); };
  pool.end = async () => { closes++; };
  const application = {
    async start() { return { status: 'running' }; }, async stop() { stops++; return pending.promise; },
    getStatus() { return 'running'; }, getReadiness() { return { ready: true }; },
  };
  const result = await startMain({ env: valid, processRef, makePool: () => pool,
    makeApplication: () => application, makeServer: handler => new FakeServer(handler), logger: { error(value) { logs.push(value); } },
  });
  pool.emit('error', new Error('fixture-secret'));
  pool.emit('error', new Error('fixture-secret'));
  assert.equal(processRef.exitCode, 1);
  assert.equal(stops, 1);
  assert.equal(closes, 0);
  assert.equal(request(result.server.handler, '/health').statusCode, 503);
  assert.equal(request(result.server.handler, '/webhooks/bitrix', 'POST').statusCode, 503);
  assert.doesNotMatch(logs.join(' '), /fixture-secret/);
  pending.resolve({ status: 'drained' });
  assert.deepEqual(await result.stop({ graceMs: 1000 }), { status: 'drained' });
  assert.equal(result.server.closeCount, 1);
  assert.equal(closes, 1);
});

test('ошибка пула во время listen не оставляет слушающий сервер', async () => {
  const processRef = new EventEmitter(), pool = new EventEmitter(), startListen = deferred(), finishListen = deferred();
  let server, closes = 0;
  pool.connect = async () => { throw new Error('unexpected'); };
  pool.end = async () => { closes++; };
  class DelayedServer extends FakeServer {
    listen(port, host, callback) { startListen.resolve(); finishListen.promise.then(callback); }
  }
  const application = { async start() { assert.fail('запуск после ошибки пула'); },
    async stop() { return { status: 'drained' }; } };
  const started = startMain({ env: valid, processRef, makePool: () => pool, makeApplication: () => application,
    makeServer: handler => { server = new DelayedServer(handler); return server; }, logger: { error() {} },
  });
  await startListen.promise;
  pool.emit('error', new Error('fixture-secret'));
  finishListen.resolve();
  await assert.rejects(started, error => !error.message.includes('fixture-secret'));
  assert.equal(server.closeCount, 1);
  assert.equal(closes, 1);
  assert.equal(processRef.exitCode, 1);
});

test('ошибка HTTP-сервера останавливает приложение и закрывает пул только после drain', async () => {
  const pending = deferred(), processRef = new EventEmitter();
  let stops = 0, closes = 0;
  const application = {
    async start() { return { status: 'running' }; }, async stop() { stops++; return pending.promise; },
    getStatus() { return 'running'; }, getReadiness() { return { ready: true }; },
  };
  const result = await startMain({ env: valid, processRef, makePool: () => ({ async connect() {}, async end() { closes++; } }),
    makeApplication: () => application, makeServer: handler => new FakeServer(handler), logger: { error() {} },
  });
  result.server.emit('error', new Error('fixture-secret'));
  result.server.emit('error', new Error('fixture-secret'));
  assert.equal(processRef.exitCode, 1);
  assert.equal(stops, 1);
  assert.equal(closes, 0);
  assert.equal(request(result.server.handler, '/health').statusCode, 503);
  assert.equal(request(result.server.handler, '/webhooks/bitrix', 'POST').statusCode, 503);
  pending.resolve({ status: 'drained' });
  assert.deepEqual(await result.stop({ graceMs: 1000 }), { status: 'drained' });
  assert.equal(result.server.closeCount, 1);
  assert.equal(closes, 1);
});

test('таймаут остановки запрещает webhook и сохраняет пул до завершения работы', async () => {
  const pending = deferred();
  const pool = { async connect() {}, async end() { this.ended = true; } };
  const application = {
    async start() { return { status: 'running' }; },
    async stop() { return pending.promise; },
    getStatus() { return 'running'; }, getReadiness() { return { ready: true }; },
    handleLive() { assert.fail('новый запрос во время остановки'); },
  };
  const result = await startMain({ env: valid, processRef: new EventEmitter(), makePool: () => pool,
    makeApplication: () => application, makeServer: handler => new FakeServer(handler), logger: { error() {} },
  });
  assert.deepEqual(await result.stop({ graceMs: 10 }), { status: 'timeout' });
  assert.equal(pool.ended, undefined);
  assert.equal(request(result.server.handler, '/webhooks/bitrix', 'POST').statusCode, 503);
  assert.equal(request(result.server.handler, '/ready').statusCode, 503);
  pending.resolve({ status: 'drained' });
  assert.deepEqual(await result.stop({ graceMs: 1000 }), { status: 'drained' });
  assert.equal(pool.ended, true);
});

test('ошибка подготовки приложения не выводит содержимое секрета и закрывает ресурсы', async () => {
  const processRef = new EventEmitter();
  let ended = false;
  const application = {
    async start() { throw new Error('fixture-secret'); },
    async stop() { return { status: 'drained' }; },
  };
  await assert.rejects(startMain({ env: valid, processRef,
    makePool: () => ({ async connect() {}, async end() { ended = true; } }), makeApplication: () => application,
    makeServer: handler => new FakeServer(handler), logger: { error() {} },
  }), error => !error.message.includes('fixture-secret'));
  assert.equal(ended, true);
  assert.equal(processRef.listenerCount('SIGTERM'), 0);
});
