import { createBitrixClient } from '../bitrix-client.mjs';
import { createPolzaClient } from '../polza-client.mjs';
import { createSttClient } from '../stt-client.mjs';
import { createJobQueue } from '../queue/index.mjs';
import { createDelivery } from '../delivery/index.mjs';
import { downloadFile } from '../media/download.mjs';
import { createWorkerPump } from './pump.mjs';
import { isAbsolute } from 'node:path';

// Только сборка зависимостей: не открывает соединение и не запускает обработку.
export function createWorkerDependencies({ pool, bitrixBaseUrl, polzaKey, sttUrl, sttKey, tempRoot, judgePrompt, writerPrompt, bitrixLimiter, fetchImpl = globalThis.fetch }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('Не задан пул базы');
  if (typeof judgePrompt !== 'string' || !judgePrompt.trim() || typeof writerPrompt !== 'string' || !writerPrompt.trim()) {
    throw new TypeError('Не заданы промпты анализа');
  }
  if (typeof tempRoot !== 'string' || !isAbsolute(tempRoot)) throw new TypeError('Не задан изолированный временный каталог');
  const bitrix = createBitrixClient({ baseUrl: bitrixBaseUrl, fetchImpl, limiter: bitrixLimiter });
  const llm = createPolzaClient({ apiKey: polzaKey, fetchImpl });
  const transcribe = createSttClient({ bitrix, sttUrl, sttKey, tempRoot, fetchImpl });
  const queue = createJobQueue(pool);
  const delivery = createDelivery(pool, bitrix);
  const pump = createWorkerPump({ pool, queue,
    delivery: ({ job }) => delivery.deliver(job.id, job.lease_token),
    processOptions: {
      bitrix, llm, transcribe,
      judgeSystemPrompt: judgePrompt, writerSystemPrompt: writerPrompt,
      resolveFile: id => bitrix.request('disk.file.get', { id }),
      downloadFile: (url, options) => downloadFile(url, { ...options, fetchImpl }),
    },
  });
  return { pump, queue, bitrix };
}
