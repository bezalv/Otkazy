import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, constants, createDecipheriv } from 'node:crypto';
import { inspectScreenshots, runDiagnostic, responseMetadata } from '../../app/src/pilot/screen126548.mjs';
import { sealEvidenceReport } from '../../app/src/pilot/evidence-review.mjs';

const PNG=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const stamp='2026-10-01T00:00:00Z';
const comment=(id=1)=>({ID:id,CREATED:stamp,AUTHOR_ID:2,COMMENT:'private user comment',FILES:{12:{id:12,type:'image',date:stamp,name:'private-name.png'}}});
const validResponse=()=>({choices:[{message:{content:JSON.stringify({screenshots:[{file_id:0,is_chat_screenshot:true}],turns:[{file_id:0,speaker:'client',text:'private conversation'}]})}}]});
function fixtures({comments=[comment()],meta={DOWNLOAD_URL:'https://dinalnsk.bitrix24.ru/private',CREATE_TIME:stamp},bytes=PNG,response=validResponse()}={}) {
  const calls=[],client={async request(method,body){calls.push({method,body});if(method==='crm.timeline.comment.list')return {result:comments,total:comments.length};if(method==='disk.file.get')return {result:meta};throw new Error('forbidden');}};
  const model={async complete(body,opts){calls.push({method:'polza',model:body.model,role:opts.role});return response;}};
  const download=async (url,options)=>{const got=await options.fetchImpl(url,{});if(!got.ok)throw new Error('failed');return bytes;};
  const fetchImpl=async()=>new Response('ignored',{status:200});
  return {client,model,download,fetchImpl,calls};
}
const signal=()=>new AbortController().signal;

test('диагностика ограничена комментариями конкретной сделки и штатной моделью, без текстов и скриншотов в отчёте',async()=>{
  const f=fixtures(),result=await inspectScreenshots({...f,signal:signal()});
  assert.equal(result.status,'completed');assert.equal(result.images,1);assert.equal(result.failures,0);
  assert.deepEqual(f.calls.map(x=>x.method),['crm.timeline.comment.list','disk.file.get','polza']);
  assert.equal(f.calls[0].body.filter.ENTITY_ID,126548);assert.equal(f.calls[2].model,'anthropic/claude-sonnet-4.6');assert.equal(f.calls[2].role,'screenshots');
  const model=result.events.find(x=>x.stage==='model');assert.equal(model.schema.files_covered,true);assert.equal(model.schema.turns_valid,true);
  assert.doesNotMatch(JSON.stringify(result),/private|base64|DOWNLOAD_URL|https:|private conversation/);
});

test('ошибка скачивания или неподдерживаемый формат различимы и не вызывают модель',async()=>{
  for(const f of [fixtures({meta:{DOWNLOAD_URL:'https://evil.invalid/file',CREATE_TIME:stamp}}),fixtures({bytes:Buffer.from('not a supported image')})]){
    const result=await inspectScreenshots({...f,signal:signal()});assert.equal(result.status,'completed');assert.equal(result.failures,1);assert.equal(result.stats.screenshots_download_failed,1);assert.equal(result.stats.screenshots_downloaded,0);
    assert.equal(f.calls.some(x=>x.method==='polza'),false);
    assert.ok(result.events.some(x=>x.outcome==='host_blocked'||x.mime==='unknown'));
  }
});

test('частично скачанные скриншоты и отсутствие вложений дают корректные счётчики',async()=>{
  const c=comment();c.FILES[13]={id:13,type:'image',date:stamp,name:'another-private-name.png'};
  const f=fixtures({comments:[c]}),original=f.client.request;
  f.client.request=async(method,body)=>{if(method==='disk.file.get'&&String(body.id)==='13')throw new Error('not available');return original(method,body);};
  const partial=await inspectScreenshots({...f,signal:signal()});assert.equal(partial.status,'completed');assert.equal(partial.images,2);
  assert.equal(partial.stats.screenshots_total,2);assert.equal(partial.stats.screenshots_downloaded,1);assert.equal(partial.stats.screenshots_download_failed,1);assert.equal(partial.failures,1);
  const none=fixtures({comments:[]}),empty=await inspectScreenshots({...none,signal:signal()});
  assert.equal(empty.status,'completed');assert.equal(empty.images,0);assert.equal(empty.stats.screenshots_total,0);assert.equal(empty.stats.screenshots_download_failed,0);assert.equal(empty.failures,0);
});

test('проверяет фактическую дату вложения, а не только дату метаданных файла',async()=>{
  const f=fixtures({meta:{DOWNLOAD_URL:'https://dinalnsk.bitrix24.ru/private',CREATE_TIME:'invalid'}});
  const first=await inspectScreenshots({...f,signal:signal()});const event=first.events.find(x=>x.stage==='resolve');
  assert.equal(event.meta_date_valid,false);assert.equal(event.effective_date_valid,true);assert.equal(first.failures,0);
  const c=comment();c.FILES[12].date='invalid';const g=fixtures({comments:[c]}),second=await inspectScreenshots({...g,signal:signal()});
  const invalid=second.events.find(x=>x.stage==='resolve');assert.equal(invalid.meta_date_valid,true);assert.equal(invalid.effective_date_valid,false);assert.equal(second.failures,1);assert.equal(second.stats.screenshots_download_failed,1);
});

test('ошибка модели и неправильная структура ответа выделяются без исходных текстов',async()=>{
  const f=fixtures();f.model.complete=async()=>{const e=new Error('secret-token-and-raw-response');e.status=429;e.retryable=true;throw e;};
  const first=await inspectScreenshots({...f,signal:signal()});assert.equal(first.failures,1);
  assert.deepEqual(first.events.find(x=>x.stage==='model'),{stage:'model',outcome:'error',http_status:429,retryable:true});
  assert.doesNotMatch(JSON.stringify(first),/secret-token/);
  const bad=fixtures({response:{choices:[{message:{content:'not JSON'}}]}}),second=await inspectScreenshots({...bad,signal:signal()});
  assert.equal(second.failures,1);assert.equal(second.events.find(x=>x.stage==='model').schema.json,false);
});

test('метаданные Polza не раскрывают текст, reasoning или произвольные значения finish_reason',async()=>{
  const secret='НЕВЫВОДИМЫЙ_ТЕКСТ_ОТВЕТА_И_REASONING';
  const response={choices:[{finish_reason:secret,message:{content:`  \`\`\`json\n{${secret}}\n\`\`\``,reasoning:secret}}],
    usage:{prompt_tokens:42,completion_tokens:17,total_tokens:59,completion_tokens_details:{reasoning_tokens:11}}};
  const meta=responseMetadata(response);
  assert.equal(meta.choices_count,1);assert.equal(meta.content_type,'string');assert.equal(meta.finish_reason,'other');
  assert.equal(meta.reasoning_length,secret.length);assert.deepEqual(meta.usage,{prompt_tokens:42,completion_tokens:17,total_tokens:59,reasoning_tokens:11});
  assert.equal(meta.empty,false);assert.equal(meta.looks_fence,true);assert.equal(meta.starts_brace,false);assert.equal(meta.contains_braces,true);
  assert.doesNotMatch(JSON.stringify(meta),/НЕВЫВОДИМЫЙ/);
  const f=fixtures({response}),result=await inspectScreenshots({...f,signal:signal()});
  assert.deepEqual(result.events.find(x=>x.stage==='model').response,meta);assert.equal(result.failures,1);
  assert.doesNotMatch(JSON.stringify(result),/НЕВЫВОДИМЫЙ/);
});

test('метаданные различают пустой, отсутствующий, null и массивный content и reasoning_details',()=>{
  assert.deepEqual(responseMetadata({}),{choices_count:null,content_type:'missing',content_length:null,finish_reason:'missing',reasoning_length:null,
    usage:{prompt_tokens:null,completion_tokens:null,total_tokens:null,reasoning_tokens:null},empty:null,looks_fence:null,starts_brace:null,contains_braces:null});
  assert.equal(responseMetadata({choices:[{message:{content:null}}]}).content_type,'null');
  const empty=responseMetadata({choices:[{finish_reason:'length',message:{content:'  ',reasoning_details:[{text:'internal'}]}}]});
  assert.equal(empty.empty,true);assert.equal(empty.content_length,2);assert.equal(empty.finish_reason,'length');assert.equal(empty.reasoning_length,8);
  const arr=responseMetadata({choices:[{message:{content:[{type:'text',text:'{}'}]}}],usage:{prompt_tokens:-1,total_tokens:10000001}});
  assert.equal(arr.content_type,'array');assert.equal(arr.content_length,2);assert.equal(arr.starts_brace,true);assert.equal(arr.contains_braces,true);
  assert.equal(arr.usage.prompt_tokens,null);assert.equal(arr.usage.total_tokens,null);
});

test('неподтверждённая пагинация и предел изображений не вызывают модель',async()=>{
  const f=fixtures();f.client.request=async()=>({result:Array.from({length:50},(_,i)=>comment(i+1))});
  const result=await inspectScreenshots({...f,signal:signal()});assert.equal(result.status,'error');assert.equal(result.code,'comments_unavailable');
  const many=fixtures({comments:Array.from({length:21},(_,i)=>comment(i+1))}),limited=await inspectScreenshots({...many,signal:signal()});
  assert.equal(limited.status,'error');assert.equal(limited.code,'image_count_limit');assert.equal(many.calls.some(x=>x.method==='polza'),false);
});

test('ранее объявленный total сохраняется при его исчезновении, проверяются изменения total и повторы ID',async()=>{
  for(const scenario of ['missing_total','changed_total','duplicate']){
    const f=fixtures();f.client.request=async(method,body)=>{
      assert.equal(method,'crm.timeline.comment.list');
      if(body.start===0)return {result:Array.from({length:50},(_,i)=>comment(i+1)),total:scenario==='duplicate'?51:100,next:50};
      if(scenario==='missing_total')return {result:[comment(51)]};
      if(scenario==='changed_total')return {result:[comment(51)],total:51};
      return {result:[comment(50)],total:51};
    };
    const result=await inspectScreenshots({...f,signal:signal()});assert.equal(result.status,'error',scenario);assert.equal(result.code,'comments_unavailable');
  }
});

test('таймаут закрывает запросы до service_closed и не выдаёт маркер при неизвестном завершении',async()=>{
  let closed=false,aborted=false;
  const client={request(method,body,{signal}){return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('cancel'));},{once:true}));}};
  const report=await runDiagnostic({client,model:{complete(){throw new Error('unused');}},closeLimiter:()=>{closed=true;},deadlineMs:20,closeGraceMs:100});
  assert.equal(aborted,true);assert.equal(closed,true);assert.equal(report.service_closed,true);assert.equal(report.code,'deadline');
  const hanging={request(){return new Promise(()=>{});}};
  await assert.rejects(()=>runDiagnostic({client:hanging,model:{complete(){}},closeLimiter(){},deadlineMs:20,closeGraceMs:20}));
});

test('отчёт передаётся в аутентифицированном шифрованном конверте',async()=>{
  const f=fixtures(),report=await runDiagnostic({...f,closeLimiter(){},deadlineMs:1000,closeGraceMs:100});
  const pair=generateKeyPairSync('rsa',{modulusLength:2048}),pub=Buffer.from(pair.publicKey.export({type:'spki',format:'pem'})).toString('base64');
  const box=sealEvidenceReport(report,pub);assert.doesNotMatch(JSON.stringify(box),/screenshots_total|private/);
  const key=privateDecrypt({key:pair.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(box.encrypted_key,'base64'));
  const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(box.iv,'base64'));cipher.setAuthTag(Buffer.from(box.tag,'base64'));
  assert.deepEqual(JSON.parse(Buffer.concat([cipher.update(Buffer.from(box.ciphertext,'base64')),cipher.final()]).toString()),report);
});
