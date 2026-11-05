/** Ограничение действует только в этом процессе и не управляет другими приложениями. */
export class BitrixLimiterError extends Error {
  constructor(code, retryAfterMs = 0) {
    super('Запрос к Битриксу отложен ограничителем');
    this.name = 'BitrixLimiterError';
    this.code = code;
    this.retryable = true;
    this.requestStarted = false;
    this.retryAfterMs = Math.max(0, retryAfterMs);
  }
}

export function createBitrixLimiter({ intervalMs = 1000, maxWaitMs = 120000,
  maxPending = 200, fallbackCooldownMs = 60000, now = Date.now } = {}) {
  for (const value of [intervalMs, maxWaitMs, maxPending, fallbackCooldownMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new TypeError('Некорректные настройки ограничителя');
  }
  const queue = [];
  const resetHints = new Map();
  const blocked = new Map();
  let nextStart = 0, running = false, closed = false, timer;

  function detach(entry) { entry.signal?.removeEventListener('abort', entry.onAbort); }

  function wake() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (closed) return;
    const current = now();
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].deadline <= current) {
        const [entry] = queue.splice(i, 1);
        detach(entry);
        entry.reject(new BitrixLimiterError('BITRIX_LIMITER_QUEUE_TIMEOUT', (blocked.get(entry.method) || 0) - current));
      }
    }
    if (!running && current >= nextStart) {
      const index = queue.findIndex(entry => (blocked.get(entry.method) || 0) <= current);
      if (index >= 0) {
        const [entry] = queue.splice(index, 1);
        detach(entry);
        running = true;
        Promise.resolve().then(() => {
          // Для клиента проверка БД предшествует fetch и может длиться долго.
          // Отсчёт интервала должен начинаться только у фактического запроса.
          const markStart = () => { nextStart = now() + intervalMs; };
          if (!entry.deferStart) markStart();
          return entry.task(markStart);
        }).then(entry.resolve, entry.reject).finally(() => {
          running = false;
          wake();
        });
      }
    }
    if (!queue.length) return;
    let nextWake = Math.min(...queue.map(entry => entry.deadline));
    if (!running) {
      for (const entry of queue) nextWake = Math.min(nextWake, Math.max(nextStart, blocked.get(entry.method) || 0));
    }
    timer = setTimeout(wake, Math.max(1, Math.min(2147483647, nextWake - current)));
  }

  return {
    schedule(method, task, { signal, deferStart = false } = {}) {
      if (closed) return Promise.reject(new BitrixLimiterError('BITRIX_LIMITER_CLOSED'));
      if (signal?.aborted) return Promise.reject(new BitrixLimiterError('BITRIX_LIMITER_CANCELLED'));
      if (queue.length >= maxPending) return Promise.reject(new BitrixLimiterError('BITRIX_LIMITER_QUEUE_FULL'));
      return new Promise((resolve, reject) => {
        const entry = { method, task, resolve, reject, deadline: now() + maxWaitMs, signal, deferStart };
        entry.onAbort = () => {
          const index = queue.indexOf(entry);
          if (index < 0) return;
          queue.splice(index, 1);
          detach(entry);
          reject(new BitrixLimiterError('BITRIX_LIMITER_CANCELLED'));
          wake();
        };
        queue.push(entry);
        signal?.addEventListener('abort', entry.onAbort, { once: true });
        if (signal?.aborted) { entry.onAbort(); return; }
        wake();
      });
    },
    observeSuccess(method, response) {
      const raw = response?.time?.operating_reset_at;
      const seconds = typeof raw === 'number' || (typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw)) ? Number(raw) : NaN;
      const reset = seconds * 1000;
      if (Number.isFinite(reset) && reset > now() && reset <= Number.MAX_SAFE_INTEGER) resetHints.set(method, reset);
    },
    operationLimited(method) {
      const current = now();
      blocked.set(method, Math.max(blocked.get(method) || 0, resetHints.get(method) || 0,
        (resetHints.get(method) || 0) > current ? 0 : current + fallbackCooldownMs));
      wake();
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      for (const entry of queue.splice(0)) { detach(entry); entry.reject(new BitrixLimiterError('BITRIX_LIMITER_CLOSED')); }
    },
  };
}
