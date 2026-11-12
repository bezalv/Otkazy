import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { startSttService } from './stt/child.mjs';
import { createWorkerDependencies } from './worker/dependencies.mjs';
import { runNightlyCycle } from './retry/coordinator.mjs';
import { checkRuntime } from './server.mjs';

/** Явная подготовка runtime. Не подключается к БД и не запускает расписания. */
export async function prepareRuntime({ pool, bitrixBaseUrl, polzaKey, bitrixLimiter, deliveryMode = 'production', fetchImpl = globalThis.fetch,
  startStt = startSttService, checkTools = checkRuntime, makeDependencies = createWorkerDependencies,
  loadText = path => readFile(path, 'utf8') }) {
  const [judgePrompt, writerPrompt] = await Promise.all([
    loadText(new URL('../prompts/judge.md', import.meta.url)),
    loadText(new URL('../prompts/writer.md', import.meta.url)),
  ]);
  if (!judgePrompt?.trim() || !writerPrompt?.trim()) throw new Error('Промпты приложения не подготовлены');
  if (!(await checkTools()).ok) throw new Error('Аудиоинструменты или версия Node недоступны');
  const stt = await startStt({ polzaKey });
  try {
    if (typeof stt.healthy !== 'function' || typeof stt.close !== 'function') throw new Error('Не задан контроль сервиса распознавания');
    const dependencies = makeDependencies({ pool, bitrixBaseUrl, polzaKey,
      sttUrl: stt.address, sttKey: stt.key, tempRoot: stt.tempRoot, judgePrompt, writerPrompt, fetchImpl, bitrixLimiter, deliveryMode });
    const active = new Set();
    let closing = false;
    let drainPromise;
    function run(action) {
      if (closing) return Promise.reject(new Error('Приложение завершает работу'));
      const promise = (async () => {
        if (!await stt.healthy()) return { status: 'stt_unavailable' };
        return action();
      })();
      active.add(promise);
      promise.finally(() => active.delete(promise)).catch(() => {});
      return promise;
    }
    return {
      tick: () => run(() => dependencies.pump.tick()),
      nightly: nowMs => run(() => runNightlyCycle({ pool, queue: dependencies.queue, bitrix: dependencies.bitrix, nowMs })),
      async close({ graceMs = 25000 } = {}) {
        if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 300000) throw new TypeError('Некорректный срок завершения');
        if (!drainPromise) {
          closing = true;
          drainPromise = (async () => { await Promise.allSettled([...active]); await stt.close(); })();
          // После таймаута процесс может завершиться позже, в том числе с ошибкой очистки.
          drainPromise.catch(() => {});
        }
        const timer = new AbortController();
        try {
          return await Promise.race([
            drainPromise.then(() => ({ status: 'drained' })),
            delay(graceMs, undefined, { signal: timer.signal }).then(() => ({ status: 'timeout' })),
          ]);
        } finally { timer.abort(); }
      },
    };
  } catch (error) {
    await stt.close();
    throw error;
  }
}
