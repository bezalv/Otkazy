export class PolzaError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'PolzaError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** Клиент модели. Количество попыток и задержка соответствуют прежним HTTP-нодам. */
export function createPolzaClient({
  apiKey,
  baseUrl = 'https://api.polza.ai/api/v1',
  fetchImpl = fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 180_000,
}) {
  if (!apiKey) throw new Error('Не задан ключ Polza');
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error('Недопустимый адрес Polza');
  }
  if (base.protocol !== 'https:') throw new Error('Для Polza требуется HTTPS');
  const endpoint = `${base.href.replace(/\/+$/, '')}/chat/completions`;

  return {
    async complete(body) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          let response;
          try {
            response = await fetchImpl(endpoint, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${apiKey}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(timeoutMs),
            });
          } catch {
            throw new PolzaError('Не удалось связаться с Polza', { retryable: true });
          }
          if (!response.ok) {
            throw new PolzaError(`Polza вернула HTTP ${response.status}`, {
              status: response.status,
              retryable: response.status === 429 || response.status >= 500,
            });
          }
          try {
            return await response.json();
          } catch {
            throw new PolzaError('Polza вернула некорректный JSON', { retryable: true });
          }
        } catch (error) {
          if (!error.retryable || attempt === 1) throw error;
          await wait(10_000);
        }
      }
    },
  };
}
