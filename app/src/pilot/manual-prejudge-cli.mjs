// Явная ручная команда. Не запускает очередь, сервер приложения и доставку.
// Тестовый бюджет и доступы задаются вызывающим окружением, не аргументами.
import { open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createDeadlinePool } from '../db/deadline-pool.mjs';
import { databaseConfig } from '../operator/triage.mjs';
import { createPolzaBudgetGuard } from './polza-budget.mjs';
import { createPilotDependencies } from './dependencies.mjs';
import { loadPilotBaselines } from './candidates.mjs';
import { runManualPrejudge } from './manual-prejudge.mjs';
import { startSttService } from '../stt/child.mjs';
import { exactMillisTimestamp } from '../time-precision.mjs';

const ROLES = new Set(['judge', 'writer', 'screenshots']);
const STATUS = new Set(['processed', 'blocked', 'error', 'waiting', 'skip', 'skipped', 'skipped_by_reason', 'obsolete_transition', 'source_incomplete']);
const VERDICTS = new Set(['правомерен', 'неправомерен', 'недостаточно_данных']);

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Не задан ${name}`);
  return value.trim();
}
function money(value, name, allowZero = false) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)) throw new TypeError(`Некорректный ${name}`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw new TypeError(`Некорректный ${name}`);
  return n;
}
function integer(value, name, max) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new TypeError(`Некорректный ${name}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > max) throw new TypeError(`Некорректный ${name}`);
  return n;
}
function tempPath(value, name, root = resolve('tmp')) {
  const p = resolve(required(value, name));
  const rel = relative(root, p);
  if (!isAbsolute(p) || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError(`Некорректный ${name}`);
  return p;
}

/** Явно выбранный переход и параметры тестового бюджета; секреты не возвращаются в отчёте. */
export function parseManualPrejudgeOptions(args, env = process.env) {
  if (!Array.isArray(args) || args.length !== 3) throw new TypeError('Нужны ID сделки, ID перехода и время отказа');
  const dealId = integer(args[0], 'ID сделки', 2147483647);
  if (!/^[1-9]\d{0,29}$/.test(args[1] || '') || !exactMillisTimestamp(args[2])) throw new TypeError('Некорректный переход');
  const databaseUrl = required(env.DATABASE_URL, 'DATABASE_URL');
  const bitrixBaseUrl = required(env.BITRIX_REST_BASE, 'BITRIX_REST_BASE');
  const polzaKey = required(env.POLZA_API_KEY, 'POLZA_API_KEY');
  const baselineRub = money(env.TEST_POLZA_BASELINE_RUB, 'исходный расход', true);
  const priorReservedRub = money(env.TEST_POLZA_PRIOR_RESERVED_RUB, 'предыдущий резерв', true);
  const limitRub = money(env.TEST_POLZA_LIMIT_RUB, 'предел теста');
  const sttReserveRub = money(env.TEST_POLZA_STT_RESERVE_RUB, 'резерв STT');
  const modelReserveRub = money(env.TEST_POLZA_MODEL_RESERVE_RUB, 'резерв модели');
  const maxSttParts = integer(env.TEST_POLZA_MAX_STT_PARTS, 'предел фрагментов', 10000);
  const lock = tempPath(env.TEST_POLZA_LOCK_PATH, 'путь блокировки');
  const journal = tempPath(env.TEST_POLZA_JOURNAL_PATH, 'путь журнала');
  if (lock === journal || limitRub > 500 || priorReservedRub >= limitRub || sttReserveRub > limitRub || modelReserveRub > limitRub) {
    throw new TypeError('Некорректные ограничения теста');
  }
  return { dealId, stageHistoryId:args[1], loseDate:args[2], databaseUrl, bitrixBaseUrl, polzaKey,
    baselineRub, priorReservedRub, limitRub, sttReserveRub, modelReserveRub, maxSttParts, lock, journal };
}

async function boundedJson(response, signal, max = 2 * 1024 * 1024) {
  if (!response?.body) throw new Error('Пустой ответ сервиса');
  let size = 0; const parts = [];
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted(); const b = Buffer.from(chunk); size += b.length;
      if (size > max) { b.fill(0); throw new Error('Слишком большой ответ сервиса'); }
      parts.push(b);
    }
    return JSON.parse(Buffer.concat(parts, size).toString('utf8'));
  } finally { for (const b of parts) b.fill(0); }
}

/** Все вызовы Polza в этом ручном запуске проходят через один бюджет. */
export function createManualPaidAdapters({ key, guard, signal, fetchImpl = fetch, sttReserveRub, modelReserveRub, maxSttParts }) {
  if (typeof key !== 'string' || !key || !guard?.run || !guard?.runUnpricedAudio || !signal?.throwIfAborted
      || typeof fetchImpl !== 'function' || !Number.isSafeInteger(maxSttParts) || maxSttParts < 1) throw new TypeError('Бюджетный транспорт не задан');
  let parts = 0; const calls = { judge:0, writer:0, screenshots:0 };
  const transcribe = async ({ audio, model, signal: inner }) => {
    if (!Buffer.isBuffer(audio) || audio.length < 1 || audio.length > 1024 * 1024 || model !== 'ai-sage/gigaam-v3'
        || !inner?.throwIfAborted || ++parts > maxSttParts) throw new Error('Аудиофрагмент не допущен');
    const result = await guard.runUnpricedAudio(sttReserveRub, async ({ signal: budgetSignal }) => {
      const combined = AbortSignal.any([signal, inner, budgetSignal, AbortSignal.timeout(180000)]);
      const form = new FormData(); form.append('model', model); form.append('language', 'ru');
      form.append('file', new Blob([audio], { type:'audio/mpeg' }), 'fragment.mp3');
      const response = await fetchImpl('https://api.polza.ai/api/v1/audio/transcriptions', {
        method:'POST', headers:{ authorization:`Bearer ${key}` }, body:form, redirect:'error', signal:combined,
      });
      if (!response?.ok || response.status !== 200) { await response?.body?.cancel?.().catch(() => {}); throw new Error('Распознавание недоступно'); }
      return { http_status:200, body:await boundedJson(response, combined) };
    }, { allowEmptyText:true });
    if (result?.settled !== true || result.accounted_as !== 'unpriced_reserve') throw new Error('Расход STT не подтверждён');
    return result.response.body;
  };
  const llm = Object.freeze({ async complete(body, options = {}) {
    const role = options.role;
    if (!ROLES.has(role) || ++calls[role] > (role === 'judge' ? 2 : role === 'writer' ? 1 : 10)
        || !body || typeof body !== 'object' || Array.isArray(body)
        || body.model !== (role === 'screenshots' ? 'anthropic/claude-sonnet-4.6' : 'openai/gpt-6-sol')
        || !Number.isSafeInteger(body.max_tokens)
        || body.max_tokens < 1 || body.max_tokens > 16000) throw new Error('Запрос модели не допущен');
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > 15 * 1024 * 1024) throw new Error('Запрос модели слишком большой');
    const result = await guard.run(modelReserveRub, async ({ signal: budgetSignal }) => {
      const combined = AbortSignal.any([signal, budgetSignal, AbortSignal.timeout(180000)]);
      const response = await fetchImpl('https://api.polza.ai/api/v1/chat/completions', {
        method:'POST', headers:{ authorization:`Bearer ${key}`, 'content-type':'application/json' },
        body:payload, redirect:'error', signal:combined,
      });
      if (!response?.ok || response.status !== 200) { await response?.body?.cancel?.().catch(() => {}); throw new Error('Модель недоступна'); }
      return boundedJson(response, combined);
    });
    if (result?.settled !== true) throw new Error('Расход модели не подтверждён');
    return result.response;
  } });
  return Object.freeze({ budgetTransport:transcribe, llm, snapshot:() => ({ stt:parts, ...calls }) });
}

/** Тихой операции соответствует одна сделка; output не содержит материалов сделки. */
export async function runManualPrejudgeCommand({ args, env = process.env, fetchImpl = fetch,
  makePool = async config => { const { default:pg } = await import('pg'); return new pg.Pool(config); },
  readBaselines = loadPilotBaselines, startService = startSttService, makeDependencies = createPilotDependencies,
  run = runManualPrejudge, readPrompts = async () => ({
    judgeSystemPrompt:await readFile(new URL('../../prompts/judge.md', import.meta.url), 'utf8'),
    writerSystemPrompt:await readFile(new URL('../../prompts/writer.md', import.meta.url), 'utf8'),
  }), signal = AbortSignal.timeout(1800000), openFile = open } = {}) {
  const config = parseManualPrejudgeOptions(args, env);
  let lock, journal, pool, service, dependencies;
  const mark = async value => { await journal.write(`${JSON.stringify(value)}\n`); await journal.sync(); };
  try {
    lock = await openFile(config.lock, 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ kind:'manual-prejudge', deal_id:config.dealId })); await lock.sync();
    journal = await openFile(config.journal, 'wx', 0o600);
    await mark({ phase:'started', limit_rub:config.limitRub, prior_reserved_rub:config.priorReservedRub });
    const usage = async ({ signal: budgetSignal }) => {
      const combined = AbortSignal.any([signal, budgetSignal, AbortSignal.timeout(30000)]);
      const response = await fetchImpl('https://api.polza.ai/api/v1/key', { headers:{ authorization:`Bearer ${config.polzaKey}` }, redirect:'error', signal:combined });
      if (!response?.ok || response.status !== 200) { await response?.body?.cancel?.().catch(() => {}); throw new Error('Счётчик недоступен'); }
      const data = await boundedJson(response, combined);
      if (typeof data?.usage !== 'number' || !Number.isFinite(data.usage) || data.usage < 0) throw new Error('Счётчик не подтверждён');
      return data.usage;
    };
    const guard = createPolzaBudgetGuard({ baselineRub:config.baselineRub, priorReservedRub:config.priorReservedRub,
      limitRub:config.limitRub, getUsage:usage, persistState:state => mark({ phase:'budget', state }), signal });
    const paid = createManualPaidAdapters({ key:config.polzaKey, guard, signal, fetchImpl,
      sttReserveRub:config.sttReserveRub, modelReserveRub:config.modelReserveRub, maxSttParts:config.maxSttParts });
    const raw = await makePool(databaseConfig({ DATABASE_URL:config.databaseUrl })); raw.on?.('error', () => {});
    pool = createDeadlinePool(raw, { initializationSignal:signal });
    const baseline = await readBaselines(pool, { dealIds:[config.dealId] });
    if (!baseline || !Array.isArray(baseline.baselines) || baseline.baselines.length !== 1
        || Number(baseline.baselines[0].deal_id) !== config.dealId || !exactMillisTimestamp(baseline.audio_wait_enabled_at)) {
      throw new Error('Исторические данные не подтверждены');
    }
    const prompts = await readPrompts(); signal.throwIfAborted();
    service = await startService({ polzaKey:'manual-budget-ipc', signal, budgetTransport:paid.budgetTransport, env });
    dependencies = makeDependencies({ bitrixBaseUrl:config.bitrixBaseUrl, polzaKey:config.polzaKey,
      sttUrl:service.address, sttKey:service.key, tempRoot:service.tempRoot, signal, fetchImpl });
    const out = await run({ pool, dealId:config.dealId, stageHistoryId:config.stageHistoryId, loseDate:config.loseDate,
      options:{ bitrix:dependencies.bitrix, llm:paid.llm, transcribe:dependencies.transcribe,
        resolveFile:id => dependencies.bitrix.request('disk.file.get', { id }), downloadFile:dependencies.downloadFile,
        ...prompts, audioWaitEnabledAt:baseline.audio_wait_enabled_at, savedAudioWait:baseline.baselines[0].saved_audio_wait ?? null,
        screenshots:true } });
    const status = STATUS.has(out?.result?.status) ? out.result.status : 'error';
    const value = out?.result?.analysis?.multi_agent_analysis?.verdict;
    const verdict = VERDICTS.has(value) ? value : null;
    await mark({ phase:'completed', status, calls:paid.snapshot(), budget:guard.snapshot() });
    return { status, verdict, run_id:out?.runId ?? null, silent:true, delivery:false,
      result_saved:out?.resultSaved === true,
      limitations:['semantic_roles_not_enabled','unpriced_stt_reserves_retained'] };
  } catch (error) {
    if (journal) { try { await mark({ phase:'stopped' }); } catch { /* Предыдущий резерв остаётся зафиксированным. */ } }
    throw error;
  } finally {
    const closed = await Promise.allSettled([
      Promise.resolve().then(() => dependencies?.close()),
      Promise.resolve().then(() => service?.close()),
      Promise.resolve().then(() => pool?.end()),
      Promise.resolve().then(() => journal?.close()),
      Promise.resolve().then(() => lock?.close()),
    ]);
    if (closed.some(item => item.status === 'rejected')) throw new Error('Не удалось завершить ручной прогон');
    // Файл блокировки намеренно остаётся: исход прерванного опыта требует сверки.
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runManualPrejudgeCommand({ args:process.argv.slice(2) }).then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('Ручной прогон не завершён; проверьте настройки и журнал бюджета'); process.exitCode = 1;
  });
}
