// Одноразовая диагностика скриншотов сделки 126548. Ни БД, ни судья, ни STT здесь не используются.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createBitrixClient } from '../bitrix-client.mjs';
import { createBitrixLimiter } from '../bitrix-limiter.mjs';
import { createPolzaClient } from '../polza-client.mjs';
import { downloadFile as standardDownload } from '../media/download.mjs';
import { normalizeCommunications } from '../collect/normalize.mjs';
import { processScreenshots } from '../screenshots/process.mjs';
import { sealEvidenceReport } from './evidence-review.mjs';

const DEAL = 126548;
const METHODS = new Set(['crm.timeline.comment.list', 'disk.file.get']);
const MODEL = 'anthropic/claude-sonnet-4.6';
const MAX_COMMENTS = 1000, MAX_IMAGES = 20, MAX_EVENTS = 150;
const positiveId = value => /^[1-9]\d{0,29}$/.test(String(value ?? ''));
const httpStatus = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;

function mime(buffer) {
  if (!Buffer.isBuffer(buffer)) return 'unknown';
  if (buffer.length > 8 && buffer.subarray(0,4).equals(Buffer.from([137,80,78,71]))) return 'image/png';
  if (buffer.length > 3 && buffer.subarray(0,3).equals(Buffer.from([255,216,255]))) return 'image/jpeg';
  if (buffer.length > 12 && buffer.toString('latin1',0,4)==='RIFF' && buffer.toString('latin1',8,12)==='WEBP') return 'image/webp';
  if (buffer.length > 6 && ['GIF87a','GIF89a'].includes(buffer.toString('latin1',0,6))) return 'image/gif';
  return 'unknown';
}

function responseSchema(response, expected) {
  const content=response?.choices?.[0]?.message?.content;
  const text=Array.isArray(content)?content.map(x=>typeof x?.text==='string'?x.text:'').join(''):content;
  if(typeof text!=='string')return {json:false,screenshots_array:false,turns_array:false,files_covered:false,turns_valid:false,expected};
  const raw=text.trim(), fenced=raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/), braced=raw.match(/\{[\s\S]*\}/);
  let parsed;try{parsed=JSON.parse(fenced?.[1]||raw);}catch{try{parsed=JSON.parse(braced?.[0]||'');}catch{return {json:false,screenshots_array:false,turns_array:false,files_covered:false,turns_valid:false,expected};}}
  const shots=parsed?.screenshots,turns=parsed?.turns,arr=Array.isArray(shots),ta=Array.isArray(turns);
  const idx=value=>typeof value==='number'&&Number.isInteger(value)?value:typeof value==='string'&&/^(0|[1-9]\d*)$/.test(value)?Number(value):-1;
  const ids=arr?shots.map(x=>idx(x?.file_id)):[];
  const covered=arr&&shots.length===expected&&new Set(ids).size===expected&&shots.every(x=>idx(x?.file_id)>=0&&idx(x?.file_id)<expected&&typeof x?.is_chat_screenshot==='boolean');
  const valid=ta&&turns.every(x=>x&&typeof x==='object'&&!Array.isArray(x)&&idx(x.file_id)>=0&&idx(x.file_id)<expected&&['manager','client','unknown'].includes(x.speaker)&&['text','attachment','time','date_label'].every(k=>x[k]===undefined||x[k]===null||typeof x[k]==='string'));
  return {json:true,screenshots_array:arr,turns_array:ta,files_covered:covered,turns_valid:valid,expected};
}

async function commentsForDeal(client,signal) {
  const rows=[],seen=new Set(),ids=new Set();let cursor=0,knownTotal=null;
  while(true){
    signal.throwIfAborted();if(seen.has(cursor))throw new Error('cursor');seen.add(cursor);
    const page=await client.request('crm.timeline.comment.list',{filter:{ENTITY_ID:DEAL,ENTITY_TYPE:'deal'},select:['ID','CREATED','AUTHOR_ID','COMMENT','FILES'],start:cursor},{signal});
    if(!Array.isArray(page?.result)||page.result.length>50)throw new Error('page');
    if(page.total!==undefined&&page.total!==null){const total=Number(page.total);
      if(!Number.isSafeInteger(total)||total<0||(knownTotal!==null&&knownTotal!==total))throw new Error('total');knownTotal=total;}
    for(const item of page.result){const id=String(item?.ID??'');if(!positiveId(id)||ids.has(id))throw new Error('duplicate');ids.add(id);}
    rows.push(...page.result);if(rows.length>MAX_COMMENTS)throw new Error('limit');
    if(knownTotal!==null&&rows.length>knownTotal)throw new Error('total');
    if(page.next===undefined||page.next===null||page.next===false){
      if(knownTotal!==null&&knownTotal!==rows.length)throw new Error('incomplete');
      if(knownTotal===null&&page.result.length===50)throw new Error('incomplete');
      return rows;
    }
    const next=Number(page.next);if(!Number.isSafeInteger(next)||next!==cursor+page.result.length||page.result.length===0)throw new Error('cursor');cursor=next;
  }
}

/** Только категории/счётчики; исходные комментарии, скриншоты и ответ модели не возвращаются. */
export async function inspectScreenshots({client,model,download=standardDownload,fetchImpl=fetch,signal}) {
  if(!client||typeof client.request!=='function'||!model||typeof model.complete!=='function'||typeof download!=='function'||!signal||typeof signal.throwIfAborted!=='function')throw new TypeError('dependencies');
  const events=[];const log=x=>{if(events.length>=MAX_EVENTS)throw new Error('limit');events.push(x);};
  const allowed={request(method,body,options){if(!METHODS.has(method))throw new Error('method');
    if(method==='crm.timeline.comment.list'&&(body?.filter?.ENTITY_ID!==DEAL||body?.filter?.ENTITY_TYPE!=='deal'))throw new Error('deal');
    if(method==='disk.file.get'&&!positiveId(body?.id))throw new Error('id');
    signal.throwIfAborted();return client.request(method,body,{...options,signal});}};
  let comments;
  try{comments=await commentsForDeal(allowed,signal);log({stage:'comments',outcome:'ok',count:comments.length});}
  catch(e){return {status:'error',stage:'comments',code:signal.aborted?'deadline':'comments_unavailable',http_status:httpStatus(e?.status),events};}
  const sources=Object.fromEntries(['calls','comments','tasks','openlines'].map(k=>[k,{complete:true}]));
  // Пустые источники здесь только для нормализации комментариев: полнота остальных не проверялась.
  let normalized;
  try{normalized=await normalizeCommunications({collection:{_status:'pending_normalization',deal_id:DEAL,deal_data:{},silent:true,
    _sources:sources,raw:{comments,calls:[],tasks:[],chats:[],sessions:[]}},screenshots:true});}
  catch{return {status:'error',stage:'normalize',code:'normalization_failed',http_status:null,events};}
  const communications=normalized.deal_data.communications.filter(c=>c.type==='comment'&&Array.isArray(c.screenshots)&&c.screenshots.length);
  const images=communications.reduce((a,c)=>a+c.screenshots.length,0);
  log({stage:'normalize',outcome:'ok',comments:communications.length,images});
  if(images>MAX_IMAGES)return {status:'error',stage:'normalize',code:'image_count_limit',http_status:null,events};
  const attachments=new Map();
  for(const comment of communications)for(const shot of comment.screenshots){const key=String(shot.file_id);const list=attachments.get(key)||[];list.push(shot);attachments.set(key,list);}
  const validDate=value=>!!value&&Number.isFinite(new Date(value).getTime());
  const resolveFile=async id=>{
    try{const result=await allowed.request('disk.file.get',{id});const meta=result?.result||result;
      const matching=attachments.get(String(id))||[];
      const effective=matching.length===1?(matching[0].date||meta?.CREATE_TIME):null;
      log({stage:'resolve',outcome:typeof meta?.DOWNLOAD_URL==='string'?'ok':'missing_url',
        meta_date_valid:validDate(meta?.CREATE_TIME),effective_date_valid:matching.length===1?validDate(effective):null});return result;}
    catch(e){log({stage:'resolve',outcome:'error',http_status:httpStatus(e?.status)});throw e;}
  };
  const guardedFetch=async (value,options={})=>{
    signal.throwIfAborted();let u;try{u=new URL(value);}catch{log({stage:'download_http',outcome:'bad_url',http_status:null});throw new Error('url');}
    if(u.protocol!=='https:'||u.hostname!=='dinalnsk.bitrix24.ru'||u.port||u.username||u.password){log({stage:'download_http',outcome:'host_blocked',http_status:null});throw new Error('host');}
    try{const response=await fetchImpl(u,{...options,redirect:'manual',signal:options.signal?AbortSignal.any([signal,options.signal]):signal});
      log({stage:'download_http',outcome:response.ok?'ok':response.status>=300&&response.status<400?'redirect_blocked':'error',http_status:httpStatus(response.status)});return response;}
    catch(e){log({stage:'download_http',outcome:signal.aborted?'deadline':'network_error',http_status:null});throw e;}
  };
  const downloadFile=async(url,options)=>{try{const bytes=await download(url,{...options,fetchImpl:guardedFetch});
    log({stage:'download',outcome:'ok',bytes:Buffer.byteLength(bytes),mime:mime(Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes))});return bytes;}
    catch(e){log({stage:'download',outcome:signal.aborted?'deadline':'error',bytes:null,mime:null});throw e;}};
  const llm={async complete(body,{role}={}){
    if(role!=='screenshots'||body?.model!==MODEL)throw new Error('model');
    const content=body?.messages?.find(x=>x?.role==='user')?.content;
    const expected=Array.isArray(content)?content.filter(x=>x?.type==='image_url').length:0;
    try{const response=await model.complete(body,{role});signal.throwIfAborted();log({stage:'model',outcome:'ok',http_status:null,schema:responseSchema(response,expected)});return response;}
    catch(e){log({stage:'model',outcome:signal.aborted?'deadline':'error',http_status:httpStatus(e?.status),retryable:e?.retryable===true});throw e;}
  }};
  try{
    signal.throwIfAborted();const result=await processScreenshots({base:{communications},resolveFile,downloadFile,client:llm});signal.throwIfAborted();
    const stats=result.output?.screenshot_stats||{};
    const count=k=>{if(!Number.isSafeInteger(stats[k])||stats[k]<0)throw new Error('stats');return stats[k];};
    const total=count('screenshots_total'),downloaded=count('screenshots_downloaded');
    if(downloaded>total)throw new Error('stats');
    // processScreenshots не агрегирует screenshots_download_failed, поэтому
    // считаем только по двум надёжно агрегируемым величинам, а не подставляем 0.
    const statsOut={screenshots_total:total,screenshots_downloaded:downloaded,screenshots_download_failed:total-downloaded,screenshots_extracted:count('screenshots_extracted'),screenshots_failed:count('screenshots_failed'),comments_failed:count('comments_failed'),llm_calls:count('llm_calls')};
    return {status:'completed',stage:'completed',code:null,http_status:null,images,stats:statsOut,failures:result.failures.length,events,
      limitations:['new_read_only_diagnostic_not_original_failure','other_sources_not_checked','redirects_limited_to_portal_host','screenshot_model_output_not_returned']};
  }catch(e){return {status:'error',stage:'processing',code:signal.aborted?'deadline':'processing_failed',http_status:null,events};}
}

/** Не выдаём service_closed, пока HTTP и ограничитель не закрыты. */
export async function runDiagnostic({client,model,download,fetchImpl=fetch,closeLimiter,deadlineMs=420000,closeGraceMs=30000}) {
  if(typeof closeLimiter!=='function'||!Number.isSafeInteger(deadlineMs)||deadlineMs<10||deadlineMs>420000||!Number.isSafeInteger(closeGraceMs)||closeGraceMs<10||closeGraceMs>30000)throw new TypeError('limits');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),deadlineMs);
  const work=Promise.resolve().then(()=>inspectScreenshots({client,model,download,fetchImpl,signal:controller.signal}));
  const stopped=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('deadline')),{once:true}));
  let result,failed=false,closeFailed=false;
  try{result=await Promise.race([work,stopped]);}catch{failed=true;}finally{
    clearTimeout(timer);controller.abort();try{closeLimiter();}catch{closeFailed=true;}
    let grace;try{const outcomes=await Promise.race([Promise.allSettled([work]),new Promise((_,reject)=>{grace=setTimeout(()=>reject(new Error('cleanup_unknown')),closeGraceMs);})]);
      if(closeFailed||outcomes.length!==1)throw new Error('cleanup_unknown');}finally{clearTimeout(grace);}
  }
  return failed?{status:'error',stage:'processing',code:'deadline',http_status:null,events:[],service_closed:true}
    :{...result,service_closed:true};
}

async function main(){
  if(process.argv.length!==4||process.argv[2]!=='--sealed')throw new Error('sealed');
  const pub=process.argv[3];sealEvidenceReport({service_closed:true},pub);
  const base=new URL(process.env.BITRIX_REST_BASE);
  if(base.protocol!=='https:'||base.hostname!=='dinalnsk.bitrix24.ru'||base.username||base.password||base.port||base.search||base.hash||!/^\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(base.pathname))throw new Error('base');
  if(!process.env.POLZA_API_KEY)throw new Error('key');
  const limiter=createBitrixLimiter(),client=createBitrixClient({baseUrl:base.toString(),limiter});
  // Сигнал верхнего уровня передаётся в каждый fetch и задержку повтора Polza.
  const modelFactory=signal=>createPolzaClient({apiKey:process.env.POLZA_API_KEY,
    fetchImpl:(url,opts={})=>fetch(url,{...opts,signal:opts.signal?AbortSignal.any([signal,opts.signal]):signal}),wait:ms=>delay(ms,undefined,{signal})});
  const model={complete(...args){return modelFactory(model.signal).complete(...args);}};
  // Привязываем контроллер диагностического прогона через обёртку dependency.
  const wrapped={request:client.request.bind(client)};
  const controller=new AbortController();
  model.signal=controller.signal;
  try{const report=await runDiagnostic({client:wrapped,model,fetchImpl:(url,opts={})=>fetch(url,{...opts,signal:opts.signal?AbortSignal.any([controller.signal,opts.signal]):controller.signal}),
      closeLimiter:()=>{controller.abort();limiter.close();}});
    console.log(JSON.stringify(sealEvidenceReport(report,pub)));
  }catch{controller.abort();limiter.close();throw new Error('failed');}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Диагностика не завершена');process.exitCode=1;});
