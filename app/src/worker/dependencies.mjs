import { createBitrixClient } from '../bitrix-client.mjs';
import { createPolzaClient, createPolzaRoleInferenceClient } from '../polza-client.mjs';
import { createSttClient } from '../stt-client.mjs';
import { createJobQueue } from '../queue/index.mjs';
import { createDelivery } from '../delivery/index.mjs';
import { downloadFile } from '../media/download.mjs';
import { createWorkerPump } from './pump.mjs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRoleSessionContext } from './role-session-context.mjs';
import { createRoleInferenceLedger } from './role-inference-ledger.mjs';
import { createDurableRoleClient } from './durable-role-client.mjs';
import { exactMillisTimestamp } from '../time-precision.mjs';
import { enqueueDueAudioChecks } from '../audio-wait/scheduler.mjs';

// Версия политики привязана к фактическому коду распознавания и адаптера.
// При изменении сегментации либо модели старые результаты не переиспользуются.
function sttAttemptPolicy() {
  const hash = createHash('sha256').update('otkazy-gigaam-stt-policy-v1\0');
  for (const name of ['../stt/server.cjs', '../stt/child.mjs', '../stt-client.mjs']) {
    const content = readFileSync(new URL(name, import.meta.url));
    hash.update(`${name}\0${content.length}\0`).update(content);
  }
  return { sha256: hash.digest('hex'), expectedEngine: 'reserve:gigaam' };
}

// Только сборка зависимостей: не открывает соединение и не запускает обработку.
export function createWorkerDependencies({ pool, bitrixBaseUrl, polzaKey, sttUrl, sttKey, tempRoot, judgePrompt, writerPrompt, bitrixLimiter, deliveryMode = 'production', pilotEnabledAt = null, fetchImpl = globalThis.fetch, makePump = createWorkerPump }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('Не задан пул базы');
  if (typeof judgePrompt !== 'string' || !judgePrompt.trim() || typeof writerPrompt !== 'string' || !writerPrompt.trim()) {
    throw new TypeError('Не заданы промпты анализа');
  }
  if (typeof tempRoot !== 'string' || !isAbsolute(tempRoot)) throw new TypeError('Не задан изолированный временный каталог');
  const bitrix = createBitrixClient({ baseUrl: bitrixBaseUrl, fetchImpl, limiter: bitrixLimiter });
  const llm = createPolzaClient({ apiKey: polzaKey, fetchImpl });
  const transcribe = createSttClient({ bitrix, sttUrl, sttKey, tempRoot, fetchImpl });
  if ((deliveryMode === 'pilot65') !== (pilotEnabledAt !== null)) throw new TypeError('Не задана граница пилота');
  const queue = createJobQueue(pool, { pilotEnabledAt });
  const delivery = createDelivery(pool, bitrix, { mode: deliveryMode });
  // Фабрика не делает сетевых запросов; роль не отправляется без
  // подтверждения исходного перехода, сессии и действующей аренды.
  const createRoleInference = ({job,stageScope,checkLease}) => {
    const cutoff=exactMillisTimestamp(stageScope.loseDate);
    if (!cutoff) throw new TypeError('Не установлена точная дата отказа');
    const from=new Date(cutoff.getTime()-365*24*60*60*1000).toISOString();
    const sessionContext=createRoleSessionContext({client:bitrix,dealId:String(job.deal_id),
      transitionId:stageScope.stageHistoryId,cutoff:cutoff.toISOString(),from});
    const ledger=createRoleInferenceLedger(pool,{jobId:job.id,leaseToken:job.lease_token,
      dealId:String(job.deal_id),stageHistoryId:stageScope.stageHistoryId,cutoff:cutoff.toISOString()});
    const transport=createPolzaRoleInferenceClient({apiKey:polzaKey,fetchImpl});
    return {sessionContext,roleClient:createDurableRoleClient({ledger,sessionContext,transport,checkLease})};
  };
  const pump = makePump({ pool, queue,
    ...(pilotEnabledAt ? { operations:{schedule:() => enqueueDueAudioChecks(pool,{pilotEnabledAt})} } : {}),
    createRoleInference,
    delivery: ({ job }) => delivery.deliver(job.id, job.lease_token),
    processOptions: {
      bitrix, llm, transcribe,
      persistInputsBeforeJudge: true, sttAttemptPolicy: sttAttemptPolicy(),
      judgeSystemPrompt: judgePrompt, writerSystemPrompt: writerPrompt,
      resolveFile: id => bitrix.request('disk.file.get', { id }),
      downloadFile: (url, options) => downloadFile(url, { ...options, fetchImpl }),
    },
  });
  return { pump, queue, bitrix };
}
