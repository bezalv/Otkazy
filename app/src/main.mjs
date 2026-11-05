import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { getCACertificates } from 'node:tls';
import { createApplication } from './application.mjs';
import { createDeadlinePool } from './db/deadline-pool.mjs';

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Не задан ${name}`);
  return value;
}

/** Проверяет настройки до создания сервера, пула или фоновых задач. */
export function readMainConfig(env) {
  const mode = env.OTKAZY_MODE || 'setup';
  if (!['setup', 'active'].includes(mode)) throw new Error('Некорректный OTKAZY_MODE');
  const port = Number(env.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Некорректный PORT');
  const host = env.HOST || '0.0.0.0';
  if (typeof host !== 'string' || !host.trim()) throw new Error('Некорректный HOST');
  if (mode === 'setup') return { mode, port, host };

  if (env.TZ !== 'UTC') throw new Error('Для активного режима требуется TZ=UTC');
  const rawDatabaseUrl = required(env, 'DATABASE_URL');
  let database;
  try { database = new URL(rawDatabaseUrl); } catch { throw new Error('Некорректный DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname
      || database.hostname.endsWith('.') || !database.username || !database.password || database.pathname.length <= 1 || database.hash) {
    throw new Error('Некорректный DATABASE_URL');
  }
  if (database.hostname.toLowerCase().endsWith('.pooler.supabase.com') && (database.port || '5432') !== '5432') {
    throw new Error('Для Supabase pooler требуется порт сессионного режима 5432');
  }
  // node-postgres может принять SSL-параметры строки подключения вместо ssl
  // объекта. Убираем только совместимый sslmode и запрещаем другие параметры.
  for (const [name, value] of database.searchParams) {
    if (name !== 'sslmode' || !['require', 'verify-ca', 'verify-full'].includes(value)) {
      throw new Error('Некорректные параметры DATABASE_URL');
    }
  }
  if (database.searchParams.getAll('sslmode').length > 1) throw new Error('Некорректные параметры DATABASE_URL');
  database.search = '';
  const domain = required(env, 'BITRIX_DOMAIN');
  if (!/^[a-z0-9.-]+$/i.test(domain)) throw new Error('Некорректный BITRIX_DOMAIN');
  const bitrixBaseUrl = required(env, 'BITRIX_REST_BASE');
  let bitrix;
  try { bitrix = new URL(bitrixBaseUrl); } catch { throw new Error('Некорректный BITRIX_REST_BASE'); }
  if (bitrix.protocol !== 'https:' || bitrix.hostname.toLowerCase() !== domain.toLowerCase()
      || bitrix.username || bitrix.password || bitrix.search || bitrix.hash) {
    throw new Error('Некорректный BITRIX_REST_BASE');
  }
  const liveEnabledAt = required(env, 'LIVE_ENABLED_AT');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(liveEnabledAt)
      || !Number.isFinite(Date.parse(liveEnabledAt))) throw new Error('Некорректный LIVE_ENABLED_AT');
  return {
    mode, port, host, databaseUrl: database.toString(), bitrixBaseUrl,
    polzaKey: required(env, 'POLZA_API_KEY'), applicationToken: required(env, 'BITRIX_EVENT_TOKEN'),
    domain, memberId: required(env, 'BITRIX_MEMBER_ID'), liveEnabledAt,
  };
}

/** Создаёт только маршрутизатор; сервер и обработка событий не запускаются. */
export function createMainHandler({ mode, application = null, isStopping = () => false, isStarted = () => false }) {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const pathname = (req.url || '').split('?')[0];
    if (pathname === '/webhooks/bitrix' && mode === 'active' && application && isStarted() && !isStopping()) {
      try { application.handleLive(req, res); }
      catch { if (!res.headersSent && !res.destroyed) { res.writeHead(503); res.end(); } }
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/health' || pathname === '/ready')) {
      let info = { ready: false, status: 'not_running' };
      try { if (pathname === '/ready' && mode === 'active' && application && !isStopping()) info = application.getReadiness(); } catch { /* не выдаём внутреннюю ошибку */ }
      const alive = mode === 'setup' || (isStarted() && !isStopping());
      const ready = mode === 'active' && alive && info?.ready === true;
      const code = pathname === '/health' ? (alive ? 200 : 503) : ready ? 200 : 503;
      const checks = {};
      if (mode === 'active' && info?.checks && typeof info.checks === 'object') {
        for (const name of ['inbox', 'worker', 'nightly', 'stt', 'delivery_review', 'database', 'database_retry', 'database_delivery']) {
          const value = info.checks[name];
          if (['checking', 'ok', 'error', 'unavailable', 'needs_review'].includes(value)) checks[name] = value;
        }
      }
      const body = pathname === '/health' ? { ok: alive, mode } : { ok: ready, mode, ready, status: ready ? 'ready' : 'not_ready', checks };
      res.writeHead(code);
      res.end(JSON.stringify(body));
      return;
    }
    if (pathname === '/webhooks/bitrix' && mode === 'active') {
      res.writeHead(503);
    } else {
      res.writeHead(404);
    }
    res.end(JSON.stringify({ ok: false }));
    req.resume?.();
  };
}

async function defaultPool(config) {
  const { default: pg } = await import('pg');
  return new pg.Pool(config);
}

function trustedRoots(readCertificate) {
  try {
    const pem = readCertificate(new URL('../certs/supabase-root-ca-2021.crt', import.meta.url), 'utf8');
    const certificate = new X509Certificate(pem);
    if (!certificate.ca || certificate.fingerprint256.replaceAll(':', '') !== '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA') throw new Error();
    return [...getCACertificates('default'), certificate.toString()];
  } catch { throw new Error('Не удалось проверить сертификат PostgreSQL'); }
}

/** Явный запуск. Значения окружения не выводятся в лог. */
export async function startMain({ env = process.env, processRef = process, makePool = defaultPool,
  makeApplication = createApplication, makeServer = createServer, readCertificate = readFileSync, logger = console } = {}) {
  const config = readMainConfig(env);
  let pool = null, application = null, server = null, listening = false, stopping = false, started = false, runtimeFailed = false;
  let drainPromise;
  const startupAbort = new AbortController();
  const log = message => { try { logger.error(message); } catch { /* журнал не управляет приложением */ } };
  const onSignal = () => {
    stop().then(result => {
      if (result.status === 'timeout') { log('Превышено время завершения приложения'); processRef.exitCode = 1; }
    }).catch(() => { log('Не удалось завершить приложение'); processRef.exitCode = 1; });
  };
  async function stop({ graceMs = 25000 } = {}) {
    if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 300000) throw new TypeError('Некорректный срок завершения');
    if (!drainPromise) {
      stopping = true;
      if (!started) startupAbort.abort();
      processRef.removeListener?.('SIGTERM', onSignal);
      processRef.removeListener?.('SIGINT', onSignal);
      const serverClosed = new Promise(resolve => {
        if (!server || !listening) { resolve(); return; }
        server.close(() => resolve());
        server.closeIdleConnections?.();
      });
      drainPromise = (async () => {
        if (application) {
          let result;
          do { result = await application.stop({ graceMs: 300000 }); } while (result?.status === 'timeout');
          if (result?.status !== 'drained') throw new Error('Приложение не завершилось');
        }
        if (pool) await pool.end();
        await serverClosed;
        return { status: 'drained' };
      })();
      drainPromise.catch(() => {});
    }
    const timer = new AbortController();
    try {
      return await Promise.race([drainPromise, delay(graceMs, undefined, { signal: timer.signal }).then(() => ({ status: 'timeout' }))]);
    } finally { timer.abort(); }
  }
  try {
    if (config.mode === 'active') {
      const ca = trustedRoots(readCertificate);
      pool = await makePool({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: true, ca }, max: 2,
        connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000,
        // Ограничения действуют на стороне PostgreSQL, а не на HTTP/STT.
        // idle-in-transaction ограничивает паузу между запросами, а не всю транзакцию.
        statement_timeout: 30000, lock_timeout: 10000, idle_in_transaction_session_timeout: 120000,
        keepAlive: true, keepAliveInitialDelayMillis: 30000 });
      // Ошибка свободного соединения приходит на Pool как событие error.
      // Содержимое ошибки может включать адреса и секреты и не журналируется.
      pool.on?.('error', () => {
        runtimeFailed = true;
        log('Ошибка пула PostgreSQL');
        processRef.exitCode = 1;
        stop().then(result => {
          if (result.status === 'timeout') log('Превышено время завершения приложения');
        }).catch(() => log('Не удалось завершить приложение'));
      });
      application = makeApplication({ pool: createDeadlinePool(pool, { initializationSignal: startupAbort.signal }), bitrixBaseUrl: config.bitrixBaseUrl, polzaKey: config.polzaKey,
        applicationToken: config.applicationToken, domain: config.domain, memberId: config.memberId,
        liveEnabledAt: config.liveEnabledAt, onEvent: name => {
          if (name === 'processing_degraded') log('Обработка временно недоступна');
          if (name === 'processing_recovered') log('Обработка восстановлена');
        } });
      if (stopping) throw new Error('Приложение остановлено при запуске');
    }
    server = makeServer(createMainHandler({ mode: config.mode, application, isStopping: () => stopping, isStarted: () => started }));
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    await new Promise((resolvePromise, rejectPromise) => {
      const fail = () => rejectPromise(new Error('Не удалось запустить HTTP-сервер'));
      server.once('error', fail);
      server.listen(config.port, config.host, () => { server.removeListener('error', fail); listening = true; resolvePromise(); });
    });
    // Ошибка пула могла наступить, пока ожидали listen: stop ещё не мог
    // закрыть сервер, поэтому закрываем его сразу после окончания listen.
    if (stopping) {
      await new Promise(resolvePromise => server.close(() => resolvePromise()));
      throw new Error('Приложение остановлено при запуске');
    }
    server.on('error', () => {
      runtimeFailed = true;
      log('Ошибка HTTP-сервера');
      processRef.exitCode = 1;
      stop().then(result => {
        if (result.status === 'timeout') log('Превышено время завершения приложения');
      }).catch(() => log('Не удалось завершить приложение'));
    });
    processRef.once('SIGTERM', onSignal);
    processRef.once('SIGINT', onSignal);
    if (application) {
      const result = await application.start();
      if (result?.status !== 'running' && !(stopping && result?.status === 'stopping')) throw new Error('Приложение не запущено');
      if (runtimeFailed) throw new Error('Ошибка службы');
      if (!stopping && result?.status === 'running') started = true;
    }
    return { mode: config.mode, server, stop, getStatus: () => stopping ? 'stopping' : application?.getStatus() || 'setup' };
  } catch {
    try { await stop({ graceMs: 25000 }); } catch { /* неизвестный исход не объявляем успешным */ }
    throw new Error('Не удалось подготовить приложение');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMain().catch(() => { console.error('Ошибка запуска приложения'); process.exitCode = 1; });
}
