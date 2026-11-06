import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createDeadlinePool } from '../db/deadline-pool.mjs';
import { databaseConfig } from '../operator/triage.mjs';
import { startSttService } from '../stt/child.mjs';
import { loadPilotBaselines } from './candidates.mjs';
import { createPilotDependencies } from './dependencies.mjs';
import { createPilotRunner } from './index.mjs';
import { DIAGNOSTIC_CATEGORIES, DIAGNOSTIC_METHODS, DIAGNOSTIC_SOURCES, DIAGNOSTIC_MEDIA } from './diagnostics.mjs';

const STATUSES = new Set(['processed', 'waiting', 'skip', 'skipped', 'skipped_by_reason', 'blocked',
  'error', 'obsolete_transition', 'source_incomplete', 'unverified']);
const COMPARISONS = ['match', 'different', 'unavailable'];

export function parseSelectedIds(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 5) throw new TypeError('Нужно явно указать от одной до пяти сделок');
  const unique = new Set();
  return values.map(value => {
    if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || BigInt(value) > 2147483647n || unique.has(value)) {
      throw new TypeError('Некорректный список сделок');
    }
    unique.add(value);
    return Number(value);
  });
}

function counts() { return Object.fromEntries(COMPARISONS.map(key => [key, 0])); }
function namedCounts(names) { return Object.fromEntries(names.map(name => [name, 0])); }
const DEFAULT_DEADLINE_MS = 420000;
const MAX_DEADLINE_MS = 480000;
const CLOSE_GRACE_MS = 30000;
function deadlineError() { const error = new Error('Время пилота истекло'); error.code = 'PILOT_DEADLINE'; return error; }
function cleanupError() { const error = new Error('Завершение пилота не подтверждено'); error.code = 'PILOT_CLEANUP_UNKNOWN'; return error; }

function waitAbortable(promise, signal) {
  if (signal.aborted) return Promise.reject(deadlineError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(deadlineError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

async function confirmedClose(close, graceMs) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(cleanupError()), graceMs); });
  try { await Promise.race([Promise.resolve().then(close), deadline]); }
  catch { throw cleanupError(); }
  finally { clearTimeout(timer); }
}
function addDiagnostic(summary, value) {
  const category = DIAGNOSTIC_CATEGORIES.includes(value?.category) ? value.category : 'other';
  summary.categories[category]++;
  if (DIAGNOSTIC_METHODS.includes(value?.last_bitrix_method)) summary.last_bitrix_methods[value.last_bitrix_method]++;
  const status = value?.http_status;
  if (Number.isInteger(status) && status >= 400 && status <= 599) summary.http_statuses[String(status)] = (summary.http_statuses[String(status)] || 0) + 1;
  if (Array.isArray(value?.failed_sources)) {
    for (const name of new Set(value.failed_sources)) if (DIAGNOSTIC_SOURCES.includes(name)) summary.failed_sources[name]++;
  }
  for (const name of DIAGNOSTIC_MEDIA) {
    const count = value?.recognition_failures?.[name];
    if (Number.isSafeInteger(count) && count > 0 && count <= 10000) summary.recognition_failures[name] += count;
  }
}

/**
 * Только явно выбранные ID. Базу закрываем до анализа; очередь, HTTP-сервер
 * основного приложения и доставка не создаются. Для аудио временно запускается
 * отдельный STT на loopback. Возвращаем только сводные числа без фактов и текста.
 * Зависимости внедряются для синтетических тестов; в CLI используются реальные.
 */
export async function runPilotCommand({ ids, env = process.env,
  makePool = async config => { const { default: pg } = await import('pg'); return new pg.Pool(config); },
  readBaselines = loadPilotBaselines, startService = startSttService,
  makeDependencies = createPilotDependencies, makeRunner = createPilotRunner,
  readPrompts = async () => ({
    judgeSystemPrompt: await readFile(new URL('../../prompts/judge.md', import.meta.url), 'utf8'),
    writerSystemPrompt: await readFile(new URL('../../prompts/writer.md', import.meta.url), 'utf8'),
  }),
  deadlineMs = DEFAULT_DEADLINE_MS, closeGraceMs = CLOSE_GRACE_MS,
} = {}) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 10 || deadlineMs > MAX_DEADLINE_MS
      || !Number.isSafeInteger(closeGraceMs) || closeGraceMs < 10 || closeGraceMs > CLOSE_GRACE_MS) throw new TypeError('Некорректный срок пилота');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(deadlineError()), deadlineMs);
  const signal = controller.signal;
  let service, deps, pool, output, inFlight, expired = false, startedService = false;
  try {
    const selected = parseSelectedIds(ids);
    if (typeof env?.BITRIX_REST_BASE !== 'string' || !env.BITRIX_REST_BASE.trim()
        || typeof env?.POLZA_API_KEY !== 'string' || !env.POLZA_API_KEY.trim()) throw new Error('Не заданы параметры пилота');
    const config = databaseConfig(env);
    const openingPool = Promise.resolve().then(() => makePool(config));
    let raw;
    try { raw = await waitAbortable(openingPool, signal); }
    catch (error) {
      // Конструирование пула отозвать нельзя: если оно завершится после
      // deadline, закрываем ещё не использованный пул без ожидания сети.
      openingPool.then(late => late?.end?.()).catch(() => {});
      throw error;
    }
    raw.on?.('error', () => {});
    pool = createDeadlinePool(raw, { initializationSignal: signal });
    let originals;
    try { originals = await waitAbortable(readBaselines(pool, { dealIds: selected }), signal); }
    finally { const closing = pool; pool = null; await confirmedClose(() => closing.end(), closeGraceMs); }
    if (!originals || !Array.isArray(originals.baselines) || originals.baselines.length !== selected.length
        || !originals.audio_wait_enabled_at || originals.baselines.some((row, i) => Number(row.deal_id) !== selected[i])) {
      throw new Error('Эталоны пилота не подтверждены');
    }
    const prompts = await waitAbortable(readPrompts(), signal);
    signal.throwIfAborted();
    startedService = true;
    // startSttService следит за signal и сам закрывает процесс при отмене
    // во время запуска. Задавший собственный адаптер обязан делать то же.
    service = await startService({ polzaKey: env.POLZA_API_KEY, env, signal });
    signal.throwIfAborted();
    deps = makeDependencies({ bitrixBaseUrl: env.BITRIX_REST_BASE, polzaKey: env.POLZA_API_KEY,
      sttUrl: service.address, sttKey: service.key, tempRoot: service.tempRoot, signal });
    const runner = makeRunner({ ...deps, ...prompts, signal });
    output = { selected: selected.length, attempted: 0, statuses: {}, verdict: counts(),
      reason_class: counts(), exact_facts: counts(), screenshots_enabled: true,
      diagnostics: { categories: namedCounts(DIAGNOSTIC_CATEGORIES), last_bitrix_methods: namedCounts(DIAGNOSTIC_METHODS),
        failed_sources: namedCounts(DIAGNOSTIC_SOURCES), recognition_failures: namedCounts(DIAGNOSTIC_MEDIA), http_statuses: {} },
      limitations: ['legacy_origin_unverified', 'current_card_may_have_changed', 'historical_inputs_may_have_changed', 'historical_transition_not_verified',
        'model_responses_are_nondeterministic', 'semantic_equivalence_not_established'] };
    for (const baseline of originals.baselines) {
      let result;
      try {
        const task = Promise.resolve().then(() => runner.run({ dealId: baseline.deal_id,
          baseline: { ...baseline, audio_wait_enabled_at: originals.audio_wait_enabled_at }, screenshots: true }));
        inFlight = task.then(() => {}, () => {});
        result = await waitAbortable(task, signal);
        inFlight = null;
      }
      catch (error) { if (signal.aborted) throw error;
        output.statuses.error = (output.statuses.error || 0) + 1; output.attempted++;
        addDiagnostic(output.diagnostics, { category: 'processing_exception' });
        output.verdict.unavailable++; output.reason_class.unavailable++; output.exact_facts.unavailable++;
        break; }
      output.attempted++;
      addDiagnostic(output.diagnostics, result?.diagnostic);
      const status = STATUSES.has(result?.status) ? result.status : 'other';
      output.statuses[status] = (output.statuses[status] || 0) + 1;
      for (const [field, value] of [['verdict', result?.verdict], ['reason_class', result?.reason_class], ['exact_facts', result?.facts?.exact]]) {
        output[field][COMPARISONS.includes(value) ? value : 'unavailable']++;
      }
      // Ошибка или неподтверждённый случай требуют разбора до следующего вызова.
      if (['error', 'unverified', 'blocked', 'source_incomplete', 'other'].includes(status)) break;
    }
    signal.throwIfAborted();
  } catch (error) {
    if (error?.code === 'PILOT_CLEANUP_UNKNOWN') throw error;
    if (!signal.aborted) throw error;
    expired = true;
  } finally {
    try {
      try { deps?.close(); }
      finally {
        // Сам факт timeout в Promise.race не является подтверждением закрытия.
        // Маркер ставим только после успешного возврата close() и проверки группы.
        if (service) await confirmedClose(() => service.close(), closeGraceMs);
        if (pool) await confirmedClose(() => pool.end(), closeGraceMs);
        // После дедлайна ждём и сам прерванный анализ. Зависший адаптер не
        // превращается в подтверждённое безопасное завершение.
        if (signal.aborted && inFlight) await confirmedClose(() => inFlight, Math.min(closeGraceMs, 5000));
      }
    } finally { clearTimeout(timer); }
  }
  if (expired) return { status: 'deadline', deadline_ms: deadlineMs,
    ...(service ? { service_closed: true } : { service_state: startedService ? 'startup_not_confirmed' : 'not_started' }) };
  return { ...output, service_closed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPilotCommand({ ids: process.argv.slice(2) }).then(result => console.log(JSON.stringify(result))).catch(error => {
    if (error?.code === 'PILOT_CLEANUP_UNKNOWN') console.error('Завершение ресурсов пилота не подтверждено; необходима ручная проверка');
    else console.error('Не удалось выполнить пилот; проверка остановлена');
    process.exitCode = 1;
  });
}
