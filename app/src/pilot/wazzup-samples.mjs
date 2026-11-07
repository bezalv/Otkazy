// Изолированная диагностика признаков авторства четырёх контрольных сделок.
// Только чтение открытых линий; никакие тексты, ID контактов и адреса не выводятся.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBitrixClient } from '../bitrix-client.mjs';
import { createBitrixLimiter } from '../bitrix-limiter.mjs';
import { withAudioInspectionResources } from './audio-inspect.mjs';
import { sealEvidenceReport } from './evidence-review.mjs';

const DEALS = new Set(['127114','126964','127132','126470']);
const MAX_MESSAGES = 5000, MAX_SESSIONS = 12, MAX_PAGES = 100, MAX_EXAMPLES = 8, MAX_SENDERS = 8;
const validId = value => /^[1-9]\d{0,15}$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value));
const safeDeal = value => typeof value === 'string' && DEALS.has(value);
const flags = /===\s*(Исходящее|Входящее)\s+сообщение(?:\s*,[^=]*)?\s*===/giu;
const headerAuthor = /===\s*(?:Исходящее|Входящее)\s+сообщение,\s*автор:\s*[^(]*\(([^)]+)\)/u;
const oldHeader = /=== (?:Исходящее|Входящее) сообщение/;

function headers(value) {
  const raw=String(value||''), matches=[...raw.matchAll(flags)];
  const directions=[...new Set(matches.map(m=>m[1].toLowerCase()==='исходящее'?'outgoing':'incoming'))];
  const first=matches[0];
  const before=first ? raw.slice(0,first.index) : '';
  const quoted=first && (/(?:\[quote(?:=[^\]]*)?\]|^\s*>{1,2})/imu.test(before));
  const prefix=before.replace(/\[\/?\w[\w= ]*\]/g,'').trim();
  const position=!first?'none':quoted?'quote':prefix===''?'start':'embedded';
  const direction=position==='start'?(first[1].toLowerCase()==='исходящее'?'outgoing':'incoming'):(directions.length>1?'conflict':directions[0]||'none');
  return {direction, count:matches.length, position,
    author_present:first?headerAuthor.test(first[0]):false};
}
function hint(value) {
  const text=String(value||'').replace(flags,'').toLowerCase();
  if(/(?:предлагаем|можем.{0,45}предложить|сможем.{0,45}озвучить|ваш.{0,20}адрес|подбер[её]м.{0,25}дату)/u.test(text))return 'seller_offer';
  if(/(?:заказал[аи]? у других|нашли поставщика|не надо менять|не нужно|не актуальн|откажусь)/u.test(text))return 'client_refusal_candidate';
  if(/(?:удобно.{0,40}(?:замер|специалист|конструктор)|жд[её]те.{0,30}(?:замер|конструктор))/u.test(text))return 'appointment';
  return 'other';
}
function isWazzup(meta) {
  const connector=String(meta?.CONNECTOR_ID||''),title=String(meta?.CONNECTOR_TITLE||connector);
  return title.toLowerCase().includes('wazzup')||connector.toLowerCase().includes('wazzup')||connector.startsWith('wz_');
}
function originalRole(msg,user,isWz) {
  const raw=String(msg?.text||msg?.TEXT||'');
  if(headerAuthor.test(raw))return 'manager';
  if(user)return user.connector===true||user.extranet===true||user.externalAuthId==='imconnector'?'client':'manager';
  if(isWz&&!oldHeader.test(raw))return 'client';
  return 'unknown';
}
function sourceType(meta){if(isWazzup(meta))return 'wazzup';const c=String(meta?.CONNECTOR_ID||'').toLowerCase(),t=String(meta?.CONNECTOR_TITLE||'').toLowerCase();return c.includes('wappi')||t.includes('wappi')?'wappi':'other_or_unknown';}
function safeTimestamp(value) {if(value==null||value==='')return null;const n=new Date(value).getTime();return Number.isFinite(n)?new Date(n).toISOString():null;}

/** Возвращает только структурные признаки и безопасные псевдонимы, не сырые тексты. */
export function summarizeHistory({dealId,chats,sessions}) {
  if(!safeDeal(dealId)||!Array.isArray(chats)||!Array.isArray(sessions)||sessions.length>MAX_SESSIONS)throw new TypeError('Недопустимая выборка');
  const meta=new Map();
  for(const c of chats){const id=String(c?.CHAT_ID??'');if(!validId(id)||meta.has(id))throw new Error('Неоднозначный чат');meta.set(id,c);}
  let total=0,totalChars=0;
  const reports=sessions.map((s,sessionIndex)=>{
    const h=s?.history;if(!h||typeof h.message!=='object'||!h.message||Array.isArray(h.message)||typeof h.users!=='object'||!h.users)throw new Error('История неполна');
    const historyChats=Object.keys(h.chat||{});
    const chatId=String(s.chat_id??(historyChats.length===1?historyChats[0]:'')), chat=meta.get(chatId), connector=sourceType(chat), wz=connector==='wazzup';
    const entries=Object.values(h.message);total+=entries.length;if(total>MAX_MESSAGES)throw new Error('Превышено число сообщений');
    const counts={messages:0,outgoing_start:0,incoming_start:0,conflict:0,embedded_or_quoted:0,headerless:0,outgoing_as_client:0};
    const senders=new Map(),messages=[];
    for(const [messageIndex,m] of entries.entries()){
      if(!m||typeof m!=='object')throw new Error('Некорректное сообщение');
      const raw=String(m.text||m.TEXT||''), senderValue=m.senderid??m.SENDER_ID??m.author_id??m.AUTHOR_ID;
      const senderMissing=senderValue==null||senderValue==='';
      const sid=senderMissing?`missing_${messageIndex}`:String(senderValue);
      totalChars+=raw.length;if(raw.length>500000||totalChars>5000000)throw new Error('Превышен размер сообщений');
      const user=!senderMissing&&sid!=='0'?h.users?.[sid]:null, hdr=headers(raw),role=originalRole(m,user,wz);
      counts.messages++;
      if(hdr.direction==='conflict')counts.conflict++;
      else if(hdr.position==='start'&&hdr.direction==='outgoing')counts.outgoing_start++;
      else if(hdr.position==='start'&&hdr.direction==='incoming')counts.incoming_start++;
      else if(hdr.position==='none')counts.headerless++;
      else counts.embedded_or_quoted++;
      if(hdr.position==='start'&&hdr.direction==='outgoing'&&role==='client')counts.outgoing_as_client++;
      if(!senders.has(sid))senders.set(sid,`sender_${senders.size+1}`);
      messages.push({sender:senders.get(sid),sender_lookup:senderMissing?'sender_id_missing':sid==='0'?'zero':user?'matched':'user_missing',
        timestamp:safeTimestamp(m.date||m.DATE),
        connector:typeof user?.connector==='boolean'?user.connector:null,extranet:typeof user?.extranet==='boolean'?user.extranet:null,
        external_auth:user?.externalAuthId==='imconnector'?'imconnector':user?.externalAuthId==null?'missing':'other',
        header_direction:hdr.direction,header_position:hdr.position,header_count:hdr.count,header_author_present:hdr.author_present,
        old_role:role,content_hint:hint(raw),content_not_returned:true});
    }
    // Равномерно показываем разные сочетания — не выбираем по исходу модели.
    const keys=new Set(),examples=[];
    for(const m of messages){const key=[m.sender,m.header_direction,m.header_position,m.header_author_present,m.old_role,m.content_hint].join('|');
      if(keys.has(key))continue;keys.add(key);if(examples.length<MAX_EXAMPLES)examples.push(m);}
    const senderNames=[...new Set(messages.map(m=>m.sender))];
    const sender_summary=senderNames.slice(0,MAX_SENDERS).map(sender=>{const own=messages.filter(m=>m.sender===sender);
      return {sender,messages:own.length,outgoing_start:own.filter(m=>m.header_position==='start'&&m.header_direction==='outgoing').length,
        incoming_start:own.filter(m=>m.header_position==='start'&&m.header_direction==='incoming').length,
        headerless:own.filter(m=>m.header_position==='none').length};});
    return {session:`session_${sessionIndex+1}`,connector,chat_metadata_found:!!chat,counts,sender_summary,senders_total:senderNames.length,senders_omitted:Math.max(0,senderNames.length-sender_summary.length),examples,
      examples_omitted:Math.max(0,keys.size-examples.length)};
  });
  return {deal_id:dealId,sessions:reports,session_count:reports.length,message_count:total,
    limitations:['content_not_returned','semantic_hint_not_author_proof','history_completeness_not_independently_confirmed','sender_refs_are_session_local','connector_metadata_may_be_missing']};
}

async function getData(dealId,client,signal) {
  if(!safeDeal(dealId)||!client||typeof client.request!=='function')throw new TypeError('Недопустимая сделка');
  const request=async(method,body)=>{signal.throwIfAborted();if(!['imopenlines.crm.chat.get','crm.activity.list','imopenlines.session.history.get'].includes(method))throw new Error('Метод запрещён');return client.request(method,body,{signal});};
  const chatReply=await request('imopenlines.crm.chat.get',{CRM_ENTITY_TYPE:'deal',CRM_ENTITY:Number(dealId),ACTIVE_ONLY:'N'});
  if(!Array.isArray(chatReply?.result)||chatReply.result.length>MAX_SESSIONS)throw new Error('Список чатов не подтверждён');
  const chats=chatReply.result,chatIds=new Set();
  for(const c of chats){const id=String(c?.CHAT_ID??'');if(!validId(id)||chatIds.has(id))throw new Error('ID чата не подтверждён');chatIds.add(id);}
  let start=0,total=null;const seenCursors=new Set(),activityIds=new Set(),sessionIds=new Set();
  for(let page=0;;page++){
    if(page>=MAX_PAGES||seenCursors.has(start))throw new Error('Пагинация не подтверждена');seenCursors.add(start);
    const response=await request('crm.activity.list',{filter:{OWNER_TYPE_ID:2,OWNER_ID:Number(dealId),PROVIDER_ID:'IMOPENLINES_SESSION'},select:['ID','ASSOCIATED_ENTITY_ID'],order:{CREATED:'ASC'},start});
    const items=response?.result;if(!Array.isArray(items)||items.length>50)throw new Error('Страница не подтверждена');
    if(response.total!=null){const n=Number(response.total);if(!Number.isSafeInteger(n)||n<0||(total!==null&&total!==n))throw new Error('Размер не подтверждён');total=n;}
    for(const item of items){const id=String(item?.ID??''),sid=String(item?.ASSOCIATED_ENTITY_ID??'');
      if(!validId(id)||!validId(sid)||activityIds.has(id))throw new Error('Сессия не подтверждена');activityIds.add(id);sessionIds.add(sid);}
    if(sessionIds.size>MAX_SESSIONS||activityIds.size>MAX_SESSIONS*10)throw new Error('Слишком много сессий');
    if(response.next==null||response.next===false){if((total!==null&&activityIds.size!==total)||(total===null&&items.length===50))throw new Error('Полнота не подтверждена');break;}
    const next=Number(response.next);if(!Number.isSafeInteger(next)||next!==start+items.length||!items.length)throw new Error('Курсор не подтверждён');start=next;
  }
  const sessions=[],loadedChats=new Set();
  for(const sid of sessionIds){const response=await request('imopenlines.session.history.get',{SESSION_ID:Number(sid)});
    const history=response?.result;if(!history||typeof history.message!=='object'||!history.message)throw new Error('История не подтверждена');
    sessions.push({history});if(Object.keys(history.message).length)for(const id of Object.keys(history.chat||{}))if(validId(id))loadedChats.add(id);}
  for(const id of chatIds){if(loadedChats.has(id))continue;const response=await request('imopenlines.session.history.get',{CHAT_ID:Number(id)});
    const history=response?.result;if(!history||typeof history.message!=='object'||!history.message)throw new Error('История не подтверждена');sessions.push({chat_id:id,history});}
  return summarizeHistory({dealId,chats,sessions});
}

export async function runSampleCase({dealId,env=process.env,makeLimiter=createBitrixLimiter,makeClient=createBitrixClient}={}) {
  if(!safeDeal(dealId))throw new TypeError('Сделка не разрешена');
  const base=new URL(env.BITRIX_REST_BASE);
  if(base.protocol!=='https:'||base.hostname!=='dinalnsk.bitrix24.ru'||base.username||base.password||base.port||base.search||base.hash||!/^\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(base.pathname))throw new Error('Адрес не подтверждён');
  const limiter=makeLimiter(),client=makeClient({baseUrl:base.toString(),limiter});
  const result=await withAudioInspectionResources({closeLimiter:()=>limiter.close(),closePool:async()=>{},deadlineMs:120000,
    run:signal=>getData(dealId,client,signal)});
  if(result.resources_closed!==true)throw new Error('Завершение не подтверждено');
  return result.status==='completed'?{...result,status:'observed',service_closed:true}:{status:'unverified',deal_id:dealId,service_closed:true};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==5||process.argv[3]!=='--sealed'){console.error('Нужен защищённый режим');process.exitCode=1;}
  else Promise.resolve().then(()=>{if(!safeDeal(process.argv[2]))throw new Error('Сделка не разрешена');sealEvidenceReport({service_closed:true},process.argv[4]);
    return runSampleCase({dealId:process.argv[2]});}).then(value=>console.log(JSON.stringify(sealEvidenceReport(value,process.argv[4]))))
    .catch(()=>{console.error('Проверка не завершена');process.exitCode=1;});
}
