/** Ошибки API без адреса вебхука и переданных данных. */
export class BitrixError extends Error {
  constructor(message, { status, code, retryable = false } = {}) {
    super(message);
    this.name = 'BitrixError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Клиент входящего вебхука Битрикса. Сборщик сам управляет повторами. */
export function createBitrixClient({ baseUrl, fetchImpl = fetch, timeoutMs = 60_000 }) {
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
    async request(method, body = {}) {
      if (!/^[a-z][a-z0-9_.]*$/i.test(method)) {
        throw new Error('Недопустимое имя метода Битрикса');
      }

      let response;
      try {
        response = await fetchImpl(`${endpoint}/${method}.json`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new BitrixError('Не удалось связаться с Битриксом', { retryable: true });
      }

      if (!response.ok) {
        throw new BitrixError(`Битрикс вернул HTTP ${response.status}`, {
          status: response.status,
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
        const rawCode = String(result.error);
        const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(rawCode) ? rawCode : 'API';
        throw new BitrixError(`Битрикс вернул ошибку ${code}`, {
          code,
          retryable: ['QUERY_LIMIT_EXCEEDED', 'INTERNAL_SERVER_ERROR'].includes(code),
        });
      }
      if (!Object.hasOwn(result, 'result')) {
        throw new BitrixError('Битрикс вернул ответ без результата', { retryable: true });
      }
      return result;
    },
  };
}
