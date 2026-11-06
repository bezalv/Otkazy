import { isAbsolute } from 'node:path';
import { createBitrixClient } from '../bitrix-client.mjs';
import { createBitrixLimiter } from '../bitrix-limiter.mjs';
import { createPolzaClient } from '../polza-client.mjs';
import { createSttClient } from '../stt-client.mjs';
import { downloadFile } from '../media/download.mjs';
import { readonlyBitrix } from './index.mjs';

/** Конструирует адаптеры, но не соединяется с сетью и не запускает STT/сервер. */
export function createPilotDependencies({ bitrixBaseUrl, polzaKey, sttUrl, sttKey, tempRoot, fetchImpl = globalThis.fetch }) {
  if (typeof tempRoot !== 'string' || !isAbsolute(tempRoot)) throw new TypeError('Не задан временный каталог');
  const limiter = createBitrixLimiter();
  const bitrix = readonlyBitrix(createBitrixClient({ baseUrl: bitrixBaseUrl, fetchImpl, limiter }));
  const llm = createPolzaClient({ apiKey: polzaKey, fetchImpl });
  const transcribe = createSttClient({ bitrix, sttUrl, sttKey, tempRoot, fetchImpl });
  return Object.freeze({ bitrix, llm, transcribe,
    downloadFile: (url, options) => downloadFile(url, { ...options, fetchImpl }),
    close() { limiter.close(); },
  });
}
