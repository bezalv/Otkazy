// Ручная сверка закреплённой выборки. Очередь, доставка и запись в БД не используются.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createBitrixClient } from '../bitrix-client.mjs';
import { createBitrixLimiter } from '../bitrix-limiter.mjs';
import { collectDeal } from '../collect/index.mjs';
import { processDeal } from '../process-deal.mjs';
import { exactMillisTimestamp } from '../time-precision.mjs';
import { withAudioInspectionResources } from './audio-inspect.mjs';
import { loadPilotBaselines } from './candidates.mjs';
import { runPilotCommand } from './command.mjs';
import { diagnoseOutcome } from './diagnostics.mjs';
import { describeComposition } from './composition.mjs';
import { compareWithBaseline, readonlyBitrix } from './index.mjs';
import { inspectForSemanticReview, reviewOne, sealEvidenceReport } from './evidence-review.mjs';

// Проверенная выборка закреплена в коде; параметры окружения не могут её расширить.
const ANALYSED = new Map([
  ['126946', '1993'], ['126964', '1986'], ['126548', '1992'], ['127132', '1990'],
  ['126470', '1951'], ['127068', '1963'], ['126742', '1952'], ['127188', '1983'],
  ['126418', '1985'], ['123379', '2000'], ['92137', '1899'], ['126520', '1939'],
  ['126936', '1949'], ['126952', '1987'], ['126944', '1996'], ['125149', '1935'],
  ['127250', '1988'], ['127114', '1968'],
]);
const TECHNICAL = new Map([['126994', 'дубль'], ['126438', 'дополнительный контакт']]);
const SOURCES = ['call_event', 'call_transcript', 'chat', 'chat_voice_transcript', 'crm_comment', 'crm_task', 'screenshot_chat', 'other'];
const ACTORS = ['client', 'manager', 'system', 'unknown', 'other'];
const TYPES = ['client_statement', 'manager_statement', 'crm_comment', 'metric', 'absence', 'other'];
const GROUPS = ['manager_mistakes', 'key_signals', 'risk_factors'];
const STATUSES = new Set(['processed', 'waiting', 'skip', 'skipped', 'skipped_by_reason', 'blocked', 'error', 'obsolete_transition', 'source_incomplete', 'unverified']);
const MAX_FACTS = 15, MAX_CLAIMS = 8, MAX_REFS = 3, MAX_CONTENT = 200, MAX_REASON = 1000, MAX_ITEMS = 10000;
const bucket = (value, names) => names.includes(value) ? value : 'other';

function text(value, max = MAX_CONTENT) {
  if (typeof value !== 'string' || value.length > 500000) return null;
  return value.normalize('NFKC').replace(/https?:\/\/\S+|www\.\S+/gi, '[ссылка]')
    .replace(/\b(?:rest\/\d+\/[A-Za-z0-9_-]+)\b/gi, '[вебхук]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-zА-Яа-я]{2,}/g, '[почта]')
    .replace(/(?:\+?\d[\s()\-]*){9,}/g, '[номер]')
    .replace(/(?:^|[^\p{L}\p{N}_])(?:authorization|api[_-]?key|token|secret|password|токен|ключ|пароль)\s*[:=]\s*[^\s,;]+/giu, ' [секрет]')
    .replace(/\bbearer\s+[^\s,;]+/gi, '[секрет]').replace(/\b(?:sk-|vibe_api_|vibe_app_|y0_)[A-Za-z0-9_-]+\b/gi, '[секрет]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[значение]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function time(value) { const d = exactMillisTimestamp(value); return d ? d.toISOString() : null; }
function relation(fact, loseDate) {
  if (fact.source === 'screenshot_chat' && fact.ts_precision !== 'exact') return 'unknown';
  const ts = time(fact.ts), lose = time(loseDate);
  return !ts || !lose ? 'unknown' : Date.parse(ts) > Date.parse(lose) ? 'after_lose' : 'before_or_at_lose';
}
function factData(fact, loseDate) {
  const content = text(fact.content, 500000);
  let start = 0;
  if (content && content.length > MAX_CONTENT) {
    // Найденный термин — только ориентир для просмотра, не признак истинности тезиса.
    const marker = /друг(?:ая|ие|их|ом|ой)|конкурент|заказ|купил|выбра|наш[её]л|дорог|цен[аыуе]|отказ|технич|не производ|не можем|передум|не актуаль|не выходит на связь/iu.exec(content);
    if (marker) start = Math.max(0, Math.min(content.length - MAX_CONTENT, marker.index - 60));
  }
  return { id: fact.fact_id, source: bucket(fact.source, SOURCES), actor: bucket(fact.actor, ACTORS), ts: time(fact.ts),
    time_relation: relation(fact, loseDate), excerpt: content === null ? null : content.slice(start, start + MAX_CONTENT),
    excerpt_start: content === null ? null : start, content_length: content === null ? null : content.length,
    truncated: content !== null && content.length > MAX_CONTENT };
}

/** Ограниченный набор материалов для ручного анализа: отсутствие текста не означает отсутствие доказательств. */
export function semanticReview({ judge, facts, transitionLoseDate } = {}) {
  if (!judge || typeof judge !== 'object' || Array.isArray(judge) || !Array.isArray(facts) || facts.length > MAX_ITEMS
      || GROUPS.some(group => !Array.isArray(judge[group]) || judge[group].length > MAX_ITEMS)) return { available: false };
  const index = new Map();
  for (const f of facts) {
    if (!f || typeof f !== 'object' || typeof f.fact_id !== 'string' || !/^f\d{1,8}$/i.test(f.fact_id) || index.has(f.fact_id)) return { available: false };
    index.set(f.fact_id, f);
  }
  const rawClaims = [];
  const fields = { manager_mistakes: 'mistake', key_signals: 'signal', risk_factors: 'factor' };
  for (const group of GROUPS) for (const item of judge[group]) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.proof_fact_ids) || item.proof_fact_ids.length > MAX_ITEMS) return { available: false };
    rawClaims.push({ group, item });
  }
  // Не позволяем множеству ошибок менеджера вытеснить сигналы/риски и слова клиента.
  const selectedClaims = [];
  for (const wanted of [x => x.group === 'key_signals', x => x.group === 'risk_factors', x => x.group === 'manager_mistakes',
    x => x.item.proof_type === 'client_statement', x => x.item.proof_type === 'crm_comment', x => x.item.proof_type === 'manager_statement']) {
    const found = rawClaims.find(x => wanted(x) && !selectedClaims.includes(x)); if (found) selectedClaims.push(found);
  }
  for (const item of rawClaims) if (selectedClaims.length < MAX_CLAIMS && !selectedClaims.includes(item)) selectedClaims.push(item);
  const claimData = selectedClaims.map(({ group, item }) => {
    const refs = item.proof_fact_ids.slice(0, MAX_REFS).map(id => {
      if (typeof id !== 'string' || id.length > 100) return { id: null, status: 'invalid' };
      if (/^metric:[A-Za-z0-9_]{1,80}$/.test(id)) return { id, status: 'metric' };
      const fact = index.get(id);
      return fact ? { status: 'found', ...factData(fact, transitionLoseDate) } : { id: /^f\d{1,8}$/i.test(id) ? id : null, status: 'missing' };
    });
    return { group, claim: text(item[fields[group]]), proof_type: bucket(item.proof_type, TYPES), refs,
      refs_total: item.proof_fact_ids.length, refs_omitted: Math.max(0, item.proof_fact_ids.length - refs.length) };
  });
  // Сначала разные источники и стороны, затем остальные. Содержимое — контекст, а не proof.
  const chosen = [], candidates = [...index.values()].filter(f => typeof f.content === 'string' && f.content.trim());
  for (const select of [f => f.actor === 'client' && f.source === 'call_transcript', f => f.actor === 'client' && ['chat','chat_voice_transcript','screenshot_chat'].includes(f.source),
    f => f.actor === 'manager' && f.source === 'crm_comment', f => f.actor === 'unknown', f => f.source === 'call_event', f => f.actor === 'manager' && f.source === 'call_transcript']) {
    const f = candidates.find(item => select(item) && !chosen.includes(item)); if (f) chosen.push(f);
  }
  for (const f of candidates) if (chosen.length < MAX_FACTS && !chosen.includes(f)) chosen.push(f);
  const reason = typeof judge.exact_reason === 'string' ? text(judge.exact_reason, MAX_REASON) : text(judge.verdict_reason_short, MAX_REASON);
  return { available: true, reason, facts_total: facts.length, facts_shown: chosen.length, facts_omitted: Math.max(0, facts.length - chosen.length),
    facts: chosen.map(f => factData(f, transitionLoseDate)), claims_total: rawClaims.length, claims_shown: claimData.length,
    claims_omitted: Math.max(0, rawClaims.length - claimData.length), claims: claimData,
    limitations: ['partial_context_not_proof', 'verdict_proof_not_guaranteed', 'redaction_may_leave_names_addresses_or_unknown_secrets', 'timestamp_may_not_equal_event_time'] };
}

/** Запрещает даже чтение коммуникаций: при смене причины проверить сделку без анализа нельзя. */
export function technicalReader(client, dealId, trace = [], onBlocked = () => {}) {
  if (!client || typeof client.request !== 'function' || !/^[1-9]\d{0,9}$/.test(String(dealId)) || typeof onBlocked !== 'function') throw new TypeError('Некорректный клиент');
  const id = Number(dealId);
  const deny = () => { onBlocked(); throw new Error('Запрос запрещён'); };
  return Object.freeze({ request(method, body, options) {
    if (method === 'crm.deal.userfield.list') {
      if (body?.filter?.FIELD_NAME !== 'UF_CRM_1584703948317') deny();
    } else if (method === 'crm.deal.get') {
      if (Number(body?.id) !== id) deny();
    } else if (method === 'crm.stagehistory.list') {
      if (Number(body?.filter?.OWNER_ID) !== id || body?.entityTypeId !== 2) deny();
    } else deny();
    trace.push(method);
    return Promise.resolve(client.request(method, body, options)).then(result => {
      if (method === 'crm.deal.get' && String(result?.result?.ID) !== String(id)) throw new Error('Сделка не подтверждена');
      return result;
    });
  } });
}

function assertAllowed(dealId, analysisId) {
  if (typeof dealId !== 'string' || !/^[1-9]\d{0,9}$/.test(dealId) || BigInt(dealId) > 2147483647n
      || typeof analysisId !== 'string') throw new TypeError('Необходимо выбрать проверенный анализ');
  if (analysisId === 'skip') {
    const reason = TECHNICAL.get(dealId);
    if (!['дубль', 'дополнительный контакт'].includes(reason)) throw new TypeError('Сделка не разрешена');
    return { kind: 'technical', reason };
  }
  if (!/^[1-9]\d{0,18}$/.test(analysisId) || ANALYSED.get(dealId) !== analysisId) throw new TypeError('Анализ не разрешён');
  return { kind: 'analysed' };
}

async function runAnalysed({ dealId, analysisId, env, runCommand, readBaselines, processFn }) {
  let detail = null;
  const checkedRead = async (pool, options) => {
    const data = await readBaselines(pool, options);
    if (!data || !Array.isArray(data.baselines) || data.baselines.length !== 1 || Number(data.baselines[0]?.deal_id) !== Number(dealId)
        || String(data.baselines[0]?.analysis_id) !== analysisId) throw new Error('Эталон изменился');
    return data;
  };
  const makeRunner = deps => {
    const reader = readonlyBitrix(deps.bitrix);
    return { async run({ dealId: currentId, baseline, screenshots }) {
      if (Number(currentId) !== Number(dealId) || Number(baseline?.deal_id) !== Number(dealId) || String(baseline?.analysis_id) !== analysisId
          || baseline.pipeline_error != null || !baseline.lose_date) throw new Error('Эталон не подтверждён');
      deps.signal?.throwIfAborted();
      const saved = baseline.saved_audio_wait ?? null;
      const sameDate = saved?.lose_date && new Date(saved.lose_date).getTime() === new Date(baseline.lose_date).getTime();
      const terminal = ['done', 'expired', 'cancelled'].includes(saved?.state);
      if ((saved?.state === 'waiting' || (terminal && sameDate)) && (typeof saved.origin_stage_history_id !== 'string'
          || !/^[1-9]\d{0,29}$/.test(saved.origin_stage_history_id))) {
        return { status: 'unverified', diagnostic: diagnoseOutcome({ status: 'unverified' }), composition: describeComposition(null, baseline),
          verdict: 'unavailable', reason_class: 'unavailable', facts: { exact: 'unavailable' } };
      }
      const result = await processFn({ dealId: Number(dealId), bitrix: reader, llm: deps.llm, transcribe: deps.transcribe,
        downloadFile: deps.downloadFile, resolveFile: fileId => reader.request('disk.file.get', { id: fileId }),
        judgeSystemPrompt: deps.judgeSystemPrompt, writerSystemPrompt: deps.writerSystemPrompt,
        audioWaitEnabledAt: baseline.audio_wait_enabled_at, savedAudioWait: terminal ? { ...saved, _recheck_terminal: true } : saved,
        silent: true, screenshots, clock: Date.now, expectedLoseDate: baseline.lose_date,
        expectedHistoryId: sameDate ? saved.origin_stage_history_id : null,
        ...(deps.signal ? { wait: ms => delay(ms, undefined, { signal: deps.signal }) } : {}) });
      deps.signal?.throwIfAborted();
      if (result?.status === 'processed') {
        const previousJudge = baseline.ai_judge_json?.multi_agent_analysis ?? baseline.ai_judge_json?.judge ?? baseline.ai_judge_json;
        const currentJudge = result.analysis?.multi_agent_analysis;
        const previousFacts = baseline.ai_facts_json?.facts, currentFacts = currentJudge?.facts_packet?.facts;
        detail = { previous: reviewOne({ judge: previousJudge, packet: baseline.ai_facts_json, verdict: baseline.ai_verdict,
          reasonClass: baseline.ai_reason_class, transitionLoseDate: baseline.lose_date }),
          current: reviewOne({ judge: currentJudge, packet: currentJudge?.facts_packet, verdict: currentJudge?.verdict,
            reasonClass: currentJudge?.closure_reason_class, transitionLoseDate: baseline.lose_date }),
          inspection: { previous: inspectForSemanticReview({ judge: previousJudge, facts: previousFacts, transitionLoseDate: baseline.lose_date }),
            current: inspectForSemanticReview({ judge: currentJudge, facts: currentFacts, transitionLoseDate: baseline.lose_date }) },
          semantic: { previous: semanticReview({ judge: previousJudge, facts: previousFacts, transitionLoseDate: baseline.lose_date }),
            current: semanticReview({ judge: currentJudge, facts: currentFacts, transitionLoseDate: baseline.lose_date }) },
          limitations: ['same_verdict_is_not_proof', 'historical_inputs_may_have_changed', 'model_is_nondeterministic', 'role_and_semantics_require_review'] };
      }
      return { ...compareWithBaseline(result, baseline), diagnostic: diagnoseOutcome(result), composition: describeComposition(result, baseline) };
    } };
  };
  const summary = await runCommand({ ids: [dealId], env, readBaselines: checkedRead, makeRunner });
  if (summary?.service_closed !== true) throw new Error('Завершение пилота не подтверждено');
  let status = summary.status === 'deadline' ? 'deadline' : 'unverified';
  if (summary.selected === 1 && summary.attempted === 1 && summary.statuses && typeof summary.statuses === 'object') {
    const entries = Object.entries(summary.statuses);
    if (entries.length === 1 && STATUSES.has(entries[0][0]) && entries[0][1] === 1) status = entries[0][0];
  }
  if (status === 'processed' && (!detail || detail.previous.available !== true || detail.current.available !== true)) status = 'unverified';
  return { status, deal_id: dealId, analysis_id: analysisId, detail: status === 'processed' ? detail : null, service_closed: true };
}

async function runTechnical({ dealId, expectedReason, env, makeClient, makeLimiter, collect }) {
  const base = new URL(env.BITRIX_REST_BASE);
  if (base.protocol !== 'https:' || base.hostname !== 'dinalnsk.bitrix24.ru' || base.username || base.password || base.port
      || base.search || base.hash || !/^\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(base.pathname)) throw new Error('Адрес Битрикса запрещён');
  const limiter = makeLimiter(), client = makeClient({ baseUrl: base.toString(), limiter });
  const methods = [];
  const result = await withAudioInspectionResources({ closeLimiter: () => limiter.close(), closePool: async () => {}, deadlineMs: 120000,
    run: async signal => {
      let blocked = false;
      const restricted = technicalReader({ request: (method, body, options) => client.request(method, body, { ...options, signal }) }, dealId, methods, () => { blocked = true; });
      const item = await collect({ client: restricted, dealId: Number(dealId), silent: true, requireCurrentHistory: true,
        wait: ms => { if (blocked) throw new Error('Запрос запрещён'); return delay(ms, undefined, { signal }); } });
      signal.throwIfAborted();
      const verified = item?._status === 'skipped_by_reason' && item?._skip_reason_key === expectedReason
        && Array.isArray(item.stage_history) && item.stage_history[0]?.STAGE_ID === 'C23:LOSE';
      return { verified };
    } });
  if (result.resources_closed !== true) throw new Error('Завершение не подтверждено');
  return { status: result.status === 'completed' && result.verified ? 'skipped_by_reason' : 'unverified', deal_id: dealId, analysis_id: null,
    detail: { expected_reason: expectedReason, actual_reason: result.status === 'completed' && result.verified ? expectedReason : null,
      methods: [...new Set(methods)], history_verified: result.status === 'completed' && result.verified,
      limitations: ['historical_transition_not_verified', 'existing_analysis_may_be_from_prior_transition'] }, service_closed: true };
}

export async function runCohortCase({ dealId, analysisId, env = process.env, runCommand = runPilotCommand, readBaselines = loadPilotBaselines,
  processFn = processDeal, makeClient = createBitrixClient, makeLimiter = createBitrixLimiter, collect = collectDeal } = {}) {
  const allowed = assertAllowed(dealId, analysisId);
  if (allowed.kind === 'technical') return runTechnical({ dealId, expectedReason: allowed.reason, env, makeClient, makeLimiter, collect });
  return runAnalysed({ dealId, analysisId, env, runCommand, readBaselines, processFn });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const valid = process.argv.length === 6 && process.argv[4] === '--sealed';
  if (!valid) { console.error('Нужен защищённый режим'); process.exitCode = 1; }
  else Promise.resolve().then(() => {
    assertAllowed(process.argv[2], process.argv[3]);
    sealEvidenceReport({ service_closed: true }, process.argv[5]); // Проверить ключ до сетевых вызовов.
    return runCohortCase({ dealId: process.argv[2], analysisId: process.argv[3] });
  }).then(value => console.log(JSON.stringify(sealEvidenceReport(value, process.argv[5]))))
    .catch(() => { console.error('Проверка не завершена'); process.exitCode = 1; });
}
