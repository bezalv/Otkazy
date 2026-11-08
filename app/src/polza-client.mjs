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

/**
 * Отдельный клиент для определения авторов в одной обработке сделки.
 * Создаётся заново для каждого задания; сам по себе ничего не запускает.
 * Повтор после ошибки запрещён: отсутствие ответа не доказывает, что
 * провайдер не выполнил запрос. Счётчик учитывает начатые HTTP-запросы.
 * Данные стоимости намеренно не выводятся: синхронный ответ модели может
 * не содержать цены, а статистика токенов не является суммой списания.
 */
export function createPolzaRoleInferenceClient({
  apiKey,
  baseUrl = 'https://api.polza.ai/api/v1',
  fetchImpl = fetch,
  timeoutMs = 180_000,
  maxRequests = 3,
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Не задан ключ Polza');
  if (typeof fetchImpl !== 'function') throw new TypeError('Не задан транспорт Polza');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new TypeError('Некорректный таймаут Polza');
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 3) throw new TypeError('Некорректный предел запросов');
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error('Недопустимый адрес Polza'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Недопустимый адрес Polza');
  const endpoint = `${base.href.replace(/\/+$/, '')}/chat/completions`;
  let started = 0, completed = 0, inFlight = false, uncertain = false;
  return Object.freeze({
    // Вызывающий запечатывает экземпляр при ошибке проверки содержимого,
    // которую транспорт не может обнаружить (например, конфликт автора с
    // подтверждённым участником). Метод не принимает и не хранит данные.
    failClosed() { uncertain = true; },
    snapshot() {
      return Object.freeze({ physical_requests_started: started, responses_received: completed,
        in_flight: inFlight, uncertain_outcome: uncertain, cost: 'unknown' });
    },
    async complete(body, options = {}) {
      if (options?.role !== 'chat-role-inference') throw new Error('Разрешено только определение автора');
      if (uncertain) throw new Error('Исход предыдущего запроса не подтверждён');
      if (inFlight) throw new Error('Параллельные запросы определения автора запрещены');
      if (started >= maxRequests) throw new Error('Исчерпан предел запросов определения автора');
      const provider = body?.provider;
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.model !== 'openai/gpt-6-sol'
          || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 5000
          || !provider || typeof provider !== 'object' || Array.isArray(provider)
          || Object.keys(provider).sort().join(',') !== 'allow_fallbacks,order' || provider.allow_fallbacks !== true
          || !Array.isArray(provider.order) || provider.order.length !== 2
          || provider.order[0] !== 'openai/flex' || provider.order[1] !== 'openai') {
        throw new Error('Параметры модели определения автора запрещены');
      }
      let encoded;
      try { encoded = JSON.stringify(body); } catch { throw new Error('Некорректный запрос модели'); }
      if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > 100_000) throw new Error('Некорректный запрос модели');
      // Устанавливаем блокировку и резервируем попытку до вызова fetch,
      // включая случай синхронного исключения внутри переданного транспорта.
      inFlight = true;
      started++;
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: encoded,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response?.ok) throw new Error('Ответ провайдера не принят');
        const result = await response.json();
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Некорректный ответ');
        const choice = result.choices?.[0];
        if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') throw new Error('Неполный ответ');
        const content = JSON.parse(choice.message.content);
        if (!content || typeof content !== 'object' || Array.isArray(content) || !Array.isArray(content.roles)) throw new Error('Некорректный ответ');
        if (uncertain) throw new Error('Транспорт закрыт');
        completed++;
        return result;
      } catch {
        // Даже при HTTP-ошибке или ошибке разбора возможен расход на стороне
        // провайдера, поэтому в рамках задания дальнейшие попытки запрещены.
        uncertain = true;
        throw new PolzaError('Исход запроса определения автора не подтверждён');
      } finally {
        inFlight = false;
      }
    },
  });
}
