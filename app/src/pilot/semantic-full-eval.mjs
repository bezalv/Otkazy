// Только закреплённая сделка: чтение + текстовый эксперимент без очереди и доставки.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processDeal } from '../process-deal.mjs';
import { runCohortCase } from './cohort20.mjs';
import { runPilotCommand } from './command.mjs';
import { loadPilotBaselines } from './candidates.mjs';
import { sealEvidenceReport } from './evidence-review.mjs';
import { createSemanticSessionVerifier } from './semantic-session-verifier.mjs';
import { createPilotDependencies } from './dependencies.mjs';
import { createBitrixClient } from '../bitrix-client.mjs';
import { createBitrixLimiter } from '../bitrix-limiter.mjs';

const DEAL = '127114', ANALYSIS = '1968';
const GOLD = Object.freeze({ f001:'client',f005:'client',f006:'client',f008:'client',f009:'client',f011:'client',
  f013:'client',f014:'client',f015:'client',f016:'client',f019:'client',f004:'manager',f007:'manager',
  f010:'manager',f012:'manager',f020:'manager' });
const STATUSES = new Set(['processed','waiting','skip','skipped','skipped_by_reason','blocked','error','obsolete_transition','source_incomplete','unverified','deadline']);
const VERDICTS = new Set(['правомерен','неправомерен','недостаточно_данных']);
const CLASSES = new Set(['price','competitor','no_need','no_money','timing','manager_dropped','customer_unreachable','regulatory','other']);
const WARNING_CODES = new Set(['unknown_nonmaterial_present','unknown_nonmaterial_as_statement','unknown_nonmaterial_metric_as_proof']);
const ROLE = new Set(['client','manager','unknown']);
const ORIGIN = new Set(['observed','semantic_inference','unknown']);
const LIMITATIONS = ['screenshots_disabled','audio_transcription_disabled','historical_inputs_may_have_changed',
  'time_and_text_match_not_proof_of_identity','semantic_role_is_inference_not_proof','model_is_nondeterministic',
  'session_history_completeness_unproven'];
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
const time = value => { const n = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(n) ? new Date(n).toISOString() : null; };
const normalize = value => typeof value === 'string' ? value.normalize('NFKC')
  .replace(/^\s*(?:\[(?:B|I|U|S)\]\s*)*===\s*(?:Исходящее|Входящее)\s+сообщение(?:\s*,[^=\r\n]*)?\s*===/iu,'')
  .replace(/\[\/?\w[\w= ]*\]/g,'').replace(/^>>.*$/gm,'').replace(/\s+/g,' ').trim() : '';

/** Проверяет методы и привязку сессий/чатов к сделке; внешние IDs не выводятся. */
export function dealReader(client) {
  if (!client || typeof client.request !== 'function') throw new TypeError('Нет клиента');
  const sessions = new Set(), chats = new Set();
  const id = value => /^[1-9]\d{0,15}$/.test(String(value ?? '')) ? String(value) : null;
  return Object.freeze({ async request(method, body = {}, options) {
    const f = body.filter || {};
    let allowed = false;
    if (method === 'crm.deal.userfield.list') allowed = f.FIELD_NAME === 'UF_CRM_1584703948317';
    else if (method === 'crm.deal.get') allowed = String(body.id) === DEAL;
    else if (method === 'crm.stagehistory.list') allowed = Number(body.entityTypeId) === 2 && String(f.OWNER_ID) === DEAL;
    else if (method === 'crm.activity.list') allowed = Number(f.OWNER_TYPE_ID) === 2 && String(f.OWNER_ID) === DEAL;
    else if (method === 'crm.timeline.comment.list') allowed = String(f.ENTITY_ID) === DEAL && f.ENTITY_TYPE === 'deal';
    else if (method === 'tasks.task.list') allowed = Array.isArray(f.UF_CRM_TASK) && f.UF_CRM_TASK.length === 1 && f.UF_CRM_TASK[0] === `D_${DEAL}`;
    else if (method === 'imopenlines.crm.chat.get') allowed = body.CRM_ENTITY_TYPE === 'deal' && String(body.CRM_ENTITY) === DEAL;
    else if (method === 'imopenlines.session.history.get') {
      const sid = id(body.SESSION_ID), cid = id(body.CHAT_ID);
      allowed = Boolean((sid && !cid && sessions.has(sid)) || (cid && !sid && chats.has(cid)));
    }
    // disk.file.get и все способы изменения CRM намеренно запрещены.
    if (!allowed) throw new Error('Запрос вне выбранной сделки запрещён');
    const response = await client.request(method, body, options);
    if (method === 'imopenlines.crm.chat.get' && Array.isArray(response?.result)) {
      for (const item of response.result) { const value=id(item?.CHAT_ID); if(value) chats.add(value); }
    }
    if (method === 'crm.activity.list' && f.PROVIDER_ID === 'IMOPENLINES_SESSION' && Array.isArray(response?.result)) {
      for (const item of response.result) { const value=id(item?.ASSOCIATED_ENTITY_ID); if(value) sessions.add(value); }
    }
    return response;
  } });
}

function safeEvidence(input) {
  if (!Array.isArray(input) || input.length > 3) return [];
  const output = [];
  for (const session of input) {
    if (!/^session_[1-3]$/.test(session?.session || '') || !Array.isArray(session.messages) || session.messages.length > 100) return [];
    const messages = [];
    for (const m of session.messages) {
      const ts=time(m?.ts);
      if (!/^m\d{3}$/.test(m?.id || '') || !ts || !ROLE.has(m.predicted_role) || !ROLE.has(m.effective_role)
          || !ORIGIN.has(m.source) || !['not_applicable','not_material','material_or_unclear'].includes(m.impact)
          || typeof m.nonmaterial_unknown !== 'boolean') return [];
      messages.push({id:m.id,ts,predicted_role:m.predicted_role,effective_role:m.effective_role,source:m.source,
        impact:m.impact,nonmaterial_unknown:m.nonmaterial_unknown});
    }
    output.push({session:session.session,messages});
  }
  return output;
}

/** Совпадение времени и текста — контроль, но не гарантия идентичности исходной записи. */
export function compareGold(evidence, baseline, outcome) {
  const historic = Array.isArray(baseline?.ai_facts_json?.facts) ? baseline.ai_facts_json.facts.filter(f => f?.source === 'chat'
    && f?.channel === 'WAZZUP: Max' && Object.hasOwn(GOLD,f.fact_id)) : [];
  const empty={ expected:Object.keys(GOLD).length,matched:0,unmatched:Object.keys(GOLD).length,correct:0,incorrect:0,unknown:0,matches:[] };
  if(historic.length>Object.keys(GOLD).length || new Set(historic.map(f=>f.fact_id)).size!==historic.length) return empty;
  const raw = Array.isArray(outcome?.collection?.raw?.sessions) ? outcome.collection.raw.sessions.flatMap(s => Object.values(s?.history?.message || {})) : [];
  const entries = evidence.flatMap(s => s.messages);
  const matches = [];
  for (const f of historic) {
    const ts=time(f.ts), content=normalize(f.content);
    if (!ts || !content) continue;
    const oldAt=historic.filter(x => time(x.ts) === ts), rawAt=raw.filter(x => time(x?.date || x?.DATE) === ts), newAt=entries.filter(x => x.ts === ts);
    if (oldAt.length !== 1 || rawAt.length !== 1 || newAt.length !== 1 || normalize(rawAt[0]?.text || rawAt[0]?.TEXT) !== content) continue;
    const current = newAt[0];
    matches.push({ fact_id:f.fact_id, expected:GOLD[f.fact_id], predicted:current.predicted_role,
      effective:current.effective_role, source:current.source, nonmaterial_unknown:current.nonmaterial_unknown });
  }
  return { expected: Object.keys(GOLD).length, matched: matches.length, unmatched: Object.keys(GOLD).length - matches.length,
    correct: matches.filter(x=>x.predicted===x.expected).length,
    incorrect: matches.filter(x=>x.predicted!=='unknown'&&x.predicted!==x.expected).length,
    unknown: matches.filter(x=>x.predicted==='unknown').length, matches };
}

function temporal(outcome) {
  const lose=time(outcome?.collection?.deal_data?.lose_date), packet=outcome?.analysis?.multi_agent_analysis?.facts_packet;
  if (!lose) return { source:'unavailable', after_lose:null, time_unknown:null, cutoff_after_lose:null };
  if (!packet || !Array.isArray(packet.facts)) {
    const raw=outcome?.collection?.raw;
    if(!raw || !Array.isArray(raw.sessions)||!Array.isArray(raw.calls)||!Array.isArray(raw.comments)||!Array.isArray(raw.tasks))
      return { source:'unavailable', after_lose:null, time_unknown:null, cutoff_after_lose:null };
    const dates=[...raw.calls.map(x=>x?.START_TIME||x?.CREATED), ...raw.comments.map(x=>x?.CREATED),
      ...raw.tasks.map(x=>x?.CREATED_DATE||x?.createdDate), ...raw.sessions.flatMap(s=>Object.values(s?.history?.message||{}).map(x=>x?.date||x?.DATE))];
    let after=0, unknown=0;for(const value of dates){const ts=time(value);if(!ts)unknown++;else if(ts>lose)after++;}
    return {source:'raw_events_may_duplicate',after_lose:after,time_unknown:unknown,cutoff_after_lose:null};
  }
  let after=0, unknown=0;
  for (const fact of packet.facts) { const ts=time(fact?.ts); if (!ts) unknown++; else if (ts>lose) after++; }
  const cutoff=time(packet.metrics?.cutoff_at);
  return { source:'facts', after_lose:after, time_unknown:unknown, cutoff_after_lose:cutoff ? cutoff>lose : null };
}

function project(outcome, baseline, activity) {
  const evidence=safeEvidence(outcome?.chatRoleInferenceEvidence || []);
  const judge=outcome?.analysis?.multi_agent_analysis, stats=outcome?.chatRoleInferenceStats || {};
  const warnings=Array.isArray(judge?.proof_warnings) ? judge.proof_warnings
    : Array.isArray(outcome?.analysis?.llm_meta?.warnings) ? outcome.analysis.llm_meta.warnings : [];
  const counts=Object.fromEntries(['warning','error'].map(severity=>[severity,warnings.filter(w=>w?.severity===severity).length]));
  const codes=[...new Set(warnings.map(w=>WARNING_CODES.has(w?.code)?w.code:'other'))].sort();
  const usage=stats.usage && ['prompt_tokens','completion_tokens','total_tokens'].every(k=>count(stats.usage[k])!==null)
    ? Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens'].map(k=>[k,stats.usage[k]])) : null;
  const meta=outcome?.analysis?.llm_meta;
  const analysisUsage=meta && count(meta.total_tokens)>0 && ['prompt_tokens','completion_tokens','total_tokens'].every(k=>count(meta[k])!==null)
    ? Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens'].map(k=>[k,meta[k]])) : null;
  return { status:STATUSES.has(outcome?.status)?outcome.status:'unverified', deal_id:DEAL, analysis_id:ANALYSIS,
    gate: ['unknown_nonmaterial_as_statement','unknown_nonmaterial_metric_as_proof'].some(code=>warnings.some(w=>w?.code===code))
      ? 'unsafe_unknown_proof' : ['author_ambiguous','chat_connector_unknown','recognition','collect','ok'].includes(outcome?.pipelineGate?.kind)?outcome.pipelineGate.kind:null,
    verdict: VERDICTS.has(judge?.verdict)?judge.verdict:null, reason_class:CLASSES.has(judge?.closure_reason_class)?judge.closure_reason_class:null,
    evidence, comparison:compareGold(evidence,baseline,outcome), temporal:temporal(outcome),
    role_calls:count(stats.model_calls), role_usage:usage, judge_calls:activity.judge, writer_calls:activity.writer, analysis_usage:analysisUsage,
    proof_warnings:counts, proof_warning_codes:codes, proof_errors:count(judge?.proof_errors_count),
    audio_attempted:activity.audio, image_download_attempted:activity.download, limitations:[...LIMITATIONS], service_closed:true };
}

export async function runSemanticFullEval({ caseRunner=runCohortCase, processFn=processDeal, readBaselines=loadPilotBaselines,
  pilotCommand=runPilotCommand, env=process.env } = {}) {
  let baseline=null, observed=null, runs=0, verifierClient=null;
  const read=async (...args)=>{const data=await readBaselines(...args);if(!data || !Array.isArray(data.baselines)||data.baselines.length!==1
    || String(data.baselines[0]?.deal_id)!==DEAL || String(data.baselines[0]?.analysis_id)!==ANALYSIS)throw new Error('Эталон не подтверждён');
    baseline=data.baselines[0];return data;};
  const activity={audio:false,download:false,roles:0,judge:0,writer:0};
  const report=await caseRunner({dealId:DEAL,analysisId:ANALYSIS,env,readBaselines:read,
    runCommand: args=>pilotCommand({...args,deadlineMs:480000,startService:async()=>({address:'http://127.0.0.1:1',key:'disabled',tempRoot:resolve('.'),async close(){}}),
      makeDependencies: opts => {
        const base=new URL(opts.bitrixBaseUrl);
        if(base.protocol!=='https:' || base.hostname!=='dinalnsk.bitrix24.ru' || base.username || base.password || base.port || base.search || base.hash
            || !/^\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(base.pathname)) throw new Error('Адрес запрещён');
        const deps=createPilotDependencies(opts), limiter=createBitrixLimiter();
        try {
          verifierClient=createBitrixClient({baseUrl:base.href,limiter,fetchImpl:(url,options={})=>{
            const target=new URL(url); if(target.origin!==base.origin || !target.pathname.startsWith(base.pathname.replace(/\/$/,'')+'/')) throw new Error('Адрес запрещён');
            const signal=options.signal && opts.signal ? AbortSignal.any([options.signal,opts.signal]) : options.signal || opts.signal;
            return fetch(url,{...options,redirect:'error',signal});
          }});
          return {...deps,close(){verifierClient=null;limiter.close();deps.close();}};
        } catch(error) {limiter.close();deps.close();throw error;}
      }}),
    async processFn(args) {
      runs++;
      if(runs!==1 || Number(args.dealId)!==Number(DEAL) || args.silent!==true)throw new Error('Границы пилота не подтверждены');
      const bitrix=dealReader(args.bitrix);
      const llm={async complete(body, options={}) {
        if(options.role==='judge') activity.judge++;
        else if(options.role==='writer') activity.writer++;
        else if(options.role==='chat-role-inference') activity.roles++;
        else throw new Error('Модельный вызов запрещён');
        if(activity.roles>3||activity.judge>1||activity.writer>1)throw new Error('Превышен лимит модели');
        return args.llm.complete(body,options);
      }};
      const result=await processFn({...args,bitrix,llm,silent:true,semanticChatRoles:true,screenshots:false,
        verifyFallbackSession:createSemanticSessionVerifier(verifierClient),
        transcribe:async()=>{activity.audio=true;throw new Error('Аудио отложено');},
        downloadFile:async()=>{activity.download=true;throw new Error('Загрузка медиа запрещена');},
        resolveFile:async()=>{throw new Error('Вложения отложены');}});
      if((activity.audio||activity.download)&&result.status==='processed')throw new Error('Медиа препятствует проверке');
      observed=project(result,baseline,activity);return result;
    }});
  if(!report || report.deal_id!==DEAL || report.analysis_id!==ANALYSIS || report.service_closed!==true || runs>1)throw new Error('Завершение не подтверждено');
  if(!observed) return {status:'unverified',deal_id:DEAL,analysis_id:ANALYSIS,service_closed:true};
  if(observed.status!==report.status) return {status:'unverified',deal_id:DEAL,analysis_id:ANALYSIS,service_closed:true};
  return observed;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==4||process.argv[2]!=='--sealed'){console.error('Нужен защищённый режим');process.exitCode=1;}
  else Promise.resolve().then(()=>{sealEvidenceReport({service_closed:true},process.argv[3]);return runSemanticFullEval();})
    .then(value=>console.log(JSON.stringify(sealEvidenceReport(value,process.argv[3]))))
    .catch(()=>{console.error('Проверка не завершена');process.exitCode=1;});
}
