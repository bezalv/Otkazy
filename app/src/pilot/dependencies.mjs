import { isAbsolute } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createBitrixClient } from '../bitrix-client.mjs';
import { createBitrixLimiter } from '../bitrix-limiter.mjs';
import { createPolzaClient } from '../polza-client.mjs';
import { createSttClient } from '../stt-client.mjs';
import { downloadFile } from '../media/download.mjs';
import { readonlyBitrix } from './index.mjs';

/** Конструирует адаптеры, но не соединяется с сетью и не запускает STT/сервер. */
export function createPilotDependencies({ bitrixBaseUrl, polzaKey, sttUrl, sttKey, tempRoot, signal, fetchImpl = globalThis.fetch }) {
  if (typeof tempRoot !== 'string' || !isAbsolute(tempRoot)) throw new TypeError('Не задан временный каталог');
  if (signal && (typeof signal.throwIfAborted !== 'function' || typeof signal.addEventListener !== 'function')) throw new TypeError('Некорректный сигнал остановки');
  const combined = other => signal && other ? AbortSignal.any([signal, other]) : signal || other;
  const guardedFetch = (url, options = {}) => {
    signal?.throwIfAborted();
    return fetchImpl(url, { ...options, signal: combined(options.signal) });
  };
  const guardedRequest = (url, options, callback) => {
    signal?.throwIfAborted();
    return httpRequest(url, { ...options, signal: combined(options.signal) }, callback);
  };
  const limiter = createBitrixLimiter();
  const client = createBitrixClient({ baseUrl: bitrixBaseUrl, fetchImpl: guardedFetch, limiter });
  const bitrix = readonlyBitrix({ request(method, body, options = {}) {
    signal?.throwIfAborted();
    return client.request(method, body, { ...options, signal: combined(options.signal) });
  } });
  const model = createPolzaClient({ apiKey: polzaKey, fetchImpl: guardedFetch,
    ...(signal ? { wait: ms => delay(ms, undefined, { signal }) } : {}) });
  const llm = { async complete(...args) {
    signal?.throwIfAborted();
    const result = await model.complete(...args);
    signal?.throwIfAborted();
    return result;
  } };
  const recognize = createSttClient({ bitrix, sttUrl, sttKey, tempRoot, fetchImpl: guardedFetch,
    ...(signal ? { reserveRequest: guardedRequest } : {}) });
  const transcribe = async (...args) => {
    signal?.throwIfAborted();
    const result = await recognize(...args);
    signal?.throwIfAborted();
    return result;
  };
  return Object.freeze({ bitrix, llm, transcribe,
    downloadFile: async (url, options) => {
      signal?.throwIfAborted();
      const result = await downloadFile(url, { ...options, fetchImpl: guardedFetch });
      signal?.throwIfAborted();
      return result;
    },
    close() { limiter.close(); },
  });
}
