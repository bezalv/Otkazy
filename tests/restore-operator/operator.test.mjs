import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { reviewSummary, summarizeDiscovery } from '../../app/src/operator/report.mjs';
import { databaseConfig, runTriage } from '../../app/src/operator/triage.mjs';

function poolFor({ visible = true, row = { total: '3', both_unknown: '0', comment_unknown: '1', notification_unknown: '2', other: '0' } } = {}) {
  const queries = [];
  let released = false;
  return { queries, get released() { return released; }, async connect() { return {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('FROM pg_class')) return { rows: visible ? [{ is_table: true, rls_active: false }] : [{ is_table: true, rls_active: true }] };
      if (sql.includes('FROM public.lost_processing_jobs')) return { rows: [row] };
      return { rows: [] };
    }, release() { released = true; },
  }; } };
}

test('агрегат needs_review из проверенной видимой таблицы, транзакция только на чтение', async () => {
  const pool = poolFor();
  const result = await reviewSummary(pool);
  assert.deepEqual(result, { total: 3, comment_unknown: 1, notification_unknown: 2, both_unknown: 0, other: 0 });
  assert.match(pool.queries[1], /REPEATABLE READ READ ONLY/);
  assert.equal(pool.queries.at(-1), 'COMMIT');
  assert.equal(pool.released, true);
  assert.ok(pool.queries.every(sql => !/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(sql)));
});

const pglite = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
test('SQL агрегата исполняется на изолированной PostgreSQL-совместимой базе', { skip: !existsSync(pglite) }, async t => {
  const { PGlite } = await import(pathToFileURL(pglite).href);
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE public.lost_processing_jobs (status text, comment_state text, notify_state text);
    INSERT INTO public.lost_processing_jobs VALUES
      ('needs_review', 'unknown', 'pending'), ('needs_review', 'ok', 'unknown'),
      ('needs_review', 'unknown', 'unknown'), ('needs_review', 'ok', 'ok'),
      ('done', 'unknown', 'unknown');`);
  const pool = { async connect() { return { query: (sql, args) => db.query(sql, args), release() {} }; } };
  assert.deepEqual(await reviewSummary(pool), { total: 4, comment_unknown: 1, notification_unknown: 1, both_unknown: 1, other: 1 });
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.lost_processing_jobs')).rows[0].n, 5);
});

test('RLS, отсутствующая таблица и некорректные агрегаты не становятся нулевым отчётом', async () => {
  for (const pool of [poolFor({ visible: false }), poolFor({ row: { total: '9', both_unknown: '0', comment_unknown: '1', notification_unknown: '2', other: '0' } })]) {
    await assert.rejects(reviewSummary(pool), /^Error: Не удалось получить отчёт о доставке$/);
    assert.equal(pool.queries.at(-1), 'ROLLBACK');
    assert.equal(pool.released, true);
  }
  const missing = poolFor();
  const connect = missing.connect;
  missing.connect = async () => {
    const client = await connect();
    const query = client.query;
    client.query = async sql => sql.includes('FROM pg_class') ? { rows: [] } : query(sql);
    return client;
  };
  await assert.rejects(reviewSummary(missing), /Не удалось получить отчёт/);
});

test('отчёт поиска не раскрывает deal_id, курсор, ключ события или дополнительные поля', () => {
  const result = summarizeDiscovery({ pages_read: 2, scan_complete: true, coverage_guaranteed: false,
    next_cursor: { last_id: 'SECRET_CURSOR' }, events: [{ disposition: 'unprocessed', deal_id: 'SECRET_DEAL', event_key: 'SECRET_EVENT' }, { disposition: 'unverified' }] });
  assert.deepEqual(result, { pages_read: 2, scan_complete: true, coverage_guaranteed: false,
    counts: { already_handled: 0, already_waiting: 0, retry_needed: 0, unprocessed: 1, unverified: 1 } });
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.throws(() => summarizeDiscovery({ pages_read: 1, scan_complete: true, coverage_guaranteed: true, events: [] }));
  assert.throws(() => summarizeDiscovery({ pages_read: 1, scan_complete: true, coverage_guaranteed: false, events: [{ disposition: 'SECRET' }] }));
});

test('подключение с проверкой TLS и без опасных параметров в строке', () => {
  const config = databaseConfig({ DATABASE_URL: 'postgresql://user:password@unit.pooler.supabase.com:5432/db?sslmode=require' });
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.max, 1);
  assert.ok(!config.connectionString.includes('sslmode'));
  assert.throws(() => databaseConfig({ DATABASE_URL: 'postgresql://user:password@unit.pooler.supabase.com:6543/db' }));
  assert.throws(() => databaseConfig({ DATABASE_URL: 'postgresql://user:password@unit.pooler.supabase.com:5432/db?sslmode=disable' }));
  assert.throws(() => databaseConfig({ DATABASE_URL: 'postgresql://user:password@unit.pooler.supabase.com:5432/db' }, () => 'incorrect'));
});

test('триаж закрывает пул и не запускает сервер или воркер', async () => {
  const raw = new EventEmitter();
  let ended = false, created = false;
  raw.connect = async () => { throw new Error('Тестовый запрос не ожидался'); };
  raw.end = async () => { ended = true; };
  const output = await runTriage({ env: { DATABASE_URL: 'postgresql://user:password@unit.pooler.supabase.com:5432/db' },
    makePool: async config => { created = true; assert.equal(config.ssl.rejectUnauthorized, true); return raw; },
    report: async pool => { assert.equal(typeof pool.connect, 'function'); return { total: 0 }; } });
  assert.deepEqual(output, { total: 0 });
  assert.equal(created, true);
  assert.equal(ended, true);
});

test('ошибки CLI не выводят значение DATABASE_URL', () => {
  const executable = fileURLToPath(new URL('../../app/src/operator/triage.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [executable], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'SECRET_PASSWORD_DO_NOT_PRINT' }, timeout: 15000 });
  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /SECRET_PASSWORD_DO_NOT_PRINT/);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Не удалось получить отчёт/);
});
