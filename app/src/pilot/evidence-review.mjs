import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { processDeal } from '../process-deal.mjs';
import { exactMillisTimestamp } from '../time-precision.mjs';
import { loadPilotBaselines } from './candidates.mjs';
import { runPilotCommand } from './command.mjs';
import { compareWithBaseline, readonlyBitrix } from './index.mjs';
import { describeComposition, PILOT_VERDICTS, PILOT_REASON_CLASSES } from './composition.mjs';
import { diagnoseOutcome } from './diagnostics.mjs';

// По умолчанию исходный текст и свободные поля модели не выводятся.
const SOURCES = ['call_event', 'call_transcript', 'chat', 'chat_voice_transcript', 'crm_comment', 'crm_task', 'screenshot_chat', 'other'];
const ACTORS = ['client', 'manager', 'system', 'unknown', 'other'];
const TYPES = ['client_statement', 'manager_statement', 'crm_comment', 'metric', 'absence'];
const CLIENT_SOURCES = new Set(['call_transcript', 'chat', 'chat_voice_transcript', 'screenshot_chat']);
const GROUPS = ['manager_mistakes', 'key_signals', 'risk_factors'];
const SELECTED = new Map([['126402', '1981'], ['126554', '1978'], ['127074', '2004'], ['96621', '1652'], ['126956', '2003']]);
const STATUSES = new Set(['processed', 'waiting', 'skip', 'skipped', 'skipped_by_reason', 'blocked', 'error',
  'obsolete_transition', 'source_incomplete', 'unverified', 'other']);
const MAX_ITEMS = 10000;
const zero = names => Object.fromEntries(names.map(name => [name, 0]));
const bucket = (value, names) => typeof value === 'string' && names.includes(value) ? value : 'other';
const safeEnum = (value, names) => typeof value === 'string' && names.includes(value) ? value : 'unavailable';

function redactText(text, max = 180) {
  return text.normalize('NFKC')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '[ссылка]')
    .replace(/\b(?:rest\/\d+\/[A-Za-z0-9_-]+)\b/gi, '[вебхук]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-zА-Яа-я]{2,}/g, '[почта]')
    .replace(/(?:\+?\d[\s()\-]*){9,}/g, '[номер]')
    .replace(/(?:^|[^\p{L}\p{N}_])(?:authorization|api[_-]?key|token|secret|password|токен|ключ|пароль)\s*[:=]\s*[^\s,;]+/giu, ' [секрет]')
    .replace(/(?:^|[^\p{L}\p{N}_])(?:токен|пароль|ключ)\s+(?:это\s+|равен\s+)?[^\s,;]{4,}/giu, ' [секрет]')
    .replace(/\bbearer\s+[^\s,;]+/gi, '[секрет]')
    .replace(/\b(?:sk-|vibe_api_|vibe_app_|y0_)[A-Za-z0-9_-]+\b/gi, '[секрет]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[значение]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validPositive(value, maxDigits) {
  return typeof value === 'string' && new RegExp(`^[1-9]\\d{0,${maxDigits - 1}}$`).test(value);
}

function detectCallEvent(fact) {
  if (fact.source !== 'call_event' || typeof fact.content !== 'string') return null;
  const text = fact.content.normalize('NFKC').toLocaleLowerCase('ru-RU');
  if (fact.recording_unrecognized === true || text.includes('запись есть, но не распознана')) return 'recording_unrecognized';
  if (text.includes('записи нет')) return 'no_recording';
  if (text.includes('сработал автоответчик') || text.includes('сработал робот')
      || text.includes('ответил автоответчик или голосовой помощник')) return 'machine_or_voicemail';
  if (text.includes('разговор не состоялся') && text.includes('прозвучало только приветствие')) return 'greeting_only';
  if (text.includes('разговор не состоялся') && text.includes('трубку снял не клиент')) return 'not_client';
  if (text.includes('разговор не состоялся') && text.includes('связь не установилась')) return 'bad_line';
  if (text.includes('разговор не состоялся')) return 'no_conversation';
  return 'other_event';
}

function factCounts(facts) {
  const calls = zero(['no_recording', 'recording_unrecognized', 'machine_or_voicemail', 'greeting_only', 'not_client', 'bad_line', 'no_conversation',
    'other_event', 'mono_unknown', 'unassigned_transcript', 'client_transcript', 'manager_transcript']);
  const out = { total: facts.length, by_source: zero(SOURCES), by_actor: zero(ACTORS),
    calls, client_text_at_least_20: 0, client_text_under_20: 0, unknown_text: 0 };
  for (const fact of facts) {
    out.by_source[bucket(fact.source, SOURCES)]++;
    out.by_actor[bucket(fact.actor, ACTORS)]++;
    const callEvent = detectCallEvent(fact);
    if (callEvent) calls[callEvent]++;
    if (fact.source === 'call_transcript') {
      if (fact.actor === 'unknown' && (fact.transcript_mode === 'mono' || typeof fact.content === 'string'
          && fact.content.startsWith('Запись без разделения сторон'))) calls.mono_unknown++;
      else if (fact.actor === 'unknown') calls.unassigned_transcript++;
      else if (fact.actor === 'client') calls.client_transcript++;
      else if (fact.actor === 'manager') calls.manager_transcript++;
    }
    if (CLIENT_SOURCES.has(fact.source) && fact.actor === 'client' && typeof fact.content === 'string') {
      if (fact.content.trim().length >= 20) out.client_text_at_least_20++;
      else if (fact.content.trim()) out.client_text_under_20++;
    }
    if (CLIENT_SOURCES.has(fact.source) && fact.actor === 'unknown' && typeof fact.content === 'string' && fact.content.trim()) out.unknown_text++;
  }
  return out;
}

/** Проверка структуры и ролей не утверждает, что текст доказательства верен по смыслу. */
function proofAudit(judge, facts, metrics, cutoff, loseDate) {
  if (!judge || typeof judge !== 'object' || Array.isArray(judge)
      || GROUPS.some(group => !Array.isArray(judge[group]) || judge[group].length > MAX_ITEMS)) return { available: false };
  const byId = new Map();
  for (const fact of facts) {
    if (typeof fact.fact_id !== 'string' || !fact.fact_id || byId.has(fact.fact_id)) return { available: false };
    byId.set(fact.fact_id, fact);
  }
  const result = { available: true, claims: 0, claims_without_refs: 0, refs: 0, by_type: zero([...TYPES, 'other']),
    by_source: zero([...SOURCES, 'metric']), by_actor: zero(ACTORS), missing_fact: 0, missing_metric: 0,
    metric_unverified: 0, metric_null: 0, wrong_actor_or_source: 0, unknown_speaker: 0,
    incompatible_reference: 0, unsupported_type: 0, absence_requires_review: 0,
    referenced_facts_after_cutoff: 0, referenced_fact_time_unverified: 0,
    referenced_facts_after_lose: 0, referenced_fact_lose_time_unverified: 0 };
  for (const group of GROUPS) {
    for (const item of judge[group]) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !Array.isArray(item.proof_fact_ids)
          || item.proof_fact_ids.length > MAX_ITEMS || item.proof_fact_ids.some(id => typeof id !== 'string' || !id || id.length > 256)) return { available: false };
      result.claims++;
      const type = bucket(item.proof_type, [...TYPES, 'other']);
      result.by_type[type]++;
      if (type === 'other') result.unsupported_type++;
      if (type === 'absence') result.absence_requires_review++;
      if (!item.proof_fact_ids.length) result.claims_without_refs++;
      for (const id of item.proof_fact_ids) {
        if (result.refs >= MAX_ITEMS) return { available: false };
        result.refs++;
        if (id.startsWith('metric:')) {
          if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) { result.metric_unverified++; continue; }
          const name = id.slice(7);
          if (!Object.hasOwn(metrics, name) || metrics[name] === undefined) { result.missing_metric++; continue; }
          if (metrics[name] === null) { result.metric_null++; continue; }
          result.by_source.metric++;
          result.by_actor.system++;
          if (!['metric', 'absence'].includes(type)) result.incompatible_reference++;
          continue;
        }
        const fact = byId.get(id);
        if (!fact) { result.missing_fact++; continue; }
        result.by_source[bucket(fact.source, SOURCES)]++;
        result.by_actor[bucket(fact.actor, ACTORS)]++;
        const factTime = exactMillisTimestamp(fact.ts);
        if (!cutoff || !factTime) result.referenced_fact_time_unverified++;
        else if (factTime.getTime() > cutoff.getTime()) result.referenced_facts_after_cutoff++;
        if (!loseDate || !factTime) result.referenced_fact_lose_time_unverified++;
        else if (factTime.getTime() > loseDate.getTime()) result.referenced_facts_after_lose++;
        if (['client_statement', 'manager_statement'].includes(type)) {
          if (fact.actor === 'unknown' && CLIENT_SOURCES.has(fact.source)) result.unknown_speaker++;
          else if (fact.actor !== (type === 'client_statement' ? 'client' : 'manager') || !CLIENT_SOURCES.has(fact.source)) result.wrong_actor_or_source++;
        } else if (type === 'crm_comment' && fact.source !== 'crm_comment') result.wrong_actor_or_source++;
        else if (type === 'metric') result.incompatible_reference++;
      }
    }
  }
  return result;
}

/** Только структурные признаки: совпадение verdict и слова сами по себе не доказывают корректность. */
export function reviewOne({ judge, packet, verdict, reasonClass, transitionLoseDate }) {
  const safeVerdict = safeEnum(verdict, PILOT_VERDICTS), safeClass = safeEnum(reasonClass, PILOT_REASON_CLASSES);
  if (!packet || typeof packet !== 'object' || Array.isArray(packet) || !Array.isArray(packet.facts)
      || packet.facts.length > MAX_ITEMS || !packet.facts.every(fact => fact && typeof fact === 'object' && !Array.isArray(fact))) {
    return { available: false, verdict: safeVerdict, reason_class: safeClass };
  }
  const cutoff = exactMillisTimestamp(packet.metrics?.cutoff_at);
  const loseDate = exactMillisTimestamp(transitionLoseDate);
  const temporal = { cutoff_available: Boolean(cutoff), after_cutoff: 0, time_unverified: 0,
    lose_date_available: Boolean(loseDate), cutoff_after_lose: cutoff && loseDate ? cutoff.getTime() > loseDate.getTime() : null,
    after_lose: 0, lose_time_unverified: 0 };
  for (const fact of packet.facts) {
    const time = exactMillisTimestamp(fact.ts);
    if (!cutoff || !time) temporal.time_unverified++;
    else if (time.getTime() > cutoff.getTime()) temporal.after_cutoff++;
    if (!loseDate || !time) temporal.lose_time_unverified++;
    else if (time.getTime() > loseDate.getTime()) temporal.after_lose++;
  }
  const facts = factCounts(packet.facts), proof = proofAudit(judge, packet.facts, packet.metrics, cutoff, loseDate);
  return { available: true, verdict: safeVerdict, reason_class: safeClass, facts, temporal, proof,
    // Даже одна содержательная короткая реплика может быть однозначным отказом.
    limitations: ['correctness_requires_semantic_review', 'text_length_is_not_a_decision_rule',
      'absence_claims_require_manual_review', 'speech_recognition_may_be_wrong', 'historical_transition_not_verified',
      'facts_after_lose_require_manual_review'] };
}

/**
 * Отдельный явный opt-in для минимальных выдержек, на которые действительно
 * сослался судья. Маскирование эвристическое: имена, адреса и прочие личные
 * сведения могут сохраниться; применять только при разрешённом доступе.
 * CLI вызывает функцию только при явном opt-in.
 */
export function extractRedactedProofExcerpts({ enabled = false, selectedFactIds, judge, facts } = {}) {
  if (enabled !== true) return { enabled: false, excerpts: [] };
  if (!Array.isArray(selectedFactIds) || !selectedFactIds.length || selectedFactIds.length > 3
      || selectedFactIds.some(id => typeof id !== 'string' || !/^f\d{1,8}$/i.test(id))
      || new Set(selectedFactIds).size !== selectedFactIds.length || !judge || typeof judge !== 'object'
      || !Array.isArray(facts) || facts.length > MAX_ITEMS || GROUPS.some(group => !Array.isArray(judge[group]))) {
    throw new TypeError('Некорректный явный выбор доказательств');
  }
  const referenced = new Set();
  for (const group of GROUPS) for (const claim of judge[group]) {
    if (!claim || !Array.isArray(claim.proof_fact_ids)) throw new TypeError('Некорректные ссылки доказательств');
    for (const id of claim.proof_fact_ids) if (typeof id === 'string') referenced.add(id);
  }
  const byId = new Map();
  for (const fact of facts) {
    if (!fact || typeof fact !== 'object' || typeof fact.fact_id !== 'string' || byId.has(fact.fact_id)) throw new TypeError('Некорректные факты');
    byId.set(fact.fact_id, fact);
  }
  const excerpts = selectedFactIds.map(id => {
    const fact = byId.get(id);
    if (!referenced.has(id) || !fact || typeof fact.content !== 'string' || fact.content.length > 500000) throw new TypeError('Доказательство не подтверждено');
    return { source: bucket(fact.source, SOURCES), actor: bucket(fact.actor, ACTORS), excerpt: redactText(fact.content) };
  });
  return { enabled: true, excerpts, limitations: ['redaction_may_leave_names_addresses_or_unknown_secrets',
    'excerpt_is_not_complete_evidence', 'manual_review_required'] };
}

function selectedEvidence(judge, facts) {
  if (!judge || typeof judge !== 'object' || !Array.isArray(facts) || GROUPS.some(name => !Array.isArray(judge[name]))) {
    return { available: false, reason: null, excerpts: [], referenced_facts_count: 0, shown_facts_count: 0, limitations: ['manual_review_required', 'verdict_proof_not_guaranteed'] };
  }
  const candidates = [];
  for (const priority of ['client_statement', 'manager_statement', 'crm_comment', 'absence', 'metric']) {
    for (const group of GROUPS) for (const item of judge[group]) {
      if (item?.proof_type !== priority || !Array.isArray(item.proof_fact_ids)) continue;
      for (const id of item.proof_fact_ids) if (typeof id === 'string' && /^f\d{1,8}$/i.test(id) && !candidates.includes(id)) candidates.push(id);
    }
  }
  const present = new Map();
  for (const fact of facts) if (fact && typeof fact.fact_id === 'string') {
    if (present.has(fact.fact_id)) return { available: false, reason: null, excerpts: [], referenced_facts_count: 0, shown_facts_count: 0, limitations: ['manual_review_required', 'verdict_proof_not_guaranteed'] };
    present.set(fact.fact_id, fact);
  }
  const supported = candidates.filter(id => typeof present.get(id)?.content === 'string');
  const chosen = [];
  for (const actor of ['client', 'manager']) {
    const id = supported.find(candidate => present.get(candidate).actor === actor && !chosen.includes(candidate));
    if (id) chosen.push(id);
  }
  const other = supported.find(candidate => !chosen.includes(candidate) && !['client', 'manager'].includes(present.get(candidate).actor));
  if (other) chosen.push(other);
  for (const id of supported) if (chosen.length < 3 && !chosen.includes(id)) chosen.push(id);
  const extracted = chosen.length ? extractRedactedProofExcerpts({ enabled: true, selectedFactIds: chosen, judge, facts })
    : { excerpts: [], limitations: ['manual_review_required'] };
  const reason = typeof judge.exact_reason === 'string' && judge.exact_reason.length <= 50000 ? redactText(judge.exact_reason, 280)
    : typeof judge.verdict_reason_short === 'string' && judge.verdict_reason_short.length <= 50000 ? redactText(judge.verdict_reason_short, 280) : null;
  return { available: true, reason, excerpts: extracted.excerpts, referenced_facts_count: candidates.length, shown_facts_count: extracted.excerpts.length,
    limitations: ['redaction_may_leave_names_addresses_or_unknown_secrets', 'excerpts_are_partial_and_require_manual_review', 'verdict_proof_not_guaranteed'] };
}

function parsePublicKey(encoded) {
  if (typeof encoded !== 'string' || encoded.length < 100 || encoded.length > 8192
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new TypeError('Некорректный открытый ключ');
  const raw = Buffer.from(encoded, 'base64');
  if (raw.toString('base64') !== encoded) throw new TypeError('Некорректный открытый ключ');
  const pem = raw.toString('utf8');
  if (!/^-----BEGIN (?:RSA )?PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END (?:RSA )?PUBLIC KEY-----\s*$/.test(pem)) throw new TypeError('Некорректный открытый ключ');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'rsa' || !Number.isInteger(key.asymmetricKeyDetails?.modulusLength)
      || key.asymmetricKeyDetails.modulusLength < 2048 || key.asymmetricKeyDetails.modulusLength > 4096) throw new TypeError('Некорректный открытый ключ');
  return key;
}

/** Гибридное шифрование; marker появляется лишь после успешного закрытия ресурсов. */
export function sealEvidenceReport(report, encodedPublicKey) {
  const key = parsePublicKey(encodedPublicKey);
  if (!report || report.service_closed !== true) throw new Error('Завершение пилота не подтверждено');
  const plaintext = Buffer.from(JSON.stringify(report), 'utf8');
  if (plaintext.length > 100000) throw new Error('Слишком большой отчёт');
  const sessionKey = randomBytes(32), iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', sessionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const encryptedKey = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, sessionKey);
    return { sealed_version: 1, algorithm: 'RSA-OAEP-SHA256+A256GCM', encrypted_key: encryptedKey.toString('base64'),
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), service_closed: true };
  } finally { sessionKey.fill(0); plaintext.fill(0); }
}

/** Один явно выбранный анализ; сеть доступна только штатным read-only адаптерам пилота. */
export async function runEvidenceReview({ dealId, analysisId, includeExcerpts = false, env = process.env, runCommand = runPilotCommand,
  readBaselines = loadPilotBaselines, processFn = processDeal } = {}) {
  if (!validPositive(dealId, 10) || BigInt(dealId) > 2147483647n || !validPositive(analysisId, 19) || SELECTED.get(dealId) !== analysisId
      || typeof includeExcerpts !== 'boolean'
      || typeof runCommand !== 'function' || typeof readBaselines !== 'function' || typeof processFn !== 'function') {
    throw new TypeError('Необходимо явно выбрать сделку и сохранённый анализ');
  }
  let detail = null;
  const checkedRead = async (pool, options) => {
    const result = await readBaselines(pool, options);
    if (!result || !Array.isArray(result.baselines) || result.baselines.length !== 1
        || Number(result.baselines[0]?.deal_id) !== Number(dealId)
        || String(result.baselines[0]?.analysis_id) !== analysisId) throw new Error('Эталон изменился');
    return result;
  };
  const makeRunner = deps => {
    const reader = readonlyBitrix(deps.bitrix);
    return { async run({ dealId: currentId, baseline, screenshots }) {
      if (Number(currentId) !== Number(dealId) || Number(baseline?.deal_id) !== Number(dealId)
          || String(baseline?.analysis_id) !== analysisId || baseline.pipeline_error != null || !baseline.lose_date) throw new Error('Эталон не подтверждён');
      deps.signal?.throwIfAborted();
      const saved = baseline.saved_audio_wait ?? null;
      const sameDate = saved?.lose_date && new Date(saved.lose_date).getTime() === new Date(baseline.lose_date).getTime();
      const terminal = ['done', 'expired', 'cancelled'].includes(saved?.state);
      if ((saved?.state === 'waiting' || (terminal && sameDate)) && (typeof saved.origin_stage_history_id !== 'string'
          || !/^[1-9]\d{0,29}$/.test(saved.origin_stage_history_id))) {
        return { status: 'unverified', diagnostic: diagnoseOutcome({ status: 'unverified' }), composition: describeComposition(null, baseline),
          verdict: 'unavailable', reason_class: 'unavailable', facts: { exact: 'unavailable' } };
      }
      const result = await processFn({ dealId: Number(dealId), bitrix: reader, llm: deps.llm,
        transcribe: deps.transcribe, downloadFile: deps.downloadFile,
        resolveFile: fileId => reader.request('disk.file.get', { id: fileId }),
        judgeSystemPrompt: deps.judgeSystemPrompt, writerSystemPrompt: deps.writerSystemPrompt,
        audioWaitEnabledAt: baseline.audio_wait_enabled_at,
        savedAudioWait: terminal ? { ...saved, _recheck_terminal: true } : saved,
        silent: true, screenshots, clock: Date.now, expectedLoseDate: baseline.lose_date,
        expectedHistoryId: sameDate ? saved.origin_stage_history_id : null,
        ...(deps.signal ? { wait: ms => delay(ms, undefined, { signal: deps.signal }) } : {}) });
      deps.signal?.throwIfAborted();
      if (result?.status === 'processed') {
        const previousJudge = baseline.ai_judge_json?.multi_agent_analysis ?? baseline.ai_judge_json?.judge ?? baseline.ai_judge_json;
        const current = result?.analysis?.multi_agent_analysis;
        detail = { previous: reviewOne({ judge: previousJudge, packet: baseline.ai_facts_json,
          verdict: baseline.ai_verdict, reasonClass: baseline.ai_reason_class, transitionLoseDate: baseline.lose_date }),
          current: reviewOne({ judge: current, packet: current?.facts_packet,
            verdict: current?.verdict, reasonClass: current?.closure_reason_class, transitionLoseDate: baseline.lose_date }),
          correctness: 'requires_manual_review', limitations: ['same_verdict_is_not_proof', 'historical_inputs_may_have_changed',
            'model_is_nondeterministic', 'role_and_semantics_require_review'] };
        if (includeExcerpts) detail.selected_excerpts = {
          previous: selectedEvidence(previousJudge, baseline.ai_facts_json?.facts),
          current: selectedEvidence(current, current?.facts_packet?.facts),
        };
      }
      return { ...compareWithBaseline(result, baseline), diagnostic: diagnoseOutcome(result), composition: describeComposition(result, baseline) };
    } };
  };
  const summary = await runCommand({ ids: [dealId], env, readBaselines: checkedRead, makeRunner });
  if (summary?.service_closed !== true) throw new Error('Завершение пилота не подтверждено');
  let status = summary?.status === 'deadline' ? 'deadline' : 'other';
  if (summary?.selected === 1 && summary?.attempted === 1 && summary.statuses && typeof summary.statuses === 'object') {
    const found = Object.entries(summary.statuses);
    if (found.length === 1 && STATUSES.has(found[0][0]) && found[0][1] === 1) status = found[0][0];
  }
  if (status === 'processed' && (!detail || detail.previous.available !== true || detail.current.available !== true)) status = 'unverified';
  return { status, detail: status === 'processed' ? detail : null, service_closed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sealed = process.argv.length === 6 && process.argv[4] === '--sealed';
  if (process.argv.length !== 4 && !sealed) { console.error('Укажите сделку и номер сохранённого анализа'); process.exitCode = 1; }
  else Promise.resolve().then(() => {
    if (sealed) parsePublicKey(process.argv[5]); // Не начинать сетевые действия с неверным ключом.
    return runEvidenceReview({ dealId: process.argv[2], analysisId: process.argv[3], includeExcerpts: sealed });
  }).then(value => console.log(JSON.stringify(sealed ? sealEvidenceReport(value, process.argv[5]) : value)))
    .catch(() => { console.error('Проверка не завершена'); process.exitCode = 1; });
}
