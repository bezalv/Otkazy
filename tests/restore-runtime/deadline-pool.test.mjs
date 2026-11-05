import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { createDeadlinePool } from '../../app/src/db/deadline-pool.mjs';
import { inTransaction } from '../../app/src/persistence/transaction.mjs';

const initValues = { statement_timeout: '30s', lock_timeout: '10s', idle_in_transaction_session_timeout: '2min' };
function makeClient(query, release) {
  return Object.assign(new EventEmitter(), {
    query: sql => {
      if (typeof sql === 'string' && sql.startsWith('SET ')) return Promise.resolve({ rows: [] });
      if (typeof sql === 'string' && sql.includes('current_setting(')) return Promise.resolve({ rows: [initValues] });
      return query(sql);
    }, release,
  });
}

test('SET и проверка выполняются один раз на каждую новую физическую сессию', async () => {
  const calls = [], releases = [];
  const makePhysical = id => Object.assign(new EventEmitter(), {
    async query(sql) {
      calls.push([id, sql]);
      if (sql.includes('current_setting(')) return { rows: [initValues] };
      return { rows: [] };
    },
    release(error) { releases.push(error); },
  });
  const first = makePhysical(1), second = makePhysical(2);
  const clients = [first, first, second];
  const pool = createDeadlinePool({ async connect() { return clients.shift(); }, async end() {} }, { queryTimeoutMs: 100 });
  await pool.query('SELECT fixture');
  await pool.query('SELECT fixture');
  await pool.query('SELECT fixture');
  for (const id of [1, 2]) {
    const sessionCalls = calls.filter(([clientId]) => clientId === id).map(([, sql]) => sql);
    assert.deepEqual(sessionCalls.slice(0, 3), ["SET statement_timeout = '30s'", "SET lock_timeout = '10s'", "SET idle_in_transaction_session_timeout = '120s'"]);
    assert.equal(sessionCalls.filter(sql => sql.includes('current_setting(')).length, 1);
  }
  assert.deepEqual(releases, [undefined, undefined, undefined]);
});

test('некорректные настройки сессии исключают соединение и не запускают SQL приложения', async () => {
  let releaseError, businessCalls = 0;
  const client = Object.assign(new EventEmitter(), {
    async query(sql) {
      if (sql.startsWith('SET ')) return { rows: [] };
      if (sql.includes('current_setting(')) return { rows: [{ ...initValues, lock_timeout: '0' }] };
      businessCalls++; return { rows: [] };
    },
    release(error) { releaseError = error; },
  });
  const pool = createDeadlinePool({ async connect() { return client; }, async end() {} }, { queryTimeoutMs: 100 });
  await assert.rejects(pool.query('SELECT fixture'), /ограничения сессии/);
  assert.ok(releaseError instanceof Error);
  assert.equal(businessCalls, 0);
});

test('таймаут инициализации исключает соединение', async () => {
  let releaseError;
  const client = Object.assign(new EventEmitter(), { query: () => new Promise(() => {}), release(error) { releaseError = error; } });
  const pool = createDeadlinePool({ async connect() { return client; }, async end() {} }, { queryTimeoutMs: 100 });
  await assert.rejects(pool.connect(), { code: 'DB_QUERY_TIMEOUT' });
  assert.equal(releaseError.code, 'DB_QUERY_TIMEOUT');
});

test('отмена при первом SET исключает соединение и не запускает последующий SQL', async () => {
  const abort = new AbortController(), calls = [];
  let releaseError, finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const client = Object.assign(new EventEmitter(), {
    query(sql) { calls.push(sql); return pending; }, release(error) { releaseError = error; },
  });
  const pool = createDeadlinePool({ async connect() { return client; }, async end() {} },
    { queryTimeoutMs: 10000, initializationSignal: abort.signal });
  const pendingQuery = pool.query('SELECT fixture');
  const rejected = assert.rejects(pendingQuery, { code: 'DB_STARTUP_CANCELLED' });
  while (!calls.length) await delay(0);
  abort.abort();
  await rejected;
  assert.equal(releaseError.code, 'DB_STARTUP_CANCELLED');
  finish({ rows: [] });
  await delay(0);
  assert.deepEqual(calls, ["SET statement_timeout = '30s'"]);
});

test('отмена стартового SQL прерывает ожидание и исключает соединение', async () => {
  const abort = new AbortController();
  let releaseError, finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const client = makeClient(() => pending, error => { releaseError = error; });
  const pool = createDeadlinePool({ async connect() { return client; }, async end() {} },
    { queryTimeoutMs: 10000, initializationSignal: abort.signal });
  const connection = await pool.connect();
  const result = connection.query('SELECT fixture');
  const rejected = assert.rejects(result, { code: 'DB_STARTUP_CANCELLED' });
  await delay(0);
  abort.abort();
  await rejected;
  finish({ rows: [{ ok: true }] });
  connection.release();
  assert.equal(releaseError.code, 'DB_STARTUP_CANCELLED');
});

test('отмена во время COMMIT не сообщает об успешной транзакции', async () => {
  const abort = new AbortController(), releases = [], entered = [];
  const client = makeClient(sql => {
    entered.push(sql);
    return sql === 'COMMIT' ? new Promise(() => {}) : Promise.resolve({ rows: [] });
  }, error => releases.push(error));
  const pool = createDeadlinePool({ async connect() { return client; }, async end() {} },
    { queryTimeoutMs: 10000, initializationSignal: abort.signal });
  const work = inTransaction(pool, async db => { await db.query('UPDATE fixture'); });
  const rejected = assert.rejects(work, { code: 'COMMIT_OUTCOME_UNKNOWN' });
  while (!entered.includes('COMMIT')) await delay(0);
  abort.abort();
  await rejected;
  assert.equal(releases.length, 1);
  assert.equal(releases[0].code, 'DB_STARTUP_CANCELLED');
});

test('зависший SQL истекает, физическое соединение исключается из пула', async () => {
  const releases = [];
  let resolveQuery;
  const pending = new Promise(resolve => { resolveQuery = resolve; });
  const raw = { async connect() { return makeClient(() => pending, error => releases.push(error)); }, async end() {} };
  const pool = createDeadlinePool(raw, { queryTimeoutMs: 100 });
  const connection = await pool.connect();
  await assert.rejects(connection.query('COMMIT'), { code: 'DB_QUERY_TIMEOUT' });
  assert.equal(releases.length, 1);
  assert.equal(releases[0].code, 'DB_QUERY_TIMEOUT');
  await assert.rejects(connection.query('SELECT 1'), /закрыто/);
  connection.release();
  resolveQuery({ rows: [] });
  await delay(0);
  assert.equal(releases.length, 1);
});

test('обычный запрос возвращает результат и освобождает соединение', async () => {
  const releases = [];
  const raw = { async connect() { return makeClient(async () => ({ rows: [{ ok: 1 }] }), error => releases.push(error)); }, async end() {} };
  const result = await createDeadlinePool(raw, { queryTimeoutMs: 100 }).query('SELECT 1');
  assert.equal(result.rows[0].ok, 1);
  assert.deepEqual(releases, [undefined]);
});

test('ошибка одиночного SQL не возвращает сомнительное соединение как исправное', async () => {
  const releases = [];
  const raw = { async connect() { return makeClient(async () => { throw new Error('ошибка'); }, error => releases.push(error)); }, async end() {} };
  await assert.rejects(createDeadlinePool(raw, { queryTimeoutMs: 100 }).query('SELECT 1'));
  assert.equal(releases.length, 1);
  assert.ok(releases[0] instanceof Error);
});

test('таймаут COMMIT остаётся неизвестным исходом и не повторяет запись', async () => {
  const calls = [], releases = [];
  const raw = { async connect() { return makeClient(
    async sql => { calls.push(sql); if (sql === 'COMMIT') return new Promise(() => {}); return { rows: [] }; },
    error => releases.push(error),
  ); }, async end() {} };
  const pool = createDeadlinePool(raw, { queryTimeoutMs: 100 });
  await assert.rejects(inTransaction(pool, async connection => { await connection.query('UPDATE fixture'); }), { code: 'COMMIT_OUTCOME_UNKNOWN' });
  assert.deepEqual(calls, ['BEGIN', 'UPDATE fixture', 'COMMIT']);
  assert.equal(releases.length, 1);
  assert.ok(releases[0] instanceof Error);
});

test('ошибка выделенного клиента прерывает ожидание и не раскрывает детали', async () => {
  const releases = [];
  const client = makeClient(() => new Promise(() => {}), error => releases.push(error));
  const pool = createDeadlinePool({ async connect() { return client; }, async end() {} }, { queryTimeoutMs: 1000 });
  const connection = await pool.connect();
  const result = connection.query('SELECT 1');
  client.emit('error', new Error('secret-from-driver'));
  await assert.rejects(result, error => error.code === 'DB_CONNECTION_ERROR' && !error.message.includes('secret-from-driver'));
  assert.equal(releases.length, 1);
});

test('callback-запрос не отдаёт соединение до выполнения', async () => {
  let calls = 0, releases = 0;
  const client = makeClient(() => { calls++; }, () => { releases++; });
  const pool = createDeadlinePool({ async connect() { return client; }, async end() {} }, { queryTimeoutMs: 100 });
  await assert.rejects(pool.query('SELECT 1', () => {}), /Callback/);
  assert.equal(calls, 0);
  assert.equal(releases, 1);
});

test('пользовательский потоковый Query не поддерживается', async () => {
  let calls = 0, releases = 0;
  const client = makeClient(() => { calls++; }, () => { releases++; });
  const pool = createDeadlinePool({ async connect() { return client; }, async end() {} }, { queryTimeoutMs: 100 });
  await assert.rejects(pool.query({ submit() {} }), /потоковые/);
  assert.equal(calls, 0);
  assert.equal(releases, 1);
});
