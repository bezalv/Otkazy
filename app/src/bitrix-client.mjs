/** Ошибки API без адреса вебхука и переданных данных. */
export class BitrixError extends Error {
  constructor(message, { status, code, retryable = false, requestStarted } = {}) {
    super(message);
    this.name = 'BitrixError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.requestStarted = requestStarted;
  }
}

const KNOWN_ERRORS = new Set(['QUERY_LIMIT_EXCEEDED', 'OPERATION_TIME_LIMIT', 'INTERNAL_SERVER_ERROR']);

/** Клиент входящего вебхука Битрикса. Сборщик сам управляет повторами. */
export function createBitrixClient({ baseUrl, fetchImpl = fetch, timeoutMs = 60_000, limiter }) {
  if (!baseUrl) throw new Error('Не задан адрес вебхука Битрикса');
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error('Недопустимый адрес вебхука Битрикса');
  }
  if (!['http:', 'https:'].includes(base.protocol)) {
    throw new Error('Недопустимый протокол адреса Битрикса');
  }
  const endpoint = base.href.replace(/\/+$/, '');

  return {
    async request(method, body = {}, { signal, beforeSend } = {}) {
      if (!/^[a-z][a-z0-9_.]*$/i.test(method)) {
        throw new Error('Недопустимое имя метода Битрикса');
      }

      const limitMethod = method.toLowerCase();
      const send = async markStart => {
        const notStarted = () => new BitrixError('Запрос к Битриксу не был начат', {
          code: 'BITRIX_REQUEST_NOT_STARTED', retryable: true, requestStarted: false,
        });
        if (signal?.aborted) throw notStarted();
        if (beforeSend) {
          try { if (await beforeSend() !== true) throw notStarted(); }
          catch { throw notStarted(); }
        }
        if (signal?.aborted) throw notStarted();
        let response;
        try {
          markStart?.();
          response = await fetchImpl(`${endpoint}/${method}.json`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
          });
        } catch {
          throw new BitrixError('Не удалось связаться с Битриксом', { retryable: true });
        }

        if (!response.ok) {
          let result;
          try { result = await response.json(); } catch { /* HTTP-статус достаточен */ }
          const code = KNOWN_ERRORS.has(result?.error) ? result.error : undefined;
          if (code === 'OPERATION_TIME_LIMIT') limiter?.operationLimited(limitMethod);
          throw new BitrixError(`Битрикс вернул HTTP ${response.status}`, {
            status: response.status,
            code,
            retryable: response.status === 429 || response.status >= 500,
          });
        }

        let result;
        try {
          result = await response.json();
        } catch {
          throw new BitrixError('Битрикс вернул ответ без корректного JSON', { retryable: true });
        }
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new BitrixError('Битрикс вернул ответ неизвестного формата', { retryable: true });
        }
        if (result.error) {
          const code = KNOWN_ERRORS.has(result.error) ? result.error : 'API';
          if (code === 'OPERATION_TIME_LIMIT') limiter?.operationLimited(limitMethod);
          throw new BitrixError(`Битрикс вернул ошибку ${code}`, {
            code,
            retryable: ['QUERY_LIMIT_EXCEEDED', 'OPERATION_TIME_LIMIT', 'INTERNAL_SERVER_ERROR'].includes(code),
          });
        }
        if (!Object.hasOwn(result, 'result')) {
          throw new BitrixError('Битрикс вернул ответ без результата', { retryable: true });
        }
        limiter?.observeSuccess(limitMethod, result);
        return result;
      };
      return limiter ? limiter.schedule(limitMethod, send, { signal, deferStart: true }) : send();
    },
  };
}
