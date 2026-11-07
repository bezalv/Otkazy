// Разовая выдача исходных записей пяти выбранных звонков для владельца.
// Запросы к Битриксу только на чтение; байты не покидают процесс иначе как в шифрованном конверте.
import { createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBitrixClient } from '../bitrix-client.mjs';
import { createBitrixLimiter } from '../bitrix-limiter.mjs';
import { fileIdFromStoredUrl, withAudioInspectionResources } from './audio-inspect.mjs';
import { audioMetadata } from './audio-verdict-check.mjs';

const PAIRS = new Map([['126554',new Set(['1660320'])], ['126956',new Set(['1665898'])],
  ['96621',new Set(['1315693','1317027','1454929'])]]);
const METHODS = new Set(['crm.activity.get','disk.file.get']);
export const MAX_AUDIO = 550000;
export const MAX_STDOUT = 1024 * 1024;
const ERRORS = new Set(['bitrix_error','audio_unavailable','unsupported_format','too_large','deadline','unexpected_error']);
class SafeError extends Error { constructor(code) { super('Экспорт не выполнен'); this.code=ERRORS.has(code)?code:'unexpected_error'; } }
function pair(deal, activity) {
  if (typeof deal!=='string'||typeof activity!=='string'||!PAIRS.get(deal)?.has(activity)) throw new Error('Пара не разрешена');
}
function publicKey(encoded) {
  if(typeof encoded!=='string'||encoded.length<100||encoded.length>8192||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Некорректный ключ');
  const raw=Buffer.from(encoded,'base64');
  if(raw.toString('base64')!==encoded)throw new Error('Некорректный ключ');
  const pem=raw.toString('utf8');
  if(!/^-----BEGIN (?:RSA )?PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END (?:RSA )?PUBLIC KEY-----\s*$/.test(pem))throw new Error('Некорректный ключ');
  const key=createPublicKey(pem);
  if(key.asymmetricKeyType!=='rsa'||!Number.isInteger(key.asymmetricKeyDetails?.modulusLength)||key.asymmetricKeyDetails.modulusLength<2048||key.asymmetricKeyDetails.modulusLength>4096)throw new Error('Некорректный ключ');
  return key;
}

/** Тот же формат, что sealEvidenceReport, но ограничение рассчитано на короткий аудиофайл. */
export function sealAudioReport(report, encodedPublicKey) {
  const key=publicKey(encodedPublicKey);
  if(!report||report.service_closed!==true)throw new Error('Завершение не подтверждено');
  if(report.status==='completed'&&(!Number.isInteger(report.bytes)||report.bytes<44||report.bytes>MAX_AUDIO
      ||typeof report.audio_base64!=='string'||report.audio_base64.length!==4*Math.ceil(report.bytes/3)))throw new Error('Аудио недопустимо');
  const plaintext=Buffer.from(JSON.stringify(report),'utf8');
  if(plaintext.length>Math.ceil(MAX_AUDIO*4/3)+4096){plaintext.fill(0);throw new Error('Слишком большой отчёт');}
  const sessionKey=randomBytes(32),iv=randomBytes(12);
  try {
    const cipher=createCipheriv('aes-256-gcm',sessionKey,iv);
    const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
    const encryptedKey=publicEncrypt({key,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},sessionKey);
    const result={sealed_version:1,algorithm:'RSA-OAEP-SHA256+A256GCM',encrypted_key:encryptedKey.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64'),service_closed:true};
    if(Buffer.byteLength(JSON.stringify(result)+'\n','utf8')>MAX_STDOUT)throw new Error('Превышен лимит вывода');
    return result;
  } finally {sessionKey.fill(0);plaintext.fill(0);}
}
function checkUrl(value) {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!=='dinalnsk.bitrix24.ru'||url.port||url.username||url.password)throw new SafeError('audio_unavailable');
  return url;
}
function activityFileId(activity) {
  const entries=Array.isArray(activity?.FILES)?activity.FILES:Object.values(activity?.FILES||{});
  const urls=entries.map(x=>x?.urlDownload||x?.URL_DOWNLOAD||x?.url).filter(x=>typeof x==='string');
  if(typeof activity?.SETTINGS?.RECORD_URL==='string')urls.push(activity.SETTINGS.RECORD_URL);
  const ids=[...new Set(urls.map(fileIdFromStoredUrl).filter(Boolean))];
  if(ids.length!==1)throw new SafeError('audio_unavailable');
  return Number(ids[0]);
}
async function boundedBytes(response) {
  if(!response?.ok||!response.body){await response?.body?.cancel?.().catch(()=>{});throw new SafeError('audio_unavailable');}
  const declared=Number(response.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>MAX_AUDIO){await response.body.cancel().catch(()=>{});throw new SafeError('too_large');}
  const chunks=[];let size=0;
  try {
    for await(const input of response.body){const part=Buffer.from(input);size+=part.length;if(size>MAX_AUDIO){part.fill(0);throw new SafeError('too_large');}chunks.push(part);}
    return Buffer.concat(chunks,size);
  } finally {for(const part of chunks)part.fill(0);}
}
async function download(value, fetchImpl, signal) {
  let url=checkUrl(value);
  for(let redirects=0;redirects<=3;redirects++){
    signal.throwIfAborted();
    const response=await fetchImpl(url,{method:'GET',redirect:'manual',signal});
    if([301,302,303,307,308].includes(response.status)){
      const location=response.headers.get('location');await response.body?.cancel?.().catch(()=>{});
      if(!location||redirects===3)throw new SafeError('audio_unavailable');
      url=checkUrl(new URL(location,url));continue;
    }
    const type=(response.headers.get('content-type')||'').toLowerCase();
    if(type.includes('text/html')||type.includes('application/json')){await response.body?.cancel?.().catch(()=>{});throw new SafeError('audio_unavailable');}
    return boundedBytes(response);
  }
  throw new SafeError('audio_unavailable');
}
export async function exportAudio({dealId,activityId,client,fetchImpl=fetch,signal,onPhase=()=>{}}) {
  pair(dealId,activityId);
  if(!client||typeof client.request!=='function'||typeof fetchImpl!=='function'||!signal||typeof signal.throwIfAborted!=='function')throw new Error('Неверные параметры');
  const call=async(method,body)=>{if(!METHODS.has(method))throw new Error('Метод запрещён');signal.throwIfAborted();return client.request(method,body,{signal});};
  onPhase('bitrix_lookup');
  let activity;
  try {activity=(await call('crm.activity.get',{id:Number(activityId)}))?.result;
    if(String(activity?.ID)!==activityId||Number(activity.OWNER_TYPE_ID)!==2||String(activity.OWNER_ID)!==dealId||Number(activity.TYPE_ID)!==2)throw new Error('Неверный владелец');
  } catch {throw new SafeError('bitrix_error');}
  const id=activityFileId(activity);
  let file;
  try {file=await call('disk.file.get',{id});}catch{throw new SafeError('bitrix_error');}
  if(typeof file?.result?.DOWNLOAD_URL!=='string')throw new SafeError('audio_unavailable');
  let bytes;
  try {
    onPhase('audio_download');
    try {bytes=await download(file.result.DOWNLOAD_URL,fetchImpl,signal);}catch(e){throw e instanceof SafeError?e:new SafeError('audio_unavailable');}
    let metadata;
    try {metadata=audioMetadata(bytes);}catch{throw new SafeError('unsupported_format');}
    signal.throwIfAborted();
    return {deal_id:dealId,activity_id:activityId,format:metadata.format,bytes:bytes.length,
      sha256:createHash('sha256').update(bytes).digest('hex'),audio_base64:bytes.toString('base64')};
  } finally {bytes?.fill(0);}
}
export async function runAudioExport({dealId,activityId,client,fetchImpl=fetch,closeLimiter,deadlineMs=150000,closeGraceMs=30000}) {
  pair(dealId,activityId);
  if(typeof closeLimiter!=='function')throw new Error('Неверные параметры');
  let phase='bitrix_lookup';
  const result=await withAudioInspectionResources({run:async signal=>{
    try{return await exportAudio({dealId,activityId,client,fetchImpl,signal,onPhase:x=>{phase=x;}});}
    catch(e){return {audio_error:true,phase,error_code:signal.aborted?'deadline':ERRORS.has(e?.code)?e.code:'unexpected_error'};}
  },closeLimiter,closePool:async()=>{},deadlineMs,closeGraceMs});
  return result.status==='error'?{status:'error',phase,error_code:'deadline',resources_closed:true,service_closed:true}
    :result.audio_error?{status:'error',phase:result.phase,error_code:result.error_code,resources_closed:true,service_closed:true}
      :{...result,service_closed:result.resources_closed===true};
}
async function main(){
  if(process.argv.length!==6||process.argv[4]!=='--sealed')throw new Error('Требуется защищённый вывод');
  const [,,dealId,activityId,,encodedPublicKey]=process.argv;pair(dealId,activityId);publicKey(encodedPublicKey);
  const base=new URL(process.env.BITRIX_REST_BASE);
  if(base.protocol!=='https:'||base.hostname!=='dinalnsk.bitrix24.ru'||base.username||base.password||base.port||base.search||base.hash||!/^\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(base.pathname))throw new Error('Неверный адрес');
  const limiter=createBitrixLimiter(),client=createBitrixClient({baseUrl:base.toString(),limiter});
  const report=await runAudioExport({dealId,activityId,client,closeLimiter:()=>limiter.close()});
  console.log(JSON.stringify(sealAudioReport(report,encodedPublicKey)));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Защищённая выгрузка не завершена');process.exitCode=1;});
