// Изолированная диагностика признаков авторства четырёх контрольных сделок.
// Только чтение открытых линий; никакие тексты, ID контактов и адреса не выводятся.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBitrixClient } from '../bitrix-client.mjs';
import { createBitrixLimiter } from '../bitrix-limiter.mjs';
import { withAudioInspectionResources } from './audio-inspect.mjs';
import { sealEvidenceReport } from './evidence-review.mjs';

const DEALS = new Set(['127114','126964','127132','117079','110459','118413']);
const MAX_MESSAGES = 5000, MAX_SESSIONS = 12, MAX_PAGES = 100;
const validId = value => /^[1-9]\d{0,15}$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value));
const safeDeal = value => typeof value === 'string' && DEALS.has(value);

const FIELDS = Object.freeze({
  message: ['ID','SENDERID','AUTHOR_ID','AUTHORID','DIRECTION','IS_INCOMING','IS_OUTGOING','ISINCOMING','ISOUTGOING','IS_ECHO','ISECHO','FROM_ME','FROMME','UUID','EXTERNAL_ID','CONNECTOR_ID','PARAMS','STATUS','SYSTEM'],
  params: ['DIRECTION','IS_INCOMING','IS_OUTGOING','ISINCOMING','ISOUTGOING','IS_ECHO','ISECHO','FROM_ME','FROMME','EXTERNAL_ID','MESSAGE_ID','MESSAGEID','CONNECTOR_ID','CONNECTORMID','AUTHOR_ID','AUTHORID','USER_ID','COMPONENT_ID','FILE_ID','CLASS'],
  user: ['ID','CONNECTOR','EXTRANET','EXTERNALAUTHID','ACTIVE'],
  chat: ['ID','ENTITY_ID','ENTITY_TYPE','ENTITY_DATA_1','ENTITY_DATA_2','ENTITY_DATA_3','CONNECTOR_ID'],
  dialog_message: ['ID','AUTHOR_ID','DIRECTION','UUID','EXTERNAL_ID','PARAMS'],
  dialog_params: ['DIRECTION','IS_INCOMING','IS_OUTGOING','IS_ECHO','ISECHO','FROM_ME','FROMME','EXTERNAL_ID','MESSAGE_ID','MESSAGEID','CONNECTOR_ID','CONNECTORMID','AUTHOR_ID','AUTHORID','USER_ID'],
});
const GROUPS = ['outgoing','incoming','headerless','other'];
const PREFIX = /^\s*(?:\[(?:B|I|U|S)\]\s*)*===\s*(Исходящее|Входящее)\s+сообщение(?:\s*,[^=\r\n]*)?\s*===/i;
const limitations = ['content_and_ids_not_returned','header_not_ground_truth','additional_dialog_latest_page_only','history_completeness_not_independently_confirmed'];

function normalizedFields(object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return {};
  const result = Object.create(null);
  for (const [key,value] of Object.entries(object)) {
    const upper = key.toUpperCase();
    if (Object.hasOwn(result, upper)) throw new Error('Неоднозначное имя поля');
    result[upper] = value;
  }
  return result;
}
function stats(scopes) {
  return Object.fromEntries(scopes.map(scope => [scope, Object.fromEntries(FIELDS[scope].map(key => [key,[0,0,0,0,0,0]]))]));
}
function account(result, scope, object) {
  const fields = normalizedFields(object), known = FIELDS[scope];
  for (const key of known) {
    if (!Object.hasOwn(fields,key)) continue;
    const value = fields[key];
    const index = value === null ? 0 : typeof value === 'string' ? 1 : typeof value === 'number' ? 2 : typeof value === 'boolean' ? 3 : Array.isArray(value) ? 4 : 5;
    result[scope][key][index]++;
  }
  return Object.keys(fields).filter(k => !known.includes(k)).length;
}
function sourceType(meta) {
  const c=String(meta?.CONNECTOR_ID||'').toLowerCase(),t=String(meta?.CONNECTOR_TITLE||'').toLowerCase();
  const idWz=c.includes('wazzup')||c.startsWith('wz_'),idWappi=c.includes('wappi');
  if((t.includes('wazzup')&&!idWz)||(t.includes('wappi')&&idWz))return 'other_or_unknown';
  return idWz?'wazzup':idWappi?'wappi':'other_or_unknown';
}
function comparableMid(value) {
  const v=Array.isArray(value)&&value.length===1?value[0]:value;
  return (typeof v==='string'&&v.length>0)||typeof v==='number'?String(v):null;
}
function directionBucket(value) {
  const o=normalizedFields(value), found=[]; let present=false;
  if(Object.hasOwn(o,'DIRECTION')){
    present=true;const d=typeof o.DIRECTION==='string'?o.DIRECTION.toLowerCase():'';
    if(['incoming','inbound'].includes(d))found.push('incoming');else if(['outgoing','outbound'].includes(d))found.push('outgoing');
  }
  for(const [key,d] of [['IS_INCOMING','incoming'],['ISINCOMING','incoming'],['IS_OUTGOING','outgoing'],['ISOUTGOING','outgoing']]){
    if(Object.hasOwn(o,key)){present=true;if(o[key]===true)found.push(d);}
  }
  const dirs=new Set(found);return dirs.size>1?'conflict':dirs.size===1?[...dirs][0]:present?'other':'missing';
}
function booleanFlag(value, keys) {
  const fields=normalizedFields(value), values=keys.filter(k=>Object.hasOwn(fields,k)).map(k=>fields[k]);
  if(!values.length)return 'missing';
  if(values.some(v=>typeof v!=='boolean'))return 'other';
  return new Set(values).size>1?'conflict':values[0]?'true':'false';
}

/** Только фиксированные поля, их типы и количество совпадений: без значений источника. */
export function summarizeHistory({dealId,chats,sessions,additional=[]}) {
  if(!safeDeal(dealId)||!Array.isArray(chats)||!Array.isArray(sessions)||sessions.length>MAX_SESSIONS||!Array.isArray(additional)||additional.length>MAX_SESSIONS)throw new TypeError('Недопустимая выборка');
  const meta=new Map();
  for(const c of chats){const id=String(c?.CHAT_ID??'');if(!validId(id)||meta.has(id))throw new Error('Неоднозначный чат');meta.set(id,c);}
  let total=0,totalChars=0;
  const reports=sessions.map((s,i)=>{
    const h=s?.history;if(!h||typeof h.message!=='object'||!h.message||Array.isArray(h.message)||typeof h.users!=='object'||!h.users)throw new Error('История неполна');
    const historyChats=Object.keys(h.chat||{}), chatId=String(s.chat_id??(historyChats.length===1?historyChats[0]:''));
    const buckets=()=>({incoming:0,outgoing:0,conflict:0,other:0,missing:0});
    const boolBuckets=()=>({true:0,false:0,conflict:0,other:0,missing:0});
    const groups=Object.fromEntries(GROUPS.map(g=>[g,{messages:0,unknown_fields:0,message_direction:buckets(),params_direction:buckets(),message_echo:boolBuckets(),message_from_me:boolBuckets(),params_echo:boolBuckets(),params_from_me:boolBuckets(),...stats(['message','params','user'])}]));
    const senderGroups=new Map(), connectorMids=new Map();
    for(const m of Object.values(h.message)){
      if(!m||typeof m!=='object'||Array.isArray(m))throw new Error('Некорректное сообщение');
      const raw=String(m.text||m.TEXT||'');totalChars+=raw.length;if(raw.length>500000||totalChars>5000000||++total>MAX_MESSAGES)throw new Error('Слишком много данных');
      const hdr=raw.match(PREFIX), group=hdr?(hdr[1].toLowerCase()==='исходящее'?'outgoing':'incoming'):/===\s*(?:Исходящее|Входящее)\s+сообщение/i.test(raw)?'other':'headerless';
      const item=groups[group];item.messages++;item.unknown_fields+=account(item,'message',m)+account(item,'params',m.params??m.PARAMS);
      item.message_direction[directionBucket(m)]++;item.params_direction[directionBucket(m.params??m.PARAMS)]++;
      item.message_echo[booleanFlag(m,['IS_ECHO','ISECHO'])]++;item.message_from_me[booleanFlag(m,['FROM_ME','FROMME'])]++;
      item.params_echo[booleanFlag(m.params??m.PARAMS,['IS_ECHO','ISECHO'])]++;item.params_from_me[booleanFlag(m.params??m.PARAMS,['FROM_ME','FROMME'])]++;
      const mid=comparableMid(normalizedFields(m.params??m.PARAMS).CONNECTORMID);
      if(mid!==null)connectorMids.set(mid,(connectorMids.get(mid)||0)+1);
      const sender=m.senderid??m.SENDER_ID??m.author_id??m.AUTHOR_ID;
      const user=sender==null?null:h.users?.[String(sender)];item.unknown_fields+=account(item,'user',user);
      if(sender!=null&&String(sender)!=='0'){const key=String(sender);if(!senderGroups.has(key))senderGroups.set(key,new Set());senderGroups.get(key).add(group);}
    }
    const chatStats=stats(['chat']);let unknownChatFields=0;
    for(const chat of Object.values(h.chat||{}))unknownChatFields+=account(chatStats,'chat',chat);
    const mixed=[...senderGroups.values()].filter(set=>set.has('outgoing')&&set.has('headerless')).length;
    return {session:i+1,connector:sourceType(meta.get(chatId)),chat_metadata_found:meta.has(chatId),groups,chat:chatStats.chat,unknown_chat_fields:unknownChatFields,
      sender_with_outgoing_and_headerless:mixed,connector_mid_comparable_values:[...connectorMids.values()].reduce((a,b)=>a+b,0),
      connector_mid_distinct_values:connectorMids.size,connector_mid_duplicate_occurrences:[...connectorMids.values()].reduce((a,b)=>a+Math.max(0,b-1),0)};
  });
  const extra=stats(['dialog_message','dialog_params','chat']);
  let dialogs_ok=0,dialogs_unavailable=0,pages_ok=0,pages_unavailable=0,matched_messages=0,matched_author_sender=0,matched_connector_mid=0,history_id_collisions=0,unknown_extra_fields=0;
  const historyMessages=new Map();
  for(const s of sessions)for(const [key,m] of Object.entries(s.history.message)){
    const chatIds=Object.keys(s.history.chat||{}),chatId=String(s.chat_id??(chatIds.length===1?chatIds[0]:''));
    const id=String(m?.id??m?.ID??key);
    if(validId(id)&&validId(chatId)){
      const compound=`${chatId}:${id}`;
      if(historyMessages.has(compound)){historyMessages.set(compound,null);history_id_collisions++;}
      else historyMessages.set(compound,m);
    }
  }
  for(const item of additional){
    if(item.dialog&&typeof item.dialog==='object'){dialogs_ok++;unknown_extra_fields+=account(extra,'chat',item.dialog);}else dialogs_unavailable++;
    if(Array.isArray(item.messages)){pages_ok++;for(const m of item.messages){
      unknown_extra_fields+=account(extra,'dialog_message',m)+account(extra,'dialog_params',m?.params??m?.PARAMS);
      const id=String(m?.id??m?.ID??''),chatId=String(item.chat_id??'');const h=validId(id)&&validId(chatId)?historyMessages.get(`${chatId}:${id}`):null;
      if(h){matched_messages++;const sender=h.senderid??h.SENDER_ID??h.author_id??h.AUTHOR_ID;const author=m.author_id??m.AUTHOR_ID;
        if(sender!=null&&author!=null&&String(sender)===String(author))matched_author_sender++;
        const hm=comparableMid(normalizedFields(h.params??h.PARAMS).CONNECTORMID),dm=comparableMid(normalizedFields(m.params??m.PARAMS).CONNECTORMID);
        if(hm!==null&&dm!==null&&hm===dm)matched_connector_mid++;}
    }}else pages_unavailable++;
  }
  return {deal_id:dealId,sessions:reports,session_count:reports.length,message_count:total,
    additional:{dialogs_ok,dialogs_unavailable,pages_ok,pages_unavailable,matched_messages,matched_author_sender,matched_connector_mid,history_id_collisions,unknown_fields:unknown_extra_fields,...extra},limitations};
}
async function getData(dealId,client,signal) {
  if(!safeDeal(dealId)||!client||typeof client.request!=='function')throw new TypeError('Недопустимая сделка');
  const request=async(method,body)=>{signal.throwIfAborted();if(!['imopenlines.crm.chat.get','crm.activity.list','imopenlines.session.history.get','im.dialog.messages.get','imopenlines.dialog.get'].includes(method))throw new Error('Метод запрещён');return client.request(method,body,{signal});};
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
  // По одной последней странице для каждого ранее подтверждённого чата: это
  // частичная проверка и не доказывает отсутствие более старых сообщений.
  const additional=[];
  for(const id of chatIds){
    let dialog=null,messages=null;
    try { const response=await request('imopenlines.dialog.get',{CHAT_ID:Number(id)}); if(response?.result&&typeof response.result==='object'&&!Array.isArray(response.result))dialog=response.result; } catch { signal.throwIfAborted(); }
    try { const response=await request('im.dialog.messages.get',{DIALOG_ID:`chat${id}`,LIMIT:50}); if(Array.isArray(response?.result?.messages)&&response.result.messages.length<=50)messages=response.result.messages; } catch { signal.throwIfAborted(); }
    additional.push({chat_id:id,dialog,messages});
  }
  return summarizeHistory({dealId,chats,sessions,additional});
}

export async function runSchemaCase({dealId,env=process.env,makeLimiter=createBitrixLimiter,makeClient=createBitrixClient}={}) {
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
    return runSchemaCase({dealId:process.argv[2]});}).then(value=>console.log(JSON.stringify(sealEvidenceReport(value,process.argv[4]))))
    .catch(()=>{console.error('Проверка не завершена');process.exitCode=1;});
}
