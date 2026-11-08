// Разовая диагностика одной сделки; сбор только на чтение, модель и медиа отключены.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDeal } from '../collect/index.mjs';
import { normalizeCommunications } from '../collect/normalize.mjs';
import { inferChatRoles } from '../analysis/chat-role-inference.mjs';
import { pgDecide } from '../rules/pipeline-gate.mjs';
import { planAudioWait } from '../audio-wait/index.mjs';
import { createBitrixClient } from '../bitrix-client.mjs';
import { createBitrixLimiter } from '../bitrix-limiter.mjs';
import { dealReader } from './semantic-full-eval.mjs';
import { runCohortCase } from './cohort20.mjs';
import { runPilotCommand } from './command.mjs';
import { sealEvidenceReport } from './evidence-review.mjs';

const DEAL='127114', ANALYSIS='1968';
const names=['invalid_chat_id','invalid_session_id','synthetic_session_id','ungrouped_invalid_timestamp','ungrouped_after_cutoff_ambiguous','invalid_cutoff','invalid_timestamp',
  'after_cutoff','after_cutoff_ambiguous','invalid_connector','mixed_connectors','too_many_messages',
  'invalid_message_id','duplicate_message_id','duplicate_timestamp','role_conflict','unknown_connector',
  'attachment','empty_text','long_message','too_many_chars','ambiguous_with_known_role'];
const id = v => (typeof v==='string'||typeof v==='number') && /^[A-Za-z0-9_-]{1,120}$/.test(String(v)) ? String(v) : null;
const bitrixId = v => { const s=id(v); return s && /^[1-9]\d{0,15}$/.test(s) && Number.isSafeInteger(Number(s)) ? s : null; };
function parseTime(v) {
  if (typeof v!=='string') return null;
  const m=/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/i.exec(v);
  if (!m) return null;
  const [y,mo,d,h,mi,s]=m.slice(1,7).map(Number), zone=m[7];
  if (!y||mo<1||mo>12||d<1||d>new Date(Date.UTC(y,mo,0)).getUTCDate()||h>23||mi>59||s>59) return null;
  if (zone.toUpperCase()!=='Z') { const p=zone.slice(1).replace(':',''); if(Number(p.slice(0,2))>23||Number(p.slice(2))>59)return null; }
  const n=Date.parse(v);return Number.isFinite(n)?n:null;
}
function observedRole(item) {
  const role=['Клиент','client'].includes(item.role)?'client':['Менеджер','manager'].includes(item.role)?'manager':null;
  const direction=item.direction==='incoming'?'client':item.direction==='outgoing'?'manager':null;
  return role&&direction&&role!==direction?'conflict':role||direction;
}
const hasAttachment = item => item._has_audio===true||item._has_files===true||item._has_audio_transcript===true
  ||item.transcript!=null||item.attachments!=null||item.files!=null||item.file_id!=null;

/** Совпадение перехода проверяется до нормализации, как в processDeal. */
export function transitionMatches(expected, actual) {
  if (expected==null || actual==null || expected==='' || actual==='') return false;
  const e=new Date(expected).getTime(), a=new Date(actual).getTime();
  return Number.isFinite(e) && Number.isFinite(a) && e===a;
}

/** Никакие идентификаторы не выходят из процесса: только наличие и совпадения. */
export function summarizeHistoryIds(sessions) {
  if (!Array.isArray(sessions) || sessions.length>1000) throw new TypeError('Некорректные сессии');
  const s={fallback_sessions:0,fallback_session_id_available:0,fallback_chat_id_available:0,
    fallback_chat_id_matches:0,fallback_both_available_and_chat_matches:0,
    session_queries:0,session_returned_id_available:0,session_returned_id_matches:0,unknown_source:0};
  for(const item of sessions){
    const requestedChat=bitrixId(item?.chat_id),requestedSession=bitrixId(item?.session_id);
    const responseSession=bitrixId(item?.history?.sessionId),responseChat=bitrixId(item?.history?.chatId);
    if(requestedChat&&!requestedSession){
      s.fallback_sessions++;
      if(responseSession)s.fallback_session_id_available++;
      if(responseChat)s.fallback_chat_id_available++;
      if(responseChat&&responseChat===requestedChat)s.fallback_chat_id_matches++;
      if(responseSession&&responseChat&&responseChat===requestedChat)s.fallback_both_available_and_chat_matches++;
    }else if(requestedSession&&!requestedChat){
      s.session_queries++;
      if(responseSession)s.session_returned_id_available++;
      if(responseSession&&responseSession===requestedSession)s.session_returned_id_matches++;
    }else s.unknown_source++;
  }
  return s;
}

/** Сводка отражает предикаты модуля классификации, но не раскрывает содержимое чатов. */
export function summarizeEligibility(communications,cutoff) {
  if(!Array.isArray(communications)||communications.length>10000)throw new TypeError('Некорректная выборка');
  const reasons=Object.fromEntries(names.map(k=>[k,0]));
  const groups=new Map(), cutoffTime=parseTime(cutoff);let ungroupedCandidates=0, candidates=0,eligible=0;
  if(cutoffTime===null)reasons.invalid_cutoff++;
  for(const item of communications){
    if(!item||item.type!=='chat')continue;
    const candidate=item._wazzup_author_ambiguous===true;
    if(candidate)candidates++;
    const chat=bitrixId(item.chat_id),session=bitrixId(item.session_id);
    if(!chat||!session){if(candidate){ungroupedCandidates++;if(!chat)reasons.invalid_chat_id++;if(!session){reasons.invalid_session_id++;if(/^chat_/.test(String(item.session_id??'')))reasons.synthetic_session_id++;}
      const t=parseTime(item.date);if(t===null)reasons.ungrouped_invalid_timestamp++;else if(cutoffTime!==null&&t>cutoffTime)reasons.ungrouped_after_cutoff_ambiguous++;}continue;}
    const key=JSON.stringify([chat,session]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);
  }
  let candidateSessions=0;
  for(const group of groups.values()){
    if(!group.some(x=>x._wazzup_author_ambiguous===true))continue;
    candidateSessions++;
    if(cutoffTime===null)continue;
    const times=group.map(x=>parseTime(x.date));
    if(times.some(x=>x===null)){reasons.invalid_timestamp++;continue;}
    const after=group.filter((_,i)=>times[i]>cutoffTime);
    reasons.after_cutoff+=after.length;reasons.after_cutoff_ambiguous+=after.filter(x=>x._wazzup_author_ambiguous===true).length;
    const prior=group.filter((_,i)=>times[i]<=cutoffTime);
    if(!prior.some(x=>x._wazzup_author_ambiguous===true))continue;
    let invalid=false;const bad=name=>{reasons[name]++;invalid=true;};
    const connectors=new Set(prior.map(x=>id(x.connector_id)));
    if(connectors.size!==1)bad('mixed_connectors');
    const connector=connectors.size===1?[...connectors][0]:null;
    if(!connector||!(/^wz_/i.test(connector)||/wazzup/i.test(connector)))bad('invalid_connector');
    if(prior.length>100)bad('too_many_messages');
    let chars=0;const seenId=new Set(),seenTime=new Set();
    for(const item of prior){
      const msg=id(item.message_id),t=parseTime(item.date),role=observedRole(item);
      if(!msg)bad('invalid_message_id');else if(seenId.has(msg))bad('duplicate_message_id');else seenId.add(msg);
      if(seenTime.has(t))bad('duplicate_timestamp');else seenTime.add(t);
      if(role==='conflict')bad('role_conflict');
      if(item._chat_connector_unknown===true)bad('unknown_connector');
      if(hasAttachment(item))bad('attachment');
      if(typeof item.text!=='string'||!item.text.trim())bad('empty_text');
      if(typeof item.text==='string'&&item.text.length>5000)bad('long_message');
      chars+=typeof item.text==='string'?item.text.length:60001;
      if(item._wazzup_author_ambiguous===true&&role)bad('ambiguous_with_known_role');
    }
    if(chars>60000)bad('too_many_chars');
    if(!invalid)eligible++;
  }
  return {candidate_messages:candidates,ungrouped_candidates:ungroupedCandidates,ungrouped_time_evaluated:cutoffTime!==null,candidate_sessions:candidateSessions,
    mirror_eligible_sessions:eligible,expected_mock_calls:Math.min(3,eligible),reasons};
}

function dependencies({bitrixBaseUrl,signal}) {
  const base=new URL(bitrixBaseUrl);
  if(base.protocol!=='https:'||base.hostname!=='dinalnsk.bitrix24.ru'||base.username||base.password||base.port||base.search||base.hash
      ||!/^\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(base.pathname))throw new Error('Адрес запрещён');
  const limiter=createBitrixLimiter();
  const bitrix=createBitrixClient({baseUrl:base.href,limiter,fetchImpl:(url,options={})=>{
    const target=new URL(url); if(target.origin!==base.origin||!target.pathname.startsWith(base.pathname.replace(/\/$/,'')+'/'))throw new Error('Адрес запрещён');
    return fetch(url,{...options,redirect:'error',signal:options.signal?AbortSignal.any([signal,options.signal]):signal});
  }});
  const no=async()=>{throw new Error('Внешние вызовы отключены');};
  return Object.freeze({bitrix,llm:{complete:no},transcribe:no,downloadFile:no,close(){limiter.close();}});
}

export async function runDiagnostic({caseRunner=runCohortCase,pilotCommand=runPilotCommand,env=process.env}={}) {
  let output=null,runs=0,expectedStatus=null;
  const report=await caseRunner({dealId:DEAL,analysisId:ANALYSIS,env,
    runCommand:args=>pilotCommand({...args,env:{...args.env,POLZA_API_KEY:'disabled'},deadlineMs:240000,
      makeDependencies:dependencies,startService:async()=>({address:'http://127.0.0.1:1',key:'disabled',tempRoot:resolve('.'),async close(){}})}),
    async processFn(args){
      if(++runs!==1||args.dealId!==Number(DEAL)||args.silent!==true)throw new Error('Границы не подтверждены');
      const collected=await collectDeal({client:dealReader(args.bitrix),dealId:args.dealId,silent:true,now:Date.now(),wait:args.wait,
        expectedLoseDate:args.expectedLoseDate,expectedHistoryId:args.expectedHistoryId,requireCurrentHistory:true});
      const sourceFailures=['calls','openlines','comments','tasks'].filter(k=>collected?._sources?.[k]?.complete!==true);
      if(collected._status!=='pending_normalization'){
        expectedStatus=collected._status;
        output={status:'source_blocked',deal_id:DEAL,collection_status:['error','obsolete_transition','skipped','skipped_by_reason','source_incomplete'].includes(collected._status)?collected._status:'other',source_failures:sourceFailures,service_closed:true};
        return {status:collected._status,collection:collected};
      }
      // Исторический эталон не разрешает проверять новый или ещё не подтверждённый
      // переход. Ни история сообщений, ни модель не анализируются при расхождении.
      if(!transitionMatches(args.expectedLoseDate,collected.deal_data?.lose_date)){
        expectedStatus='unverified';
        output={status:'unverified',deal_id:DEAL,service_closed:true};
        return {status:'unverified',collection:collected};
      }
      const audioWait=planAudioWait({stageId:collected.deal_data.stage_id,callsComplete:collected._sources.calls.complete,
        calls:collected.raw.calls,loseDate:collected.deal_data.lose_date,enabledAt:args.audioWaitEnabledAt,
        saved:args.savedAudioWait,nowMs:Date.now(),silent:true,screenshots:false});
      if(audioWait.action!=='analyze'){
        expectedStatus=audioWait.action;
        output={status:'audio_wait',deal_id:DEAL,action:['waiting','expired','source_incomplete'].includes(audioWait.action)?audioWait.action:'other',service_closed:true};
        return {status:audioWait.action,collection:collected,audioWait};
      }
      let normalized;
      try { normalized=await normalizeCommunications({collection:collected,screenshots:false,
        resolveFile:async()=>{throw new Error('Медиа отключены');},transcribeVoice:async()=>{throw new Error('Медиа отключены');}}); }
      catch {expectedStatus='error';output={status:'normalization_failed',deal_id:DEAL,service_closed:true};return {status:'error',collection:collected};}
      const pre=pgDecide({sources:collected._sources,recognition:{voices:normalized.voice_failures}});
      if(pre.block){expectedStatus='blocked';output={status:'prerequisite_blocked',deal_id:DEAL,kind:['collect','recognition'].includes(pre.kind)?pre.kind:'other',
        voice_failures:normalized.voice_failures.length,source_failures:sourceFailures,service_closed:true};return {status:'blocked',collection:collected,pipelineGate:pre};}
      const comms=normalized.deal_data.communications,summary=summarizeEligibility(comms,collected.deal_data.lose_date);
      let mockCalls=0;const inferred=await inferChatRoles({communications:comms,cutoff:collected.deal_data.lose_date,
        client:{async complete(){mockCalls++;throw new Error('Модель отключена');}}});
      expectedStatus='blocked';output={status:'diagnosed',deal_id:DEAL,source_failures:sourceFailures,voice_failures:normalized.voice_failures.length,
        summary,history_identifiers:summarizeHistoryIds(collected.raw.sessions),mock_calls:mockCalls,mock_call_count_matches:mockCalls===summary.expected_mock_calls,
        actual_stats:{candidate_sessions:inferred.stats.candidate_sessions,unresolved:inferred.stats.unresolved,
          skipped_sessions:inferred.stats.skipped_sessions,model_calls:inferred.stats.model_calls,
          excluded_after_cutoff:inferred.stats.excluded_after_cutoff,invalid_cutoff:inferred.stats.invalid_cutoff},
        limitations:['mirrored_conditions_must_match_source','matching_counts_do_not_prove_reasons','mock_model_never_contacts_polza','current_data_may_change'],service_closed:true};
      return {status:'blocked',collection:collected,pipelineGate:{block:true,kind:'author_ambiguous',pipeline_error:'Диагностическая остановка'}};
    }});
  if(!report||report.service_closed!==true||runs>1)throw new Error('Завершение не подтверждено');
  if(report.deal_id!==DEAL||report.analysis_id!==ANALYSIS||report.status!==expectedStatus)
    return {status:'unverified',deal_id:DEAL,service_closed:true};
  return output||{status:'unverified',deal_id:DEAL,service_closed:true};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==4||process.argv[2]!=='--sealed'){console.error('Нужен защищённый режим');process.exitCode=1;}
  else Promise.resolve().then(()=>{sealEvidenceReport({service_closed:true},process.argv[3]);return runDiagnostic();})
    .then(value=>console.log(JSON.stringify(sealEvidenceReport(value,process.argv[3]))))
    .catch(()=>{console.error('Проверка не завершена');process.exitCode=1;});
}
