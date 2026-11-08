import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCommunications } from '../../app/src/collect/normalize.mjs';
import { createGeneralSessionVerifier } from '../../app/src/pilot/general-session-verifier.mjs';
import { inferChatRoles } from '../../app/src/analysis/chat-role-inference.mjs';
import { pgDecide } from '../../app/src/rules/pipeline-gate.mjs';
import { transcribeCalls } from '../../app/src/calls/index.mjs';

const cutoff='2026-10-28T05:35:03.000Z';
const sources=Object.fromEntries(['calls','openlines','comments','tasks'].map(k=>[k,{complete:true}]));
function fixture(explicit=true){
 const history={chatId:12,sessionId:34,chat:{12:{entityId:'opaque_connector|9|client|user'}},users:{
  1:{connector:true},2:{active:true,connector:false,extranet:false,externalAuthId:'local',name:'Сотрудник'},3:{name:'Неизвестно'}},files:{},message:{
   50:{id:50,senderid:1,text:'Подскажите, какие бывают окна?',date:'2026-10-27T00:00:01Z'},
   51:{id:51,senderid:3,text:'👍',date:'2026-10-27T00:00:02Z'},
   52:{id:52,senderid:2,text:'Можем предложить несколько вариантов.',date:'2026-10-27T00:00:03Z'},
   53:{id:53,senderid:1,text:'Спасибо, я уже приобрёл окна в другом месте.',date:'2026-10-27T00:00:04Z'},
   54:{id:54,senderid:2,text:'Понял вас, закрою сделку.',date:'2026-10-27T00:00:05Z'},
 }};
 const collection={_status:'pending_normalization',deal_id:'127114',silent:true,deal_data:{lose_date:cutoff},_sources:structuredClone(sources),raw:{calls:[],comments:[],tasks:[],chats:[{CHAT_ID:12,CONNECTOR_ID:'opaque_connector',CONNECTOR_TITLE:'Wappi WhatsApp'}],sessions:[{chat_id:12,...(explicit?{session_id:34}:{}),history}]}};
 const state={history:structuredClone(history),connector:'opaque_connector',record:{id:34,chatId:12,configId:9,crmEntityType:'deal',crmEntityId:'127114',dateCreate:'2026-10-27T00:00:00Z'}};
 const client={async request(method){
  if(method==='crm.deal.get')return {result:{ID:'127114',STAGE_ID:'C23:LOSE'}};
  if(method==='crm.stagehistory.list')return {result:{items:[{ID:'321',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}]}};
  if(method==='imopenlines.crm.chat.get')return {result:[{CHAT_ID:12,CONNECTOR_ID:state.connector,CONNECTOR_TITLE:'Wappi WhatsApp'}]};
  if(method==='imopenlines.session.history.get')return {result:structuredClone(state.history)};
  throw Error('Неожиданный вызов');
 }};
 const lookup=async()=>({kind:'single_session_lookup_v1',status:'found',session:structuredClone(state.record)});
 const verifier=createGeneralSessionVerifier({client,lookupSession:lookup,dealId:'127114',transitionId:'321',purpose:'session_identity'});
 return {collection,state,verifier};
}
async function normalized(f,verifier=f.verifier){return (await normalizeCommunications({collection:f.collection,verifyFallbackSession:verifier})).deal_data.communications;}
function response(roles){return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({roles:roles.map((role,i)=>({id:`m${String(i+1).padStart(3,'0')}`,role,impact:role==='unknown'?'not_material':'not_applicable'}))})}}]};}
async function inference(messages,roles=['client','unknown','manager','client','manager']){
 let calls=0,request;
 const result=await inferChatRoles({communications:messages,dealId:'127114',cutoff,client:{async complete(body){calls++;request=body;return response(roles);}}});
 return {result,calls,request};
}
for(const explicit of [true,false])test(`Wappi ${explicit?'explicit':'fallback'}: проверенная сессия, нейтральная реакция остаётся unknown`,async()=>{
 const f=fixture(explicit),messages=await normalized(f);
 assert.deepEqual(messages.map(x=>x.role),['Клиент','unknown','Менеджер','Клиент','Менеджер']);
 assert.ok(messages.every(x=>x.connector_family==='wappi'));
 const {result,calls,request}=await inference(messages);
 assert.equal(calls,1);assert.equal(result.communications[1].role,'unknown');
 assert.equal(result.communications[1]._unknown_role_nonmaterial,'semantic_inference');
 assert.equal(pgDecide({sources,communications:result.communications,allowNonmaterialUnknown:true}).block,false);
 assert.equal(pgDecide({sources,communications:result.communications}).kind,'author_ambiguous');
 assert.doesNotMatch(JSON.stringify(request),/opaque_connector|Сотрудник|session_id/);
});
test('неподтверждённый Wappi, JSON-копия и подложный флаг не допускают модель',async()=>{
 const f=fixture(),messages=await normalized(f),cloned=structuredClone(messages);
 const unverified=(await normalizeCommunications({collection:f.collection})).deal_data.communications;
 for(const input of [unverified,cloned,cloned.map(x=>({...x,_wappi_session_verified:true}))]){
  const result=await inference(input);assert.equal(result.calls,0);
 }
});
test('изменение доказанного события или истории и дубли сессии закрывают доступ модели',async()=>{
 for(const mutate of [
  (f,m)=>{m[0].text='Подмена';},
  (f,m)=>{f.collection.raw.sessions[0].history.message[50].text='Подмена';},
  (f,m)=>{f.collection.raw.sessions.push(structuredClone(f.collection.raw.sessions[0]));},
  (f,m)=>{m.push({...m[0],message_id:'подмена'});},
 ]){const f=fixture(),m=await normalized(f);mutate(f,m);const out=await inference(m);assert.equal(out.calls,0);}
});
test('файлы и неизвестные даты блокируют сессию, поздние сообщения не попадают в запрос',async()=>{
 for(const mutate of [f=>{f.collection.raw.sessions[0].history.message[51].params={FILE_ID:[77]};f.collection.raw.sessions[0].history.files={77:{id:77,type:'image'}};f.state.history=structuredClone(f.collection.raw.sessions[0].history);},
  f=>{f.collection.raw.sessions[0].history.message[51].date=null;f.state.history=structuredClone(f.collection.raw.sessions[0].history);}]){
  const f=fixture();mutate(f);assert.equal((await inference(await normalized(f))).calls,0);
 }
 const f=fixture();f.collection.raw.sessions[0].history.message[55]={id:55,senderid:3,text:'ПОЗДНЕЕ СООБЩЕНИЕ',date:'2026-10-29T00:00:00Z'};f.state.history=structuredClone(f.collection.raw.sessions[0].history);
 const out=await inference(await normalized(f));assert.equal(out.calls,1);assert.doesNotMatch(JSON.stringify(out.request),/ПОЗДНЕЕ СООБЩЕНИЕ/);
});

test('гипотеза модели помечается отдельно, известные технические роли не меняются',async()=>{
 const f=fixture(),messages=await normalized(f),out=await inference(messages,['client','client','manager','client','manager']);
 assert.equal(out.calls,1);assert.equal(out.result.communications[1].role,'Клиент');
 assert.equal(out.result.communications[1]._role_source,'semantic_inference');
 assert.deepEqual(out.result.communications[0],messages[0]);assert.deepEqual(out.result.communications[2],messages[2]);
});
test('ошибка проверки связи или другая последняя сессия не допускает модель',async()=>{
 for(const mutate of [f=>{f.state.record.crmEntityId='987';},f=>{f.state.history.sessionId=35;},f=>{f.state.connector='другая';}]){
  const f=fixture();mutate(f);assert.equal((await inference(await normalized(f))).calls,0);
 }
});
test('нет silent или нет verifier: запрос модели невозможен, известные роли сохранены',async()=>{
 const f=fixture();f.collection.silent=false;const m=await normalized(f);
 assert.equal((await inference(m)).calls,0);assert.equal(m[0].role,'Клиент');assert.equal(m[2].role,'Менеджер');
});

test('снимок, подменённый во время ответа модели, не применяется',async()=>{
 const f=fixture(),communications=await normalized(f);
 const out=await inferChatRoles({communications,dealId:'127114',cutoff,client:{async complete(){
  communications[0].text='Подменено';return response(['client','client','manager','client','manager']);
 }}});
 assert.equal(out.stats.failed_sessions,1);assert.equal(out.communications[1]._wappi_author_ambiguous,true);
});

test('удалённая реплика из подтверждённой сессии не допускает оценку сокращённого контекста',async()=>{
 for(const index of [0,2,4]){const f=fixture(),messages=await normalized(f);messages.splice(index,1);assert.equal((await inference(messages)).calls,0);}
});
test('поддельная или сериализованная нейтральная реакция не проходит gate, штатная копия проходит',async()=>{
 const f=fixture(),original=(await inference(await normalized(f))).result.communications;
 const check=communications=>pgDecide({sources,communications,allowNonmaterialUnknown:true});
 assert.equal(check(original).block,false);
 assert.equal(check(structuredClone(original)).kind,'author_ambiguous');
 assert.equal(check(JSON.parse(JSON.stringify(original))).kind,'author_ambiguous');
 const forged=original.map(x=>({...x}));assert.equal(check(forged).kind,'author_ambiguous');
 const callOutput=await transcribeCalls({dealData:{deal_id:127114,communications:original}});
 assert.equal(check(callOutput.communications).block,false);
 callOutput.communications[1].text='Изменено';assert.equal(check(callOutput.communications).kind,'author_ambiguous');
});
test('отдельные image/video без FILE_ID блокируют оценку, файлы не скачиваются',async()=>{
 for(const type of ['image','video']){const f=fixture();f.collection.raw.sessions[0].history.files={77:{id:77,type,name:`asset.${type==='image'?'jpg':'mp4'}`}};
  f.state.history=structuredClone(f.collection.raw.sessions[0].history);let downloads=0;
  const messages=(await normalizeCommunications({collection:f.collection,verifyFallbackSession:f.verifier,resolveFile:async()=>{downloads++;throw Error('лишний вызов');}})).deal_data.communications;
  assert.equal((await inference(messages)).calls,0);assert.equal(downloads,0);
 }
});


test('неидентифицируемые отдельные image/video и файлы неизвестного типа закрывают семантику',async()=>{
 for(const file of [{type:'image'},{type:'video'},{type:'application/octet-stream'},{}]){
  const f=fixture();f.collection.raw.sessions[0].history.files=[file];
  f.state.history=structuredClone(f.collection.raw.sessions[0].history);let downloads=0;
  const messages=(await normalizeCommunications({collection:f.collection,verifyFallbackSession:f.verifier,
    resolveFile:async()=>{downloads++;throw Error('лишний вызов');}})).deal_data.communications;
  assert.equal((await inference(messages)).calls,0,JSON.stringify(file));assert.equal(downloads,0);
 }
 // Аудиофайл без ID отклоняется уже нормализатором, не только классификатором.
 const f=fixture();f.collection.raw.sessions[0].history.files=[{type:'audio'}];
 f.state.history=structuredClone(f.collection.raw.sessions[0].history);
 await assert.rejects(normalized(f),/Неизвестен ID аудиофайла/);
});
test('полная замена объекта истории до или во время ответа модели недопустима',async()=>{
 for(const when of ['before','during']){
  const f=fixture(),communications=await normalized(f);let calls=0;
  const replace=()=>{f.collection.raw.sessions[0].history=structuredClone(f.collection.raw.sessions[0].history);};
  if(when==='before')replace();
  const out=await inferChatRoles({communications,dealId:'127114',cutoff,client:{async complete(){
   calls++;if(when==='during')replace();return response(['client','client','manager','client','manager']);
  }}});
  assert.equal(calls,when==='before'?0:1);assert.equal(out.communications[1]._wappi_author_ambiguous,true);
 }
});
