import { setTimeout as delay } from 'node:timers/promises';
import { prepareRuntime } from './runtime.mjs';
import { createBitrixClient } from './bitrix-client.mjs';
import { createBitrixLimiter } from './bitrix-limiter.mjs';
import { createLiveInbox, processLiveEvent } from './live/index.mjs';
import { createLiveHttpHandler } from './live/http.mjs';

const DEFAULT_INTERVALS = { inbox: 3000, worker: 5000, nightly: 60000, database: 30000 };

/**
 * Явно управляемая композиция. Конструирование не создаёт таймеры,
 * не открывает порт и не обращается к базе, сети или дочерним процессам.
 * Сырой текст ошибок, тело webhook и секреты нигде не журналируются.
 */
export function createApplication({ pool, bitrixBaseUrl, polzaKey, applicationToken, domain, memberId,
  liveEnabledAt, fetchImpl = globalThis.fetch, intervals = {}, databaseDeadlineMs = 5000, onEvent = () => {} }, dependencies = {}) {
  const configured = { ...DEFAULT_INTERVALS, ...intervals };
  for (const interval of Object.values(configured)) {
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 86400000) throw new TypeError('Некорректный интервал');
  }
  if (typeof onEvent !== 'function') throw new TypeError('Некорректный обработчик состояния');
  if (!Number.isSafeInteger(databaseDeadlineMs) || databaseDeadlineMs < 1 || databaseDeadlineMs > 300000) throw new TypeError('Некорректный срок проверки базы');
  const prepare = dependencies.prepareRuntime || prepareRuntime;
  const makeInbox = dependencies.createLiveInbox || createLiveInbox;
  const makeHttp = dependencies.createLiveHttpHandler || createLiveHttpHandler;
  const makeBitrix = dependencies.createBitrixClient || createBitrixClient;
  const bitrixLimiter = (dependencies.createBitrixLimiter || createBitrixLimiter)();
  const processEvent = dependencies.processLiveEvent || processLiveEvent;
  // Даже пустой claim не говорит, что отложенные события уже обработаны.
  const inspectInbox = dependencies.inspectInbox || (async database => {
    const result = await database.query(`SELECT EXISTS (
      SELECT 1 FROM public.lost_bitrix_events
      WHERE status IN ('pending','processing') AND attempts > 0
    ) AS retry_pending`);
    if (result?.rows?.length !== 1 || typeof result.rows[0].retry_pending !== 'boolean') {
      throw new Error('Неизвестно состояние входящей очереди');
    }
    return result.rows[0].retry_pending;
  });
  const inspectDelivery = dependencies.inspectDelivery || (async database => {
    const result = await database.query(`SELECT EXISTS (
      SELECT 1 FROM public.lost_processing_jobs WHERE status='needs_review'
    ) AS review_pending`);
    if (result?.rows?.length !== 1 || typeof result.rows[0].review_pending !== 'boolean') {
      throw new Error('Неизвестно состояние доставки');
    }
    return result.rows[0].review_pending;
  });
  const timers = dependencies.timers || { setTimeout, clearTimeout };
  const active = new Set();
  const scheduled = new Map();
  // Независимые проверки не смешиваются: успех одного цикла не скрывает
  // ошибку другого. Диагностика не содержит сообщения исключений и секреты.
  const checks = { inbox: 'checking', worker: 'checking', nightly: 'checking', stt: 'checking', delivery_review: 'checking', database: 'checking', database_retry: 'checking', database_delivery: 'checking' };
  let readiness = 'checking';
  let degradationReported = false;
  let sttFailureEpoch = 0;
  let state = 'idle';
  let startPromise, drainPromise, runtime, inbox, liveHandler, bitrix;
  let databaseProbe;

  function report(name) {
    try { onEvent(name); } catch { /* ошибки наблюдателя не управляют обработкой */ }
  }
  function updateReadiness() {
    if (state !== 'running') return;
    const failed = Object.values(checks).some(value => value === 'error' || value === 'unavailable' || value === 'needs_review');
    readiness = failed ? 'degraded' : Object.values(checks).every(value => value === 'ok') ? 'ready' : 'checking';
    if (readiness === 'degraded' && !degradationReported) {
      degradationReported = true;
      report('processing_degraded');
    } else if (readiness === 'ready' && degradationReported) {
      degradationReported = false;
      report('processing_recovered');
    }
  }
  function track(promise) {
    const work = Promise.resolve(promise);
    active.add(work);
    work.finally(() => active.delete(work)).catch(() => {});
    return work;
  }
  function schedule(name, work, wait) {
    if (state !== 'running') return;
    const timer = timers.setTimeout(() => {
      scheduled.delete(name);
      if (state !== 'running') return;
      // stop() может наступить между колбэком таймера и микрозадачей.
      const task = track(Promise.resolve().then(async () => {
        if (state !== 'running') return;
        const sttCycle = name === 'worker' || name === 'nightly';
        const observedEpoch = sttFailureEpoch;
        try {
          const result = await work();
          if (state !== 'running') return;
          const runtimeResult = name === 'worker' ? result?.runtimeResult : result;
          const sttUnavailable = sttCycle && runtimeResult?.status === 'stt_unavailable';
          if (sttUnavailable) {
            // Даже проверка, начавшаяся раньше другой, могла обнаружить сбой
            // позже неё. Ошибку никогда не отбрасываем как «устаревшую».
            sttFailureEpoch++;
            checks.stt = 'unavailable';
          } else if (sttCycle && observedEpoch === sttFailureEpoch) {
            // Только проверка, начатая после наблюдения последнего сбоя,
            // может подтвердить восстановление.
            checks.stt = 'ok';
          }
          if (name === 'worker') checks.delivery_review = result?.reviewStatus || 'error';
          if (!sttUnavailable) checks[name] = result?.status === 'retry_pending' ? 'error' : 'ok';
          updateReadiness();
        } catch {
          if (state !== 'running') return;
          checks[name] = 'error';
          updateReadiness();
        }
      }));
      task.finally(() => schedule(name, work, configured[name]));
    }, wait);
    timer?.unref?.();
    scheduled.set(name, timer);
  }
  async function inboxTick() {
    await inbox.recoverExpired();
    if (state !== 'running') return;
    const event = await inbox.claim();
    if (event && state !== 'running') {
      // Если не удалось вернуть в pending, аренда истечёт после перезапуска.
      await inbox.retry(event.id, event.lease_token);
      return;
    }
    let retried = false;
    if (event) {
      const result = await processEvent({ inbox, event, bitrix });
      if (!['queued', 'ignored', 'retry'].includes(result?.status)) throw new Error('Неизвестный результат события');
      retried = result.status === 'retry';
    }
    if (state !== 'running') return;
    const retryPending = await inspectInbox(pool);
    return { status: retried || retryPending ? 'retry_pending' : 'ok' };
  }
  async function workerTick() {
    const runtimeResult = await runtime.tick();
    if (state !== 'running') return { runtimeResult, reviewStatus: 'checking' };
    try {
      return { runtimeResult, reviewStatus: await inspectDelivery(pool) ? 'needs_review' : 'ok' };
    } catch {
      return { runtimeResult, reviewStatus: 'error' };
    }
  }
  // Отдельная только читающая проверка не зависит от долгого анализа аудио.
  // Истёкший запрос не отменяется наугад и не заменяется новым до фактического
  // завершения: даже зависшее соединение не создаёт бесконечную очередь запросов.
  function scheduleDatabase(wait) {
    if (state !== 'running') return;
    const timer = timers.setTimeout(() => {
      scheduled.delete('database');
      if (state !== 'running') return;
      if (databaseProbe) {
        checks.database = 'error';
        updateReadiness();
        scheduleDatabase(configured.database);
        return;
      }
      const probe = { expired: false };
      databaseProbe = probe;
      const deadline = timers.setTimeout(() => {
        scheduled.delete('database_deadline');
        probe.expired = true;
        if (state === 'running') {
          checks.database = 'error';
          updateReadiness();
          scheduleDatabase(configured.database);
        }
      }, databaseDeadlineMs);
      deadline?.unref?.();
      scheduled.set('database_deadline', deadline);
      Promise.resolve().then(async () => {
        const retryPending = await inspectInbox(pool);
        if (probe.expired || state !== 'running') return;
        const reviewPending = await inspectDelivery(pool);
        if (probe.expired || state !== 'running') return;
        checks.database = 'ok';
        checks.database_retry = retryPending ? 'error' : 'ok';
        checks.database_delivery = reviewPending ? 'needs_review' : 'ok';
        updateReadiness();
      }).catch(() => {
        if (!probe.expired && state === 'running') {
          checks.database = 'error';
          updateReadiness();
        }
      }).finally(() => {
        if (databaseProbe === probe) databaseProbe = undefined;
        if (!probe.expired) {
          timers.clearTimeout(deadline);
          scheduled.delete('database_deadline');
          scheduleDatabase(configured.database);
        }
      });
    }, wait);
    timer?.unref?.();
    scheduled.set('database', timer);
  }
  function beginSchedules() {
    schedule('inbox', inboxTick, 0);
    schedule('worker', workerTick, 0);
    schedule('nightly', () => runtime.nightly(), 0);
    scheduleDatabase(0);
  }

  async function start() {
    if (state === 'running') return { status: 'running' };
    if (state === 'starting') return startPromise;
    if (state !== 'idle') throw new Error('Приложение нельзя запустить повторно');
    state = 'starting';
    startPromise = (async () => {
      try {
        inbox = makeInbox(pool, { applicationToken, domain, memberId, liveEnabledAt });
        await inbox.assertConfig();
        if (state !== 'starting') return { status: 'stopping' };
        bitrix = makeBitrix({ baseUrl: bitrixBaseUrl, fetchImpl, limiter: bitrixLimiter });
        runtime = await prepare({ pool, bitrixBaseUrl, polzaKey, fetchImpl, bitrixLimiter });
        if (state !== 'starting') return { status: 'stopping' };
        // HTTP-прослойка отслеживает запись даже если клиент оборвал соединение.
        liveHandler = makeHttp({ inbox: { acceptForm: body => track(inbox.acceptForm(body)) } });
        state = 'running';
        beginSchedules();
        return { status: 'running' };
      } catch {
        if (state === 'starting' || state === 'running') {
          state = 'failed';
          for (const timer of scheduled.values()) timers.clearTimeout(timer);
          scheduled.clear();
          if (runtime) {
            try { await runtime.close({ graceMs: 25000 }); } catch { /* ошибка уже сообщена */ }
          }
          bitrixLimiter.close();
        }
        throw new Error('Не удалось подготовить приложение');
      }
    })();
    return startPromise;
  }

  // Сам маршрут привязывается внешним HTTP-сервером; этот модуль портов не открывает.
  function handleLive(req, res) {
    if (state !== 'running' || !liveHandler) {
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(503);
      res.end();
      req.resume?.();
      return;
    }
    // Пока принимается тело, при остановке ожидаем ответ или закрытие клиента.
    const pendingResponse = new Promise(resolve => {
      res.once('finish', resolve);
      res.once('close', resolve);
    });
    track(pendingResponse);
    try { liveHandler(req, res); }
    catch { if (!res.headersSent && !res.destroyed) { res.writeHead(503); res.end(); } }
  }

  async function stop({ graceMs = 25000 } = {}) {
    if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 300000) throw new TypeError('Некорректный срок завершения');
    if (state === 'stopped') return { status: 'drained' };
    if (!drainPromise) {
      state = 'stopping';
      for (const timer of scheduled.values()) timers.clearTimeout(timer);
      scheduled.clear();
      drainPromise = (async () => {
        if (startPromise) await startPromise.catch(() => {});
        while (active.size) await Promise.allSettled([...active]);
        if (runtime) {
          // При timeout runtime продолжает завершение самостоятельно; не выдаём
          // его за готовый drain и повторно ждём, не начиная новую работу.
          let result;
          do { result = await runtime.close({ graceMs: 300000 }); } while (result?.status === 'timeout');
          if (result?.status !== 'drained') throw new Error('Не удалось завершить runtime');
        }
        bitrixLimiter.close();
        state = 'stopped';
        return { status: 'drained' };
      })();
      drainPromise.catch(() => {});
    }
    const timer = new AbortController();
    try {
      return await Promise.race([
        drainPromise,
        delay(graceMs, undefined, { signal: timer.signal }).then(() => ({ status: 'timeout' })),
      ]);
    } catch {
      throw new Error('Не удалось завершить приложение');
    } finally { timer.abort(); }
  }
  return {
    start, stop, handleLive, getStatus: () => state,
    getReadiness: () => ({
      ready: state === 'running' && readiness === 'ready',
      status: state === 'running' ? readiness : 'not_running',
      checks: { ...checks },
    }),
  };
}
