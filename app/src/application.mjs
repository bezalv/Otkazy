import { setTimeout as delay } from 'node:timers/promises';
import { prepareRuntime } from './runtime.mjs';
import { createBitrixClient } from './bitrix-client.mjs';
import { createBitrixLimiter } from './bitrix-limiter.mjs';
import { createLiveInbox, processLiveEvent, validateLiveConfig } from './live/index.mjs';
import { createLiveHttpHandler } from './live/http.mjs';

const DEFAULT_INTERVALS = { inbox: 3000, worker: 5000, nightly: 60000, database: 30000 };
const AUDIO_ORIGIN_CHECK = "CHECKorigin_stage_history_idISNULLORorigin_stage_history_id~'^[1-9][0-9]{0,29}$'";

function normalizeConstraint(value) {
  if (typeof value !== 'string') return null;
  // PostgreSQL в разных версиях может добавлять скобки и явное приведение
  // строкового литерала к text. Других операторов и литералов не допускаем.
  // Содержимое строкового литерала сохраняем полностью: пробел или скобка
  // внутри регулярного выражения меняют условие, а не форматирование SQL.
  return value.split(/('(?:''|[^'])*')/g).map((part, index) => index % 2 ? part
    : part.replace(/::(?:pg_catalog\.)?text/g, '').replace(/[\s()]/g, '')).join('');
}

/** Проверяет миграцию ожидания аудио до запуска потребителей и HTTP-приёма. */
export async function assertAudioOriginSchema(pool) {
  if (!pool || typeof pool.query !== 'function') throw new Error('Недоступна проверка схемы');
  const result = await pool.query(`SELECT pg_catalog.pg_get_constraintdef(c.oid) AS check_definition
    FROM pg_catalog.pg_class r
    JOIN pg_catalog.pg_namespace n ON n.oid=r.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
    JOIN pg_catalog.pg_constraint c ON c.conrelid=r.oid
    WHERE n.nspname='public' AND r.relname='lost_audio_wait' AND r.relkind IN ('r','p')
      AND a.attname='origin_stage_history_id' AND a.attnum>0 AND NOT a.attisdropped
      AND a.atttypid='text'::regtype AND NOT a.attnotnull
      AND c.conname='lost_audio_wait_origin_stage_history_id_check' AND c.contype='c' AND c.convalidated
      AND c.conkey=ARRAY[a.attnum]::smallint[]`);
  if (result?.rows?.length !== 1 || normalizeConstraint(result.rows[0].check_definition) !== AUDIO_ORIGIN_CHECK) {
    throw new Error('Схема ожидания аудио не подтверждена');
  }
}

/**
 * Явно управляемая композиция. Конструирование не создаёт таймеры,
 * не открывает порт и не обращается к базе, сети или дочерним процессам.
 * Сырой текст ошибок, тело webhook и секреты нигде не журналируются.
 */
export function createApplication({ pool, bitrixBaseUrl, polzaKey, applicationToken, domain, memberId,
  liveEnabledAt, pilotMode = false, fetchImpl = globalThis.fetch, intervals = {}, databaseDeadlineMs = 5000, onEvent = () => {} }, dependencies = {}) {
  if (typeof pilotMode !== 'boolean') throw new TypeError('Некорректный режим пилота');
  const configured = { ...DEFAULT_INTERVALS, ...(pilotMode ? {inbox:60000} : {}), ...intervals };
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
  const inspectAudioOriginSchema = dependencies.inspectAudioOriginSchema || assertAudioOriginSchema;
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
    schedule('inbox', pilotMode ? async () => {
      const result=await runtime.pollPilot();
      if (result?.status === 'stt_unavailable') throw new Error('Распознавание недоступно');
      return result;
    } : inboxTick, 0);
    schedule('worker', workerTick, 0);
    if (pilotMode) checks.nightly='ok';
    else schedule('nightly', () => runtime.nightly(), 0);
    scheduleDatabase(0);
  }

  async function start() {
    if (state === 'running') return { status: 'running' };
    if (state === 'starting') return startPromise;
    if (state !== 'idle') throw new Error('Приложение нельзя запустить повторно');
    state = 'starting';
    startPromise = (async () => {
      try {
        await inspectAudioOriginSchema(pool);
        if (state !== 'starting') return { status: 'stopping' };
        if (pilotMode) await validateLiveConfig(pool,liveEnabledAt);
        else { inbox = makeInbox(pool, { applicationToken, domain, memberId, liveEnabledAt }); await inbox.assertConfig(); }
        if (state !== 'starting') return { status: 'stopping' };
        bitrix = makeBitrix({ baseUrl: bitrixBaseUrl, fetchImpl, limiter: bitrixLimiter });
        runtime = await prepare({ pool, bitrixBaseUrl, polzaKey, fetchImpl, bitrixLimiter,
          ...(pilotMode ? {deliveryMode:'pilot65',pilotEnabledAt:liveEnabledAt} : {}) });
        if (state !== 'starting') return { status: 'stopping' };
        // HTTP-прослойка отслеживает запись даже если клиент оборвал соединение.
        if (!pilotMode) liveHandler = makeHttp({ inbox: { acceptForm: body => track(inbox.acceptForm(body)) } });
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
