// Разовая проверка шести закреплённых случаев. Доставка и запись не используются.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createBitrixClient } from '../bitrix-client.mjs';
import { createBitrixLimiter } from '../bitrix-limiter.mjs';
import { collectDeal } from '../collect/index.mjs';
import { processDeal } from '../process-deal.mjs';
import { withAudioInspectionResources } from './audio-inspect.mjs';
import { loadPilotBaselines } from './candidates.mjs';
import { runPilotCommand } from './command.mjs';
import { diagnoseOutcome } from './diagnostics.mjs';
import { describeComposition } from './composition.mjs';
import { compareWithBaseline, readonlyBitrix } from './index.mjs';
import { reviewOne, sealEvidenceReport } from './evidence-review.mjs';
import { semanticReview } from './cohort20.mjs';

const ANALYSES = new Map([['126520','1939'],['126936','1949'],['126548','1992'],['126276','1979'],['123941','1976']]);
const RAW_DEAL = '127114', RAW_DATE = '2026-10-28T05:35:03.000Z';
const TARGETS = Object.freeze([
  { fact_id:'f004', ts:'2026-10-28T02:32:51.000Z', pattern:/мы\s+можем[\s\S]{0,100}предложить[\s\S]{0,100}заменить\s+полностью\s+конструкц/iu },
  { fact_id:'f007', ts:'2026-10-28T02:47:17.000Z', pattern:/сможем\s+озвучить\s+после\s+замера[\s\S]{0,180}удобно\s+будет\s+принять/iu },
  { fact_id:'f019', ts:'2026-10-28T04:58:53.000Z', pattern:/не\s+надо\s+менять\s+окно[\s\S]{0,100}варианты[\s\S]{0,60}есть\s+уже/iu },
]);
const STATUSES = new Set(['processed','waiting','skip','skipped','skipped_by_reason','blocked','error','obsolete_transition','source_incomplete','unverified']);
const MAX_TEXT = 1200;

function permit(dealId, analysisId) {
  if (dealId === RAW_DEAL && analysisId === 'raw') return 'raw';
  if (ANALYSES.get(dealId) === analysisId && typeof analysisId === 'string') return 'analysis';
  throw new TypeError('Случай не разрешён');
}
function redact(value, max=MAX_TEXT) {
  if (typeof value !== 'string' || value.length>500000) return null;
  return value.normalize('NFKC').replace(/https?:\/\/\S+|www\.\S+/giu,'[ссылка]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-zА-Яа-я]{2,}/g,'[почта]')
    .replace(/(?:\+?\d[\s()\-]*){9,}/g,'[номер]')
    .replace(/(?:^|[^\p{L}\p{N}_])(?:authorization|api[_-]?key|token|secret|password|токен|ключ|пароль)\s*[:=]\s*[^\s,;]+/giu,' [секрет]')
    .replace(/\bbearer\s+[^\s,;]+/gi,'[секрет]').replace(/\b(?:sk-|vibe_api_|vibe_app_|y0_)[A-Za-z0-9_-]+\b/gi,'[секрет]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g,'[значение]').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}
function time(value) {const t=new Date(value).getTime();return value!=null&&Number.isFinite(t)?new Date(t).toISOString():null;}
function validId(value) {const s=String(value??'');return /^[1-9]\d{0,29}$/.test(s)?s:null;}
function cleanMessage(value) {return String(value||'').replace(/===\s*(?:Исходящее|Входящее)\s+сообщение[^=]*===/g,'')
  .replace(/=== SYSTEM WZ ===[^\n]*/g,'').replace(/\[\/?\w[\w= ]*\]/g,'').replace(/^>>.*$/gm,'').replace(/\s+/g,' ').trim();}

/** Связываем сообщение с целевым фактом только при совпадении даты и содержания. */
export function matchRawTargets(collection) {
  if (collection?._status !== 'pending_normalization' || !Array.isArray(collection?.raw?.sessions) || !Array.isArray(collection?.raw?.chats)
      || !collection.deal_data?.lose_date || time(collection.deal_data.lose_date)!==RAW_DATE
      || collection?._sources?.openlines?.complete !== true) return {targets:[],sessions_scanned:0,complete:false,
        limitations:['current_history_not_confirmed','historical_message_identity_not_proven']};
  const chats=new Map(collection.raw.chats.map(c=>[String(c.CHAT_ID),c]));
  const hits=new Map(TARGETS.map(t=>[t.fact_id,new Map()]));
  for(const session of collection.raw.sessions){
    const h=session?.history;if(!h||typeof h!=='object'||!h.message||typeof h.message!=='object')throw new Error('История не подтверждена');
    const chatId=String(session.chat_id??Object.keys(h.chat||{})[0]??'');
    const meta=chats.get(chatId)||{}, connector=String(meta.CONNECTOR_ID||''), title=String(meta.CONNECTOR_TITLE||connector);
    const isWazzup=title.toLowerCase().includes('wazzup')||connector.toLowerCase().includes('wazzup')||connector.startsWith('wz_');
    for(const [key,msg] of Object.entries(h.message)){
      if(!msg||typeof msg!=='object')continue;
      const messageId=validId(msg.id??msg.ID??key), raw=String(msg.text||msg.TEXT||''), cleaned=cleanMessage(raw), ts=time(msg.date||msg.DATE);
      if(!messageId||!ts)continue;
      for(const target of TARGETS){
        if(ts!==target.ts||!target.pattern.test(cleaned))continue;
        const sid=String(msg.senderid||msg.SENDER_ID||msg.author_id||msg.AUTHOR_ID||'0');
        const user=sid!=='0'?h.users?.[sid]:null;
        const author=/===\s*(?:Исходящее|Входящее)\s+сообщение,\s*автор:\s*[^(]*\(([^)]+)\)/u.test(raw);
        const direction=/===\s*Исходящее\s+сообщение/u.test(raw)?'outgoing':/===\s*Входящее\s+сообщение/u.test(raw)?'incoming':'none';
        const external=user?.externalAuthId==='imconnector'?'imconnector':user?.externalAuthId==null?'missing':'other';
        const role=author?'manager':user?(user.connector===true||user.extranet===true||external==='imconnector'?'client':'manager'):
          isWazzup&&!/=== (?:Исходящее|Входящее) сообщение/.test(raw)?'client':'unknown';
        const sessionId=validId(session.session_id), safeChat=validId(chatId);
        const row={message_id:messageId,session_id:sessionId,chat_id:safeChat,ts,sender_id:validId(sid),
          sender_lookup:sid==='0'?'zero':user?'matched':'missing',connector:typeof user?.connector==='boolean'?user.connector:null,
          extranet:typeof user?.extranet==='boolean'?user.extranet:null,external_auth:external,header_direction:direction,
          header_author_present:author,is_wazzup:isWazzup,assigned_role:role,excerpt:redact(cleaned,400)};
        const identity=`${safeChat||'unknown'}:${messageId}`;
        const previous=hits.get(target.fact_id).get(identity);
        if(previous&&JSON.stringify(previous)!==JSON.stringify(row))throw new Error('Версии сообщения различаются');
        hits.get(target.fact_id).set(identity,row);
      }
    }
  }
  const targets=TARGETS.map(t=>{const candidates=[...hits.get(t.fact_id).values()];return {fact_id:t.fact_id,expected_ts:t.ts,
    status:candidates.length===1?'matched':candidates.length?'ambiguous':'not_found',candidates:candidates.slice(0,3),candidate_count:candidates.length};});
  return {targets,sessions_scanned:collection.raw.sessions.length,complete:targets.every(t=>t.status==='matched'),
    limitations:['timestamp_and_text_do_not_prove_historical_identity','role_is_reconstructed_not_independently_verified','redaction_best_effort']};
}

function targetedFacts(result) {
  const judge=result?.analysis?.multi_agent_analysis, packet=judge?.facts_packet;
  if(!judge||!Array.isArray(packet?.facts)||packet.facts.length>10000)return null;
  const relevant=packet.facts.filter(f=>['call_transcript','crm_comment','chat','screenshot_chat'].includes(f?.source)&&typeof f.content==='string');
  const calls=relevant.filter(f=>f.source==='call_transcript');
  const clients=calls.filter(f=>f.actor==='client'),managers=calls.filter(f=>f.actor==='manager');
  const comments=relevant.filter(f=>f.source==='crm_comment');
  const picked=[...clients.slice(0,2),...managers.slice(0,2),...comments.slice(0,2)];
  return {reason:redact(judge.exact_reason||judge.verdict_reason_short,1500),
    facts:picked.map(f=>{
      // NFKC способен расширять текст; ограничение и отметку обрезки считаем
      // по уже нормализованному/замаскированному содержимому.
      const cleaned=redact(f.content,500001),tooLong=cleaned===null||cleaned.length>500000;
      return {id:/^f\d{1,8}$/i.test(f.fact_id)?f.fact_id:null,source:f.source,actor:['client','manager','unknown'].includes(f.actor)?f.actor:'unknown',
        ts:time(f.ts),content:tooLong?null:cleaned.slice(0,MAX_TEXT),content_length:tooLong?null:cleaned.length,truncated:tooLong||cleaned.length>MAX_TEXT};}),
    facts_available:relevant.length,facts_selected:picked.length,limitations:['fresh_repeat_not_first_result','role_assignment_requires_verification','redaction_best_effort']};
}

async function runAnalysis({dealId,analysisId,env,runCommand,readBaselines,processFn}) {
  let detail=null,diagnostic=null;
  const checkedRead=async(pool,options)=>{const value=await readBaselines(pool,options);
    if(!Array.isArray(value?.baselines)||value.baselines.length!==1||String(value.baselines[0]?.deal_id)!==dealId||String(value.baselines[0]?.analysis_id)!==analysisId)throw new Error('Эталон изменился');return value;};
  const makeRunner=deps=>({async run({dealId:currentId,baseline,screenshots}){
    if(String(currentId)!==dealId||String(baseline?.deal_id)!==dealId||String(baseline?.analysis_id)!==analysisId||baseline.pipeline_error!=null||!baseline.lose_date)throw new Error('Эталон не подтверждён');
    const saved=baseline.saved_audio_wait??null,sameDate=saved?.lose_date&&new Date(saved.lose_date).getTime()===new Date(baseline.lose_date).getTime(),terminal=['done','expired','cancelled'].includes(saved?.state);
    if((saved?.state==='waiting'||(terminal&&sameDate))&&(typeof saved.origin_stage_history_id!=='string'||!/^[1-9]\d{0,29}$/.test(saved.origin_stage_history_id))){
      diagnostic=diagnoseOutcome({status:'unverified'});return {status:'unverified',diagnostic,composition:describeComposition(null,baseline),verdict:'unavailable',reason_class:'unavailable',facts:{exact:'unavailable'}};}
    const reader=readonlyBitrix(deps.bitrix);deps.signal?.throwIfAborted();
    const result=await processFn({dealId:Number(dealId),bitrix:reader,llm:deps.llm,transcribe:deps.transcribe,downloadFile:deps.downloadFile,
      resolveFile:fileId=>reader.request('disk.file.get',{id:fileId}),judgeSystemPrompt:deps.judgeSystemPrompt,writerSystemPrompt:deps.writerSystemPrompt,
      audioWaitEnabledAt:baseline.audio_wait_enabled_at,savedAudioWait:terminal?{...saved,_recheck_terminal:true}:saved,silent:true,screenshots,clock:Date.now,
      expectedLoseDate:baseline.lose_date,expectedHistoryId:sameDate?saved.origin_stage_history_id:null,
      ...(deps.signal?{wait:ms=>delay(ms,undefined,{signal:deps.signal})}:{})});
    deps.signal?.throwIfAborted();diagnostic=diagnoseOutcome(result);
    if(result?.status==='processed'){
      const prev=baseline.ai_judge_json?.multi_agent_analysis??baseline.ai_judge_json?.judge??baseline.ai_judge_json;
      const cur=result.analysis?.multi_agent_analysis,oldFacts=baseline.ai_facts_json?.facts,newFacts=cur?.facts_packet?.facts;
      detail={previous:reviewOne({judge:prev,packet:baseline.ai_facts_json,verdict:baseline.ai_verdict,reasonClass:baseline.ai_reason_class,transitionLoseDate:baseline.lose_date}),
        current:reviewOne({judge:cur,packet:cur?.facts_packet,verdict:cur?.verdict,reasonClass:cur?.closure_reason_class,transitionLoseDate:baseline.lose_date}),
        // Для двух целевых звонков старый разбор уже сверялся в первом проходе;
        // его семантический пакет опускаем ради места для полного контекста звонка.
        semantic:{previous:['126520','126936'].includes(dealId)?{available:false}:semanticReview({judge:prev,facts:oldFacts,transitionLoseDate:baseline.lose_date}),
          current:semanticReview({judge:cur,facts:newFacts,transitionLoseDate:baseline.lose_date})},
        targeted:['126520','126936'].includes(dealId)?targetedFacts(result):null};
    }
    return {...compareWithBaseline(result,baseline),diagnostic,composition:describeComposition(result,baseline)};
  }});
  const summary=await runCommand({ids:[dealId],env,readBaselines:checkedRead,makeRunner});
  if(summary?.service_closed!==true)throw new Error('Завершение не подтверждено');
  let status=summary.status==='deadline'?'deadline':'unverified';
  if(summary.selected===1&&summary.attempted===1&&summary.statuses&&typeof summary.statuses==='object'){
    const e=Object.entries(summary.statuses);if(e.length===1&&STATUSES.has(e[0][0])&&e[0][1]===1)status=e[0][0];}
  if(status==='processed'&&(!detail||detail.previous.available!==true||detail.current.available!==true))status='unverified';
  return {kind:'analysis',status,deal_id:dealId,analysis_id:analysisId,detail:status==='processed'?detail:null,diagnostic,service_closed:true};
}

async function runRaw({env,makeClient,makeLimiter,collect}) {
  const base=new URL(env.BITRIX_REST_BASE);
  if(base.protocol!=='https:'||base.hostname!=='dinalnsk.bitrix24.ru'||base.username||base.password||base.port||base.search||base.hash||!/^\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(base.pathname))throw new Error('Адрес Битрикса запрещён');
  const limiter=makeLimiter(),client=makeClient({baseUrl:base.toString(),limiter});
  const result=await withAudioInspectionResources({closeLimiter:()=>limiter.close(),closePool:async()=>{},deadlineMs:120000,
    run:async signal=>{const reader=readonlyBitrix({request:(method,body,options)=>client.request(method,body,{...options,signal})});
      const collection=await collect({client:reader,dealId:Number(RAW_DEAL),silent:true,expectedLoseDate:RAW_DATE,requireCurrentHistory:true,
        wait:ms=>delay(ms,undefined,{signal})});signal.throwIfAborted();return {detail:matchRawTargets(collection)};}});
  if(result.resources_closed!==true)throw new Error('Завершение не подтверждено');
  return {kind:'raw',status:result.status==='completed'?(result.detail.complete?'observed':'unverified'):'error',deal_id:RAW_DEAL,analysis_id:null,
    detail:result.status==='completed'?result.detail:null,diagnostic:null,service_closed:true};
}

export async function runFollowup({dealId,analysisId,env=process.env,runCommand=runPilotCommand,readBaselines=loadPilotBaselines,processFn=processDeal,
  makeClient=createBitrixClient,makeLimiter=createBitrixLimiter,collect=collectDeal}={}) {
  const kind=permit(dealId,analysisId);return kind==='raw'?runRaw({env,makeClient,makeLimiter,collect}):runAnalysis({dealId,analysisId,env,runCommand,readBaselines,processFn});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==6||process.argv[4]!=='--sealed'){console.error('Нужен защищённый режим');process.exitCode=1;}
  else Promise.resolve().then(()=>{permit(process.argv[2],process.argv[3]);sealEvidenceReport({service_closed:true},process.argv[5]);
    return runFollowup({dealId:process.argv[2],analysisId:process.argv[3]});}).then(value=>console.log(JSON.stringify(sealEvidenceReport(value,process.argv[5]))))
    .catch(()=>{console.error('Проверка не завершена');process.exitCode=1;});
}
