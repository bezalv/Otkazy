// Проверка связи последней открытой сессии с конкретной сделкой. Только чтение.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBitrixClient } from '../bitrix-client.mjs';
import { createBitrixLimiter } from '../bitrix-limiter.mjs';
import { runPilotCommand } from './command.mjs';
import { loadPilotBaselines } from './candidates.mjs';
import { sealEvidenceReport } from './evidence-review.mjs';

const DEAL = '127114', ANALYSIS = '1968';
const FROM = '2026-01-01T00:00:00.000Z', END = '2026-11-09T00:00:00.000Z';
const LIMIT = 200, MAX_PAGES = 20, MAX_MESSAGES = 5000, MAX_CHARS = 5_000_000;
const LIMITATIONS = Object.freeze(['date_window_is_bounded','session_list_may_be_incomplete',
  'current_crm_binding_may_change','history_read_has_no_documented_read_state_guarantee',
  'one_session_does_not_prove_deal_history_complete','historical_transition_not_verified',
  'line_may_have_changed','session_list_pagination_may_shift']);

function numericId(value) {
  const s=String(value??'');
  return /^[1-9]\d{0,15}$/.test(s) && Number.isSafeInteger(Number(s)) ? s : null;
}
// entityId Открытой линии: connector|LINE_ID|..., без догадок о линии.
function lineInfo(history, chatId) {
  const chat=numericId(chatId), value=chat && history?.chat?.[chat]?.entityId;
  if(typeof value!=='string' || value.length>1024)return null;
  const parts=value.split('|');
  if(parts.length!==4 || !parts[0] || parts.some(x=>!x || x.trim()!==x))return null;
  const config=numericId(parts[1]);
  return config?{config,entity:value}:null;
}
function strictDate(value) {
  if(typeof value!=='string')return null;
  const match=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(Z|[+-]\d\d:?\d\d)$/i.exec(value);
  if(!match)return null;
  const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number), zone=match[7];
  if(!year||month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59||second>59)return null;
  if(zone.toUpperCase()!=='Z'){const s=zone.slice(1).replace(':','');if(Number(s.slice(0,2))>23||Number(s.slice(2))>59)return null;}
  const time=Date.parse(value);return Number.isFinite(time)?time:null;
}
const bool = value => typeof value==='boolean';

// Только заранее перечисленные методы и параметры. ID открытой линии могут
// поступить исключительно из ответа по текущей сделке/подтверждённому чату.
export function restrictedReader(client, cutoff) {
  if(!client || typeof client.request!=='function' || strictDate(cutoff)===null
      || strictDate(cutoff)<Date.parse(FROM) || strictDate(cutoff)>=Date.parse(END))throw new Error('Границы не подтверждены');
  const chats=new Set(), sessions=new Map(), lines=new Set();
  return Object.freeze({ async request(method,body={},options) {
    const f=body.filter||{}; let allowed=false;
    if(method==='crm.deal.get')allowed=String(body.id)===DEAL && Object.keys(body).length===1;
    else if(method==='crm.stagehistory.list')allowed=Number(body.entityTypeId)===2 && String(f.OWNER_ID)===DEAL
      && Object.keys(body).sort().join(',')==='entityTypeId,filter,order,select'
      && Object.keys(f).length===1 && body.order?.CREATED_TIME==='DESC' && Object.keys(body.order).length===1
      && JSON.stringify(body.select)==='["ID","STAGE_ID","CREATED_TIME"]';
    else if(method==='imopenlines.crm.chat.get')allowed=Object.keys(body).sort().join(',')==='ACTIVE_ONLY,CRM_ENTITY,CRM_ENTITY_TYPE'
      && body.CRM_ENTITY_TYPE==='deal' && String(body.CRM_ENTITY)===DEAL && body.ACTIVE_ONLY==='N';
    else if(method==='imopenlines.session.history.get') {
      const chat=numericId(body.CHAT_ID),session=numericId(body.SESSION_ID);
      allowed=Object.keys(body).length===1 && ((chat && chats.has(chat)) || (session && sessions.has(session))) ? true:false;
    } else if(method==='imopenlines.v2.Session.list') {
      allowed=Object.keys(body).sort().join(',')==='configId,dateCreateFrom,dateCreateTo,limit,offset,order,orderDirection'
        && body.dateCreateFrom===FROM && body.dateCreateTo===cutoff && body.limit===LIMIT
        && lines.has(numericId(body.configId))
        && Number.isSafeInteger(body.offset) && body.offset>=0 && body.offset<LIMIT*MAX_PAGES
        && body.order==='dateCreate' && body.orderDirection==='desc';
    }
    if(!allowed)throw new Error('Запрос вне границ диагностики');
    const response=await client.request(method,body,options);
    if(method==='imopenlines.crm.chat.get' && Array.isArray(response?.result)) {
      for(const item of response.result){const chat=numericId(item?.CHAT_ID);if(chat)chats.add(chat);}
    }
    if(method==='imopenlines.session.history.get' && body.CHAT_ID!==undefined) {
      const result=response?.result,chat=numericId(body.CHAT_ID),returnedChat=numericId(result?.chatId),session=numericId(result?.sessionId);
      if(chat && chat===returnedChat && session){sessions.set(session,chat);const line=lineInfo(result,chat);if(line)lines.add(line.config);}
    }
    return response;
  }});
}

// Проверка идентичности сообщений происходит внутри процесса; текст, sender,
// идентификаторы и значения не попадают в диагностический отчёт.
export function historiesMatch(first,second,chatId,sessionId) {
  const chat=numericId(chatId),session=numericId(sessionId);
  if(!chat||!session||numericId(first?.chatId)!==chat||numericId(second?.chatId)!==chat
      ||numericId(first?.sessionId)!==session||numericId(second?.sessionId)!==session)return false;
  // Сравниваем все поля сообщений, users и files: отдельные алиасы автора,
  // отсутствие поля и значение 0 различаются. Порядок ключей объекта не важен.
  // Необычные значения или чрезмерный ответ не считаются совпадением.
  function snapshot(history) {
    if(!history?.message || typeof history.message!=='object' || Array.isArray(history.message))return null;
    const entries=Object.entries(history.message);if(!entries.length||entries.length>MAX_MESSAGES)return null;
    const ids=new Set();
    for(const [key,m] of entries){
      if(!m||typeof m!=='object'||Array.isArray(m))return null;
      const id=numericId(m.id??m.ID??key);
      if(!id||ids.has(id))return null;ids.add(id);
    }
    let chars=0,nodes=0;const seen=new Set();
    function canonical(value,depth=0) {
      if(depth>40||++nodes>100000)throw new Error('too large');
      if(value===null||typeof value==='boolean')return JSON.stringify(value);
      if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('invalid');return JSON.stringify(value);}
      if(typeof value==='string'){chars+=value.length;if(chars>MAX_CHARS)throw new Error('too large');return JSON.stringify(value);}
      if(!value||typeof value!=='object'||seen.has(value))throw new Error('invalid');
      const proto=Object.getPrototypeOf(value);
      if(!Array.isArray(value)&&proto!==Object.prototype&&proto!==null)throw new Error('invalid');
      seen.add(value);
      const result=Array.isArray(value)?'['+Array.from(value,item=>canonical(item,depth+1)).join(',')+']'
        :'{'+Object.keys(value).sort().map(key=>{chars+=key.length;if(chars>MAX_CHARS)throw new Error('too large');return JSON.stringify(key)+':'+canonical(value[key],depth+1);}).join(',')+'}';
      seen.delete(value);return result;
    }
    try {
      const relevant={message:history.message};
      for(const key of ['users','files'])if(Object.hasOwn(history,key))relevant[key]=history[key];
      return canonical(relevant);
    } catch {return null;}
  }
  const a=snapshot(first),b=snapshot(second);return a!==null&&b!==null&&a===b;
}

const initial = () => ({status:'unverified',deal_id:DEAL,stage:'initial',current_chat_bound:false,
  history_identifiers_match:false,line_identifiers_match:null,history_recheck_match:null,session_found:false,session_chat_matches:null,session_line_matches:null,
  session_crm:'unverified',session_created_before_lose:null,session_close_after_lose:null,
  session_pages:0,session_rows:0,pagination_exhausted:null,service_closed:true,limitations:[...LIMITATIONS]});

export async function inspectSession({client,loseDate}) {
  const out=initial(), parsed=typeof loseDate==='string'?strictDate(loseDate):null;
  if(parsed===null)return {...out,stage:'invalid_cutoff'};
  const cutoff=new Date(parsed).toISOString();
  const lose=strictDate(cutoff);
  if(lose===null || lose<Date.parse(FROM) || lose>=Date.parse(END))return {...out,stage:'invalid_cutoff'};
  const reader=restrictedReader(client,cutoff);
  try {
    const deal=await reader.request('crm.deal.get',{id:Number(DEAL)});
    if(String(deal?.result?.ID)!==DEAL || deal?.result?.STAGE_ID!=='C23:LOSE')return {...out,stage:'deal_unverified'};
    const h=await reader.request('crm.stagehistory.list',{entityTypeId:2,filter:{OWNER_ID:Number(DEAL)},order:{CREATED_TIME:'DESC'},select:['ID','STAGE_ID','CREATED_TIME']});
    const transition=h?.result?.items?.[0];
    if(transition?.STAGE_ID!=='C23:LOSE'||strictDate(transition.CREATED_TIME)!==lose)return {...out,stage:'transition_unverified'};
    const found=await reader.request('imopenlines.crm.chat.get',{CRM_ENTITY_TYPE:'deal',CRM_ENTITY:Number(DEAL),ACTIVE_ONLY:'N'});
    const chats=found?.result;
    if(!Array.isArray(chats)||chats.length!==1)return {...out,stage:'chat_unverified'};
    const chat=numericId(chats[0]?.CHAT_ID),connector=String(chats[0]?.CONNECTOR_ID||'');
    if(!chat || !(/^wz_/i.test(connector)||/wazzup/i.test(connector)))return {...out,stage:'chat_unverified'};
    out.current_chat_bound=true;
    const first=(await reader.request('imopenlines.session.history.get',{CHAT_ID:Number(chat)}))?.result;
    const session=numericId(first?.sessionId);
    if(!session || numericId(first?.chatId)!==chat)return {...out,stage:'history_unverified'};
    out.history_identifiers_match=true;
    const line=lineInfo(first,chat);
    if(!line)return {...out,stage:'line_unverified'};
    const second=(await reader.request('imopenlines.session.history.get',{SESSION_ID:Number(session)}))?.result;
    const secondLine=lineInfo(second,chat);
    out.line_identifiers_match=!!secondLine && secondLine.entity===line.entity;
    if(!out.line_identifiers_match)return {...out,stage:'line_unverified'};
    out.history_recheck_match=historiesMatch(first,second,chat,session);
    if(!out.history_recheck_match)return {...out,stage:'history_recheck_unverified'};
    let offset=0, record=null, paginationProblem=null;
    for(let page=0;page<MAX_PAGES;page++) {
      let response;
      try{response=await reader.request('imopenlines.v2.Session.list',{configId:Number(line.config),dateCreateFrom:FROM,dateCreateTo:cutoff,
        limit:LIMIT,offset,order:'dateCreate',orderDirection:'desc'});}
      catch{paginationProblem='request_unavailable';break;}
      const rows=response?.result?.sessions,hasNext=response?.result?.hasNextPage;
      if(!Array.isArray(rows)||rows.length>LIMIT){paginationProblem='session_list_invalid';break;}
      out.session_pages++;out.session_rows+=rows.length;
      const hits=rows.filter(r=>numericId(r?.id)===session);
      if(hits.length>1 || (hits.length && record)){paginationProblem='session_duplicate';break;}
      if(hits.length){record=hits[0];out.session_found=true;}
      if(!bool(hasNext)||(hasNext&&rows.length!==LIMIT)){paginationProblem='session_list_invalid';break;}
      out.pagination_exhausted=!hasNext;
      if(!hasNext)break;
      offset+=rows.length;
    }
    let recordProblem=null;
    if(record){
      out.session_chat_matches=numericId(record.chatId)===chat;
      out.session_line_matches=numericId(record.configId)===line.config;
      const entity=record.crmEntityType, entityId=record.crmEntityId;
      out.session_crm=entity==null||entityId==null||entity===''||entityId===''?'missing'
        :String(entity).toLowerCase()==='deal' && numericId(entityId)===DEAL?'matches':'different';
      const created=strictDate(record.dateCreate);
      out.session_created_before_lose=created===null?null:created<=lose;
      if(!out.session_chat_matches)recordProblem='session_chat_mismatch';
      else if(!out.session_line_matches)recordProblem='session_line_mismatch';
      else if(out.session_crm!=='matches')recordProblem='crm_unverified';
      else if(out.session_created_before_lose!==true)recordProblem='session_time_unverified';
      if(record.dateClose!=null && record.dateClose!==''){
        const closed=strictDate(record.dateClose);
        if(closed===null||created===null||closed<created)recordProblem=recordProblem||'session_time_unverified';
        else out.session_close_after_lose=closed>lose;
      }
    }
    const latest=(await reader.request('imopenlines.session.history.get',{CHAT_ID:Number(chat)}))?.result;
    const latestLine=lineInfo(latest,chat);
    if(!latestLine||latestLine.entity!==line.entity){out.line_identifiers_match=false;return {...out,stage:'line_unverified'};}
    if(!historiesMatch(first,latest,chat,session)){out.history_recheck_match=false;return {...out,stage:'history_recheck_unverified'};}
    if(paginationProblem)return {...out,stage:paginationProblem};
    if(out.pagination_exhausted!==true)return {...out,stage:'pagination_incomplete'};
    if(!record)return {...out,stage:'session_not_found'};
    if(recordProblem)return {...out,stage:recordProblem};
    return {...out,status:'verified',stage:'session_link_verified'};
  } catch { return {...out,stage:'request_unavailable'}; }
}

function dependencies({bitrixBaseUrl,signal}) {
  const base=new URL(bitrixBaseUrl);
  if(base.protocol!=='https:'||base.hostname!=='dinalnsk.bitrix24.ru'||base.username||base.password||base.port||base.search||base.hash
      ||!/^\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(base.pathname))throw new Error('Адрес запрещён');
  const limiter=createBitrixLimiter();
  const client=createBitrixClient({baseUrl:base.href,limiter,fetchImpl:(url,options={})=>{
    const target=new URL(url);if(target.origin!==base.origin||!target.pathname.startsWith(base.pathname.replace(/\/$/,'')+'/'))throw new Error('Адрес запрещён');
    return fetch(url,{...options,redirect:'error',signal:options.signal?AbortSignal.any([signal,options.signal]):signal});
  }});
  const no=async()=>{throw new Error('Внешние вызовы отключены');};
  return Object.freeze({bitrix:client,llm:{complete:no},transcribe:no,downloadFile:no,close(){limiter.close();}});
}

export async function runSessionDiagnostic({pilotCommand=runPilotCommand,readBaselines=loadPilotBaselines,env=process.env}={}) {
  let output=null,baselineSeen=false,runs=0;
  const reader=async (...args)=>{const data=await readBaselines(...args);
    if(!data||!Array.isArray(data.baselines)||data.baselines.length!==1||String(data.baselines[0]?.deal_id)!==DEAL
       ||String(data.baselines[0]?.analysis_id)!==ANALYSIS)throw new Error('Эталон не подтверждён');baselineSeen=true;return data;};
  const summary=await pilotCommand({ids:[DEAL],env:{...env,POLZA_API_KEY:'disabled'},readBaselines:reader,deadlineMs:240000,
    makeDependencies:dependencies,startService:async()=>({address:'http://127.0.0.1:1',key:'disabled',tempRoot:resolve('.'),async close(){}}),
    makeRunner:({bitrix})=>({async run({dealId,baseline}){
      if(++runs!==1||Number(dealId)!==Number(DEAL)||String(baseline?.analysis_id)!==ANALYSIS)throw new Error('Границы не подтверждены');
      output=await inspectSession({client:bitrix,loseDate:baseline.lose_date});
      return {status:'blocked'};
    }})});
  if(!baselineSeen||runs!==1||!output||summary?.service_closed!==true||summary.selected!==1||summary.attempted!==1
      ||summary.statuses?.blocked!==1)throw new Error('Завершение не подтверждено');
  return output;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==4||process.argv[2]!=='--sealed'){console.error('Нужен защищённый режим');process.exitCode=1;}
  else Promise.resolve().then(()=>{sealEvidenceReport({service_closed:true},process.argv[3]);return runSessionDiagnostic();})
    .then(value=>console.log(JSON.stringify(sealEvidenceReport(value,process.argv[3]))))
    .catch(()=>{console.error('Проверка не завершена');process.exitCode=1;});
}
