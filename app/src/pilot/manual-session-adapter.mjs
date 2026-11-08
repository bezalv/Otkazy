// Только ручной тихий эксперимент. Никакой очереди или доставки.
import { processDeal } from '../process-deal.mjs';
import { exactMillisTimestamp } from '../time-precision.mjs';
import { createGeneralSessionVerifier } from './general-session-verifier.mjs';
import { createSessionLookup } from './general-session-lookup.mjs';

const WINDOW_MS=366*24*60*60*1000;
const MAX_PAGES=20;
const id=value=>/^[1-9]\d{0,15}$/.test(String(value??''))&&Number.isSafeInteger(Number(value))?String(value):null;
const instant=value=>exactMillisTimestamp(value)?.getTime()??null;
const noMedia=async()=>{throw new Error('Медиа отключены в ручном текстовом опыте');};

/** Предел логических вызовов; повторы транспорта ограничивает его клиент. */
export function createManualModelLimiter(llm,{repairProofErrors=false,signal}={}){
  if(!llm||typeof llm.complete!=='function'||typeof repairProofErrors!=='boolean')throw new TypeError('Некорректный клиент модели');
  const counts={roles:0,judge:0,writer:0};
  return Object.freeze({async complete(body,options={}){
    signal?.throwIfAborted();
    const key=options.role==='chat-role-inference'?'roles':options.role;
    if(!Object.hasOwn(counts,key)||++counts[key]>(key==='roles'?3:key==='judge'&&repairProofErrors?2:1))throw new Error('Вызов модели запрещён');
    const result=await llm.complete(body,options);signal?.throwIfAborted();return result;
  }});
}

/** Закрывает запись и чужие сделки; ID истории допускаются только из ответов по данной сделке. */
function readOnlyDealClient(client,deal,from,cutoff,maxPages,signal){
  const chats=new Set(),sessions=new Set(),lines=new Set();let calls=0;
  return Object.freeze({async request(method,body={},options={}){
    signal?.throwIfAborted();
    if(++calls>600)throw new Error('Превышен предел чтения');
    const f=body?.filter||{};let allowed=false;
    if(method==='crm.deal.userfield.list')allowed=f.FIELD_NAME==='UF_CRM_1584703948317';
    else if(method==='crm.deal.get')allowed=id(body.id)===deal;
    else if(method==='crm.stagehistory.list')allowed=Number(body.entityTypeId)===2&&id(f.OWNER_ID)===deal;
    else if(method==='crm.activity.list')allowed=Number(f.OWNER_TYPE_ID)===2&&id(f.OWNER_ID)===deal;
    else if(method==='crm.timeline.comment.list')allowed=id(f.ENTITY_ID)===deal&&f.ENTITY_TYPE==='deal';
    else if(method==='tasks.task.list')allowed=Array.isArray(f.UF_CRM_TASK)&&f.UF_CRM_TASK.length===1&&f.UF_CRM_TASK[0]===`D_${deal}`;
    else if(method==='imopenlines.crm.chat.get')allowed=body.CRM_ENTITY_TYPE==='deal'&&id(body.CRM_ENTITY)===deal&&body.ACTIVE_ONLY==='N';
    else if(method==='imopenlines.session.history.get'){
      const chat=id(body.CHAT_ID),session=id(body.SESSION_ID);
      allowed=Object.keys(body).length===1&&Boolean(chat&&chats.has(chat)||session&&sessions.has(session));
    }else if(method==='imopenlines.v2.Session.list'){
      const line=id(body.configId);
      allowed=Object.keys(body).sort().join(',')==='configId,dateCreateFrom,dateCreateTo,limit,offset,order,orderDirection'
        &&!!line&&lines.has(line)&&body.dateCreateFrom===from&&body.dateCreateTo===cutoff
        &&body.limit===200&&Number.isSafeInteger(body.offset)&&body.offset>=0&&body.offset%200===0&&body.offset<maxPages*200
        &&body.order==='dateCreate'&&body.orderDirection==='desc';
    }
    if(!allowed)throw new Error('Метод чтения вне выбранной сделки запрещён');
    const combined=signal&&options.signal?AbortSignal.any([signal,options.signal]):signal||options.signal;
    const response=await client.request(method,body,{...options,...(combined?{signal:combined}:{})});
    signal?.throwIfAborted();
    if(method==='imopenlines.crm.chat.get'&&Array.isArray(response?.result))for(const item of response.result){const chat=id(item?.CHAT_ID);if(chat)chats.add(chat);}
    if(method==='crm.activity.list'&&f.PROVIDER_ID==='IMOPENLINES_SESSION'&&Array.isArray(response?.result))
      for(const item of response.result){const session=id(item?.ASSOCIATED_ENTITY_ID);if(session)sessions.add(session);}
    if(method==='imopenlines.session.history.get'){
      const h=response?.result,requestedChat=id(body.CHAT_ID),returnedChat=id(h?.chatId),session=id(h?.sessionId);
      if(requestedChat&&requestedChat===returnedChat&&session)sessions.add(session);
      // Линия допускается только из истории ранее обнаруженного чата или сессии.
      if(returnedChat&&chats.has(returnedChat)&&session&&sessions.has(session)){
        const entity=h?.chat?.[returnedChat]?.entityId,parts=typeof entity==='string'?entity.split('|'):[];
        if(parts.length===4&&parts.every(x=>x&&x.trim()===x)){const line=id(parts[1]);if(line)lines.add(line);}
      }
    }
    return response;
  }});
}

/**
 * Один явно выбранный переход, без записи и доставки. Получившийся разбор
 * предварительный: проверка одной сессии не устанавливает полноту всей истории.
 * `result` содержит исходные данные и не предназначен для открытого логирования.
 */
export async function runManualSessionPilot({dealId,expectedHistoryId,expectedLoseDate,from,maxPages=MAX_PAGES,
  silent,semanticChatRoles,repairProofErrors=false,bitrix,llm,judgeSystemPrompt,writerSystemPrompt,audioWaitEnabledAt,
  savedAudioWait=null,nowMs=null,clock=Date.now,wait,signal}={}){
  const deal=id(dealId),transition=id(expectedHistoryId),cutoffMs=instant(expectedLoseDate),fromMs=instant(from);
  if(silent!==true||semanticChatRoles!==true)throw new Error('Доступен только явный тихий ручной эксперимент');
  if(typeof repairProofErrors!=='boolean')throw new TypeError('Неверный флаг исправления доказательств');
  if(!deal||!transition||cutoffMs===null||fromMs===null||fromMs>cutoffMs||cutoffMs-fromMs>WINDOW_MS
    ||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>MAX_PAGES
    ||!bitrix||typeof bitrix.request!=='function'||!llm||typeof llm.complete!=='function'
    ||(signal!=null&&typeof signal.throwIfAborted!=='function'))throw new TypeError('Неполные ограничения ручного опыта');
  signal?.throwIfAborted();
  const start=new Date(fromMs).toISOString(),cutoff=new Date(cutoffMs).toISOString();
  const reader=readOnlyDealClient(bitrix,deal,start,cutoff,maxPages,signal);
  const lookup=createSessionLookup({client:reader,from:start,maxPages,signal});
  const identityVerifier=createGeneralSessionVerifier({client:reader,lookupSession:lookup,dealId:deal,transitionId:transition,purpose:'session_identity'});
  const restrictedLlm=createManualModelLimiter(llm,{repairProofErrors,signal});
  const result=await processDeal({dealId:Number(deal),bitrix:reader,llm:restrictedLlm,resolveFile:noMedia,downloadFile:noMedia,
    transcribe:noMedia,judgeSystemPrompt,writerSystemPrompt,audioWaitEnabledAt,savedAudioWait,
    silent:true,screenshots:false,semanticChatRoles:true,repairProofErrors,verifyFallbackSession:identityVerifier,verifyLatestSession:identityVerifier,
    expectedHistoryId:transition,expectedLoseDate:cutoff,nowMs,clock,wait});
  signal?.throwIfAborted();
  return {status:result.status==='processed'?'unverified':result.status,preliminary:result,
    history_complete:null,delivery_permitted:false,
    limitations:['one_session_not_full_history','text_only','screenshots_disabled','no_delivery','semantic_roles_are_inference']};
}
