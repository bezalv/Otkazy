import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDeadlinePool } from '../db/deadline-pool.mjs';
import { databaseConfig } from '../operator/triage.mjs';
import { createPolzaClient } from '../polza-client.mjs';
import { loadPilotBaselines } from './candidates.mjs';
import { replaySavedFacts } from './saved-facts.mjs';

const VERDICTS = new Set(['правомерен', 'неправомерен', 'недостаточно_данных']);
const CLASSES = new Set(['price', 'competitor', 'no_need', 'no_money', 'timing', 'manager_dropped', 'customer_unreachable', 'regulatory', 'other']);
const LIMITATIONS = ['saved_facts_only', 'collection_and_transcription_not_tested', 'historical_source_unverified',
  'model_responses_are_nondeterministic', 'semantic_equivalence_not_established'];

function deadlineError() { const error = new Error('Время проверки истекло'); error.code = 'REPLAY_DEADLINE'; return error; }
function cleanupError() { const error = new Error('Завершение ресурсов не подтверждено'); error.code = 'REPLAY_CLEANUP_UNKNOWN'; return error; }

function waitAbortable(task, signal) {
  if (signal.aborted) return Promise.reject(deadlineError());
  return new Promise((resolvePromise, rejectPromise) => {
    const abort = () => rejectPromise(deadlineError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(task).then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

async function confirmedClose(action, graceMs) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(cleanupError()), graceMs); });
  try { await Promise.race([Promise.resolve().then(action), deadline]); }
  catch { throw cleanupError(); }
  finally { clearTimeout(timer); }
}

export function createSavedReplayClient({ apiKey, signal, fetchImpl = fetch, onCleanupUnknown = () => {},
  wait = ms => delay(ms, undefined, { signal }) }) {
  const cancelBody = async response => {
    try { await response.body?.cancel?.(); }
    catch { onCleanupUnknown(); }
  };
  const guardedFetch = async (url, options = {}) => {
    signal.throwIfAborted();
    const response = await fetchImpl(url, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal });
    if (!response.ok) {
      // Общий клиент Polza на ошибочном HTTP не читает тело. До перехода к
      // повтору явно останавливаем поток и учитываем неподтверждённое закрытие.
      await cancelBody(response);
      return response;
    }
    return { ok: response.ok, status: response.status, async json() {
      try { return await response.json(); }
      catch (error) { await cancelBody(response); throw error; }
    } };
  };
  return createPolzaClient({ apiKey, fetchImpl: guardedFetch, wait });
}

function resultValue(value, allowed) { return allowed.has(value) ? value : null; }
function comparison(previous, current) { return previous == null || current == null ? 'unavailable' : previous === current ? 'match' : 'different'; }
function safeResult(result) {
  const status = ['processed', 'error', 'unknown'].includes(result?.status) ? result.status : 'unknown';
  const previousVerdict = resultValue(result?.verdict?.previous, VERDICTS), currentVerdict = resultValue(result?.verdict?.current, VERDICTS);
  const previousClass = resultValue(result?.reason_class?.previous, CLASSES), currentClass = resultValue(result?.reason_class?.current, CLASSES);
  const safeCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : null;
  return { scope: 'saved_facts_only', status,
    verdict: { previous: previousVerdict, current: currentVerdict, comparison: comparison(previousVerdict, currentVerdict) },
    reason_class: { previous: previousClass, current: currentClass, comparison: comparison(previousClass, currentClass) },
    facts_count: safeCount(result?.facts_count), model_calls: { judge: safeCount(result?.model_calls?.judge), writer: safeCount(result?.model_calls?.writer) },
    proof_errors_count: safeCount(result?.proof_errors_count), limitations: [...LIMITATIONS] };
}

/** Одна сделка, сохранённые факты, только READ ONLY и явные запросы модели. */
export async function runSavedReplayCommand({ id, analysisId, env = process.env,
  makePool = async config => { const { default: pg } = await import('pg'); return new pg.Pool(config); },
  readBaselines = loadPilotBaselines, makeClient = createSavedReplayClient, replay = replaySavedFacts,
  readPrompts = async () => ({ judgeSystemPrompt: await readFile(new URL('../../prompts/judge.md', import.meta.url), 'utf8'),
    writerSystemPrompt: await readFile(new URL('../../prompts/writer.md', import.meta.url), 'utf8') }),
  deadlineMs = 420000, closeGraceMs = 30000,
} = {}) {
  if (typeof id !== 'string' || !/^[1-9]\d{0,9}$/.test(id) || BigInt(id) > 2147483647n) throw new TypeError('Укажите одну корректную сделку');
  if (typeof analysisId !== 'string' || !/^[1-9]\d{0,18}$/.test(analysisId) || BigInt(analysisId) > 9223372036854775807n) {
    throw new TypeError('Укажите один корректный ID эталонного разбора');
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 10 || deadlineMs > 480000
      || !Number.isSafeInteger(closeGraceMs) || closeGraceMs < 10 || closeGraceMs > 30000) throw new TypeError('Некорректный срок');
  if (typeof env?.POLZA_API_KEY !== 'string' || !env.POLZA_API_KEY.trim()) throw new Error('Не задан ключ модели');
  const controller = new AbortController(), signal = controller.signal;
  const timer = setTimeout(() => controller.abort(deadlineError()), deadlineMs);
  let pool, dbTask, replayTask, promptTask, expired = false, failed = false, modelCleanupUnknown = false, output;
  try {
    const config = databaseConfig(env);
    const opening = Promise.resolve().then(() => makePool(config));
    let raw;
    try { raw = await waitAbortable(opening, signal); }
    catch (error) {
      await confirmedClose(() => opening.then(late => late?.end?.(), () => {}), closeGraceMs);
      throw error;
    }
    raw.on?.('error', () => {});
    pool = createDeadlinePool(raw, { initializationSignal: signal });
    dbTask = Promise.resolve().then(() => readBaselines(pool, { dealIds: [Number(id)] }));
    const data = await waitAbortable(dbTask, signal);
    if (!data || !Array.isArray(data.baselines) || data.baselines.length !== 1 || Number(data.baselines[0].deal_id) !== Number(id)
        || String(data.baselines[0].analysis_id) !== analysisId) {
      throw new Error('Эталон не подтверждён');
    }
    const closing = pool;
    await confirmedClose(() => closing.end(), closeGraceMs);
    pool = null;
    signal.throwIfAborted();
    promptTask = Promise.resolve().then(() => readPrompts());
    const prompts = await waitAbortable(promptTask, signal);
    const baseline = data.baselines[0];
    const at = new Date(baseline.processed_at).getTime();
    if (!Number.isFinite(at) || !VERDICTS.has(baseline.ai_verdict)) throw new Error('Эталон не подтверждён');
    const client = makeClient({ apiKey: env.POLZA_API_KEY, signal, onCleanupUnknown() { modelCleanupUnknown = true; } });
    replayTask = Promise.resolve().then(() => replay({ packet: baseline.ai_facts_json,
      golden: { judge: { verdict: baseline.ai_verdict, closure_reason_class: baseline.ai_reason_class } },
      judgeSystemPrompt: prompts.judgeSystemPrompt, writerSystemPrompt: prompts.writerSystemPrompt, client, now: at }));
    output = safeResult(await waitAbortable(replayTask, signal));
    signal.throwIfAborted();
  } catch (error) {
    if (error?.code === 'REPLAY_CLEANUP_UNKNOWN') throw error;
    if (signal.aborted) expired = true;
    else failed = true;
  } finally {
    try {
      if (pool) await confirmedClose(async () => { if (dbTask) await dbTask.catch(() => {}); await pool.end(); }, closeGraceMs);
      if (signal.aborted && promptTask) await confirmedClose(() => promptTask.catch(() => {}), closeGraceMs);
      if (signal.aborted && replayTask) await confirmedClose(() => replayTask.catch(() => {}), closeGraceMs);
      if (modelCleanupUnknown) throw cleanupError();
    } finally { clearTimeout(timer); }
  }
  return expired || failed ? { status: expired ? 'deadline' : 'error', resources_closed: true, limitations: [...LIMITATIONS] }
    : { ...output, resources_closed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    console.error('Укажите одну сделку и один ID эталонного разбора');
    process.exitCode = 1;
  } else {
    runSavedReplayCommand({ id: process.argv[2], analysisId: process.argv[3] }).then(result => console.log(JSON.stringify(result))).catch(error => {
      console.error(error?.code === 'REPLAY_CLEANUP_UNKNOWN' ? 'Завершение ресурсов не подтверждено' : 'Сравнение не выполнено');
      process.exitCode = 1;
    });
  }
}
