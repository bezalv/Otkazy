import { enqueueDueAudioChecks, loadAudioWait, loadAudioWaitEnabledAt } from '../audio-wait/scheduler.mjs';
import { loadResumableResult, persistResult } from '../persistence/index.mjs';
import { runJob } from './run-job.mjs';
import { savePrejudgeArtifact, hasPrejudgeArtifacts, hasUnsafePrejudgeResume, markPrejudgeNeedsReview } from '../persistence/prejudge.mjs';
import { claimSttAttempt, completeSttAttempt } from '../persistence/stt-attempts.mjs';

// Один явный такт. Модуль сам не создаёт таймер и не начинает обработку при импорте.
export function createWorkerPump({ pool, queue, processOptions, delivery, createRoleInference, operations = {} }) {
  if (!pool || !queue || !processOptions) throw new TypeError('Не заданы зависимости обработчика');
  const recover = operations.recover || (() => queue.recoverExpired());
  const schedule = operations.schedule || (() => enqueueDueAudioChecks(pool));
  const getEnabledAt = operations.getEnabledAt || (() => loadAudioWaitEnabledAt(pool));
  const claim = operations.claim || (() => queue.claim());
  const execute = operations.execute || runJob;
  let running = false;
  return {
    async tick() {
      if (running) return { status: 'busy' };
      running = true;
      try {
        await recover();
        const enqueued = await schedule();
        // При недоступной конфигурации задание ещё не захвачено.
        const audioWaitEnabledAt = await getEnabledAt();
        const job = await claim();
        if (!job) return { status: 'idle', enqueued: enqueued.length };
        const result = await execute({ job, queue,
          store: { loadResumableResult: args => loadResumableResult(pool, args), persistResult: result => persistResult(pool, result),
            ...(processOptions.persistInputsBeforeJudge === true ? {
              savePrejudgeArtifact:args => savePrejudgeArtifact(pool,args),
              hasPrejudgeArtifacts:args => hasPrejudgeArtifacts(pool,args),
              hasUnsafePrejudgeResume:args => hasUnsafePrejudgeResume(pool,args),
              claimSttAttempt:args => claimSttAttempt(pool,args),
              completeSttAttempt:args => completeSttAttempt(pool,args),
              markPrejudgeNeedsReview:args => markPrejudgeNeedsReview(pool,args),
            } : {}) },
          loadAudioWait: item => loadAudioWait(pool, item),
          delivery,
          ...(createRoleInference ? {createRoleInference} : {}),
          processOptions: { ...processOptions, audioWaitEnabledAt },
        });
        return { status: 'handled', enqueued: enqueued.length, result };
      } finally { running = false; }
    },
  };
}
