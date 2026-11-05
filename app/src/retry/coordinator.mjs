import { listPendingNightlies, resumeNightly, runDueNightly } from './nightly.mjs';
import { prepareRetryPlan } from './schedule.mjs';

// Один явный проход, без установки таймеров. Сначала восстанавливаем только
// реально сохранённые планы, затем рассматриваем текущий день по Новосибирску.
export async function runNightlyCycle({ pool, queue, bitrix, nowMs = Date.now() }) {
  const pending = await listPendingNightlies(pool);
  const resumed = [];
  for (const runDate of pending) resumed.push(await resumeNightly({ pool, queue, runDate }));
  const current = await runDueNightly({ pool, queue, nowMs,
    preparePlan: args => prepareRetryPlan({ pool, bitrix, ...args }),
  });
  return { resumed, current };
}
