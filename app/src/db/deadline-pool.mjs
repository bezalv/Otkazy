/**
 * Ограничивает каждый SQL-запрос даже при потере сети после подключения.
 * При таймауте физическое соединение исключается из пула: результат SQL,
 * в том числе COMMIT, может быть неизвестен и должен разбираться вызывающим.
 */
export function createDeadlinePool(pool, { queryTimeoutMs = 45000, initializationSignal } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.end !== 'function') throw new TypeError('Не задан пул PostgreSQL');
  if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 100 || queryTimeoutMs > 300000) throw new TypeError('Некорректный таймаут SQL');
  const initialized = new WeakSet();
  const settings = {
    statement_timeout: 30000, lock_timeout: 10000, idle_in_transaction_session_timeout: 120000,
  };
  const durationMs = value => {
    if (typeof value !== 'string') return NaN;
    const match = /^(\d+)\s*(ms|s|min|h|d)?$/.exec(value);
    if (!match) return NaN;
    return Number(match[1]) * ({ ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000 }[match[2] || 'ms']);
  };
  async function connect() {
    const cancelled = () => {
      const error = new Error('Инициализация базы отменена');
      error.code = 'DB_STARTUP_CANCELLED';
      return error;
    };
    if (initializationSignal?.aborted) throw cancelled();
    const client = await pool.connect();
    if (typeof client.on !== 'function' || typeof client.removeListener !== 'function' || typeof client.release !== 'function') {
      try { client.release?.(new Error('Некорректное соединение')); } catch { /* пул недоступен */ }
      throw new Error('Некорректное соединение с базой');
    }
    let released = false;
    let rejectConnection;
    const connectionError = new Promise((_, reject) => { rejectConnection = reject; });
    connectionError.catch(() => {});
    const onError = () => {
      const error = new Error('Соединение с базой потеряно');
      error.code = 'DB_CONNECTION_ERROR';
      rejectConnection(error);
      try { release(error); } catch { /* соединение больше не выдаём */ }
    };
    client.on('error', onError);
    function release(error) {
      if (released) return;
      released = true;
      client.removeListener('error', onError);
      client.release(error);
    }
    if (initializationSignal?.aborted) {
      release(cancelled());
      throw cancelled();
    }
    async function query(...args) {
      if (released) throw new Error('Соединение с базой закрыто');
      if (initializationSignal?.aborted) throw cancelled();
      if (args.some(arg => typeof arg === 'function') || typeof args[0]?.callback === 'function'
        || typeof args[0]?.submit === 'function') {
        throw new TypeError('Callback- и потоковые запросы к базе не поддерживаются');
      }
      let timer;
      let rejectStartup;
      const startupCancelled = new Promise((_, reject) => { rejectStartup = reject; });
      const onAbort = () => {
        const error = cancelled();
        try { release(error); } catch { /* соединение больше не выдаём */ }
        rejectStartup(error);
      };
      initializationSignal?.addEventListener('abort', onAbort, { once: true });
      if (initializationSignal?.aborted) onAbort();
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Превышено время запроса к базе');
          error.code = 'DB_QUERY_TIMEOUT';
          try { release(error); } catch { /* соединение больше не выдаём */ }
          reject(error);
        }, queryTimeoutMs);
      });
      try {
        return await Promise.race([
          Promise.resolve().then(() => {
            if (initializationSignal?.aborted) throw cancelled();
            return client.query(...args);
          }), deadline, connectionError, startupCancelled,
        ]);
      }
      finally { clearTimeout(timer); initializationSignal?.removeEventListener('abort', onAbort); }
    }
    if (!initialized.has(client)) {
      try {
        await query("SET statement_timeout = '30s'");
        await query("SET lock_timeout = '10s'");
        await query("SET idle_in_transaction_session_timeout = '120s'");
        const result = await query(`SELECT current_setting('statement_timeout') AS statement_timeout,
          current_setting('lock_timeout') AS lock_timeout,
          current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout`);
        if (result?.rows?.length !== 1 || Object.entries(settings).some(([name, expected]) => durationMs(result.rows[0][name]) !== expected)) {
          throw new Error('Не удалось проверить ограничения сессии PostgreSQL');
        }
        initialized.add(client);
      } catch (error) {
        try { release(error); } catch { /* неисправную сессию не возвращаем */ }
        throw error;
      }
    }
    if (initializationSignal?.aborted) {
      release(cancelled());
      throw cancelled();
    }
    return { query, release };
  }
  return {
    connect,
    async query(...args) {
      const connection = await connect();
      let failure;
      try { return await connection.query(...args); }
      catch (error) { failure = error; throw error; }
      finally { connection.release(failure); }
    },
    end: () => pool.end(),
  };
}
