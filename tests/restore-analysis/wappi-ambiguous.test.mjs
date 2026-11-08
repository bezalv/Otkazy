import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCommunications } from '../../app/src/collect/normalize.mjs';
import { createGeneralSessionVerifier } from '../../app/src/pilot/general-session-verifier.mjs';
import { inferChatRoles } from '../../app/src/analysis/chat-role-inference.mjs';
import { pgDecide } from '../../app/src/rules/pipeline-gate.mjs';
import { transcribeCalls } from '../../app/src/calls/index.mjs';
import { assembleFacts } from '../../app/src/analysis/facts-assembler.mjs';
import { createSttClient } from '../../app/src/stt-client.mjs';
import { createServer } from 'node:http';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function trustedVoice(info,text='Голосовой отказ от заказа') {
 const dir=await mkdtemp(join(tmpdir(),'voice-test-'));
 const server=createServer(async(req,res)=>{
  if(req.url==='/audio'){res.end(Buffer.alloc(1024));return;}
  for await(const chunk of req)void chunk;
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({ok:true,model:'ai-sage/gigaam-v3',channels:1,segments:[{channel:0,start:0,end:1,text}]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try {
  const snap=info.voice_file_snapshot;
  const transcribe=createSttClient({bitrix:{async request(){return {result:{ID:snap.id,NAME:snap.name,DOWNLOAD_URL:`${base}/audio`}};}},
   sttUrl:base,sttKey:'test-only',tempRoot:dir,probeAudioOnly:async()=>true});
  return await transcribe(info);
 } finally {server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));await rmdir(dir);}
}

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

function voiceFixture({sender=3, additionalFile=null}={}) {
 const f=fixture();const h=f.collection.raw.sessions[0].history;
 h.message[51]={id:51,senderid:sender,text:'',date:'2026-10-27T00:00:02Z',params:{FILE_ID:additionalFile?[77,78]:[77]}};
 h.files={77:{id:77,type:'audio',name:'voice.ogg'},...(additionalFile?{78:{id:78,...additionalFile}}:{})};
 f.state.history=structuredClone(h);return f;
}
async function normalizeVoice(f,{fail=false,empty=false}={}) {
 const requested=[];
 const output=await normalizeCommunications({collection:f.collection,verifyFallbackSession:f.verifier,
  resolveFile:async fileId=>({id:fileId,name:Number(fileId)===77?'voice.ogg':'other.ogg',url:'https://example.test/voice'}),
  transcribeVoice:async info=>{requested.push(info);return fail?{success:false}:empty?{success:true,formatted_dialog:'   '}:trustedVoice(info);}});
 return {messages:output.deal_data.communications,requested,failures:output.voice_failures};
}
test('неизвестный автор голосового определяется только по содержимому подтверждённой сессии',async()=>{
 const f=voiceFixture(),{messages,requested}=await normalizeVoice(f);
 assert.equal(requested.length,1);assert.equal(requested[0].speaker_role,'Участник чата');
 assert.equal(messages[1].role,'unknown');
 const out=await inference(messages,['client','client','manager','client','manager']);
 assert.equal(out.calls,1);assert.equal(out.result.communications[1].role,'Клиент');
 assert.equal(out.result.communications[1]._role_source,'semantic_inference');
 const sent=JSON.parse(out.request.messages[1].content).messages;
 assert.equal(sent.filter(item=>item.text.includes('Голосовой отказ от заказа')).length,1);
 const facts=assembleFacts({lose_date:cutoff,communications:out.result.communications},'prompt').facts_packet.facts;
 assert.equal(facts.filter(item=>item.content.includes('Голосовой отказ от заказа')).length,1);
 assert.equal(facts.find(item=>item.content.includes('Голосовой отказ от заказа')).source,'chat_voice_transcript');
});
test('известная роль голосового не переопределяется, когда в той же сессии есть неизвестная реплика',async()=>{
 const f=voiceFixture({sender:1});const h=f.collection.raw.sessions[0].history;
 h.message[53].senderid=3;f.state.history=structuredClone(h);
 const {messages,requested}=await normalizeVoice(f);assert.equal(requested[0].speaker_role,'Клиент');
 const out=await inference(messages,['client','client','manager','client','manager']);
 assert.equal(out.calls,1);assert.equal(out.result.communications[1].role,'Клиент');
 assert.equal(out.result.communications[1]._role_source,undefined);
});
test('неполное голосовое, другие вложения и частичный успех не допускают семантику',async()=>{
 for(const options of [{fail:true},{empty:true}]){const f=voiceFixture(),{messages}=await normalizeVoice(f,options);assert.equal((await inference(messages)).calls,0);}
 for(const other of [{type:'image',name:'image.jpg'},{type:'video',name:'video.mp4'},{type:'audio',name:'voice.ogg'}]){
  const f=voiceFixture({additionalFile:other});let calls=0;
  const output=await normalizeCommunications({collection:f.collection,verifyFallbackSession:f.verifier,
   resolveFile:async fileId=>({name:Number(fileId)===77?'voice.ogg':other.name,url:'https://example.test/voice'}),
   transcribeVoice:async()=>++calls===1?{success:true,formatted_dialog:'Участник чата: Одно сообщение'}:{success:false}});
  assert.equal((await inference(output.deal_data.communications)).calls,0);
 }
});
test('подмена результата распознавания или обычная копия не дают доказательства голосового',async()=>{
 for(const mutate of [m=>{m[1].text='подмена';},m=>{m[1].transcript='подмена';},m=>{m[1]._has_audio_transcript=false;}]){
  const f=voiceFixture(),{messages}=await normalizeVoice(f);mutate(messages);assert.equal((await inference(messages)).calls,0);
 }
 const f=voiceFixture(),{messages}=await normalizeVoice(f);
 assert.equal((await inference(JSON.parse(JSON.stringify(messages)))).calls,0);
});
test('два отдельно распознанных голосовых в одном сообщении входят в контекст вместе',async()=>{
 const f=voiceFixture({additionalFile:{type:'audio',name:'other.ogg'}});let calls=0;
 const output=await normalizeCommunications({collection:f.collection,verifyFallbackSession:f.verifier,
  resolveFile:async fileId=>({name:Number(fileId)===77?'voice.ogg':'other.ogg',url:'https://example.test/voice'}),
  transcribeVoice:async info=>trustedVoice(info,`Часть ${++calls}`)});
 const out=await inference(output.deal_data.communications,['client','client','manager','client','manager']);
 assert.equal(calls,2);assert.equal(out.calls,1);
 assert.match(out.request.messages[1].content,/Часть 1/);assert.match(out.request.messages[1].content,/Часть 2/);
});
test('результат одного файла не подтверждает другой файл и не позволяет подменить транскрипт',async()=>{
 for(const mode of ['swap','mutate','redirect']){
  const f=voiceFixture(mode==='swap'?{additionalFile:{type:'audio',name:'other.ogg'}}:{});let saved;
  const output=await normalizeCommunications({collection:f.collection,verifyFallbackSession:f.verifier,
   resolveFile:async id=>({ID:id,NAME:Number(id)===77?'voice.ogg':'other.ogg',DOWNLOAD_URL:'https://example.test/voice'}),
   transcribeVoice:async info=>{
    if(mode==='swap'&&saved)return saved;
    if(mode==='redirect'){info.file_id='78';info.voice_file_snapshot={...info.voice_file_snapshot,id:'78'};}
    const result=await trustedVoice(info,'Исходный текст');
    if(mode==='mutate')result.formatted_dialog='Участник чата: Подменённый текст';
    saved=result;return result;
   }});
  assert.equal((await inference(output.deal_data.communications)).calls,0);
 }
});
test('Wazzup fallback допускает распознанное голосовое только после проверки сессии',async()=>{
 const f=voiceFixture(),session=f.collection.raw.sessions[0],chat=f.collection.raw.chats[0];
 delete session.session_id;chat.CONNECTOR_ID='wz_demo';chat.CONNECTOR_TITLE='Wazzup';
 session.history.chat[12].entityId='wz_demo|9|client|user';
 const verify=async request=>({kind:'verified_fallback_session_v1',...request,session_created_at:'2026-10-27T00:00:00Z',
  checks:{chat_bound_to_deal:true,session_matches_chat:true,session_matches_line:true,session_crm_matches_deal:true,
   direct_session_history_matches:true,current_chat_history_matches:true}});
 const messages=(await normalizeCommunications({collection:f.collection,verifyFallbackSession:verify,
  resolveFile:async()=>({name:'voice.ogg',url:'https://example.test/voice'}),
  transcribeVoice:async info=>trustedVoice(info,'Отказываюсь от заказа')})).deal_data.communications;
 const out=await inference(messages,['client','client','manager','client','manager']);assert.equal(out.calls,1);
 const without=(await normalizeCommunications({collection:f.collection,
  resolveFile:async()=>({name:'voice.ogg',url:'https://example.test/voice'}),
  transcribeVoice:async()=>({success:true,formatted_dialog:'Участник чата: Отказываюсь от заказа'})})).deal_data.communications;
 assert.equal((await inference(without)).calls,0);
});
test('Wazzup activity текущая сессия подтверждается полным verifier, старая не проходит',async()=>{
 for(const isCurrent of [true,false]){
  const f=voiceFixture(),session=f.collection.raw.sessions[0],h=session.history;
  delete session.chat_id;h.chat[12].entityId='wz_demo|9|client|user';
  f.collection.raw.chats[0].CONNECTOR_ID='wz_demo';f.collection.raw.chats[0].CONNECTOR_TITLE='Wazzup';
  const api={async request(method,body){
   if(method==='crm.deal.get')return {result:{ID:'127114',STAGE_ID:'C23:LOSE'}};
   if(method==='crm.stagehistory.list')return {result:{items:[{ID:'321',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}]}};
   if(method==='imopenlines.crm.chat.get')return {result:[{CHAT_ID:12,CONNECTOR_ID:'wz_demo',CONNECTOR_TITLE:'Wazzup'}]};
   if(method==='imopenlines.session.history.get'){
    const value=structuredClone(h);if(!isCurrent&&body.CHAT_ID)value.sessionId=35;return {result:value};
   }
   throw Error('Неожиданный вызов');
  }};
  const lookup=async()=>({kind:'single_session_lookup_v1',status:'found',session:{id:34,chatId:12,configId:9,
   crmEntityType:'deal',crmEntityId:'127114',dateCreate:'2026-10-27T00:00:00Z'}});
  const verifier=createGeneralSessionVerifier({client:api,lookupSession:lookup,dealId:'127114',transitionId:'321',purpose:'session_identity'});
  const messages=(await normalizeCommunications({collection:f.collection,verifyFallbackSession:verifier,
   resolveFile:async()=>({ID:'77',NAME:'voice.ogg',DOWNLOAD_URL:'https://example.test/voice'}),
   transcribeVoice:async info=>info.require_audio_only?trustedVoice(info,'Не нужно'):{success:true,formatted_dialog:'Участник чата: Не нужно'}})).deal_data.communications;
  const out=await inference(messages,['client','client','manager','client','manager']);
  assert.equal(out.calls,isCurrent?1:0);
 }
});
test('подмена транскрипта во время ответа модели не применяется',async()=>{
 const f=voiceFixture(),{messages}=await normalizeVoice(f);
 const out=await inferChatRoles({communications:messages,dealId:'127114',cutoff,client:{async complete(){
  messages[1].text='подменённый голос';return response(['client','client','manager','client','manager']);
 }}});
 assert.equal(out.stats.failed_sessions,1);assert.equal(out.communications[1]._wappi_author_ambiguous,true);
});
test('отдельное голосовое Wappi без известного автора само инициирует проверку сессии',async()=>{
 const f=fixture(),h=f.collection.raw.sessions[0].history;
 h.message[51].senderid=1;
 h.files={77:{id:77,type:'audio',name:'voice.ogg',date:'2026-10-27T00:00:06Z'}};
 f.state.history=structuredClone(h);
 const messages=(await normalizeCommunications({collection:f.collection,verifyFallbackSession:f.verifier,
  resolveFile:async()=>({name:'voice.ogg',url:'https://example.test/voice'}),
  transcribeVoice:async info=>trustedVoice(info,'Голосовое')})).deal_data.communications;
 assert.equal(messages[5].role,'unknown');assert.equal(messages[5].inference_session_id,'34');
 const out=await inference(messages,['client','client','manager','client','manager','client']);
 assert.equal(out.calls,1);assert.equal(out.result.communications[5].role,'Клиент');
});
test('явный неаудиотип имеет приоритет над расширением в истории и ответе disk.file.get',async()=>{
 for(const metadata of [{type:'video',name:'clip.ogg'},{type:'image',name:'clip.ogg'},
  {type:'audio',mimeType:'video/mp4',name:'clip.ogg'},{type:'application/pdf',name:'clip.ogg'}]){
  const f=voiceFixture(),h=f.collection.raw.sessions[0].history;h.files[77]={id:77,...metadata};
  f.state.history=structuredClone(h);let downloads=0;
  const output=await normalizeCommunications({collection:f.collection,verifyFallbackSession:f.verifier,
   resolveFile:async()=>{downloads++;return {name:'clip.ogg',url:'https://example.test/voice'};},
   transcribeVoice:async()=>{throw Error('Распознавание не должно вызываться');}});
  assert.equal(downloads,0);assert.equal((await inference(output.deal_data.communications)).calls,0);
 }
 for(const metadata of [{type:'video'},{MIME_TYPE:'image/png'},{contentType:'application/pdf'}]){
  const f=voiceFixture();let calls=0;
  const output=await normalizeCommunications({collection:f.collection,verifyFallbackSession:f.verifier,
   resolveFile:async()=>({name:'voice.ogg',url:'https://example.test/voice',...metadata}),
   transcribeVoice:async()=>{calls++;return {success:true,formatted_dialog:'ошибка'};}});
  assert.equal(calls,0);assert.equal((await inference(output.deal_data.communications)).calls,0);
 }
});
test('файл разных сессий с неоднозначной привязкой блокируется до распознавания',async()=>{
 for(const includeMetadata of [true,false]){
 const f=fixture(),history=f.collection.raw.sessions[0].history;
 history.files={77:{id:77,type:'audio',name:'voice.ogg',date:'2026-10-27T00:00:06Z'}};
 f.state.history=structuredClone(history);
 const other={chatId:13,sessionId:35,chat:{13:{entityId:'other_connector|9|person|user'}},
  users:{1:{connector:true}},files:includeMetadata?{77:{id:77,type:'audio',name:'voice.ogg'}}:{},message:{
   60:{id:60,senderid:1,text:'',date:'2026-10-27T00:00:00Z',params:{FILE_ID:[77]}}}};
 f.collection.raw.chats.unshift({CHAT_ID:13,CONNECTOR_ID:'other_connector',CONNECTOR_TITLE:'Wappi'});
 f.collection.raw.sessions.unshift({session_id:35,history:other});let count=0;
 await assert.rejects(normalizeCommunications({collection:f.collection,verifyFallbackSession:f.verifier,
  resolveFile:async()=>({name:'voice.ogg',url:'https://example.test/voice'}),
  transcribeVoice:async()=>({success:true,formatted_dialog:`Участник чата: Голосовое ${++count}`})}),/Неоднозначная привязка файла/);
 assert.equal(count,0);
 }
});
test('реальная activity-форма Wappi без chat_id проверяется через историю и чат',async()=>{
 const f=voiceFixture();delete f.collection.raw.sessions[0].chat_id;
 const {messages}=await normalizeVoice(f);
 assert.equal(messages[1].inference_session_id,'34');
 assert.equal((await inference(messages,['client','client','manager','client','manager'])).calls,1);
 for(const field of ['session_id','chat_id']){
  const f2=voiceFixture();delete f2.collection.raw.sessions[0].chat_id;
  const norm=await normalizeVoice(f2);f2.collection.raw.sessions[0][field]=field==='session_id'?35:13;
  assert.equal((await inference(norm.messages)).calls,0);
 }
 const mismatch=voiceFixture();mismatch.collection.raw.sessions[0].session_id=35;
 await assert.rejects(normalizeVoice(mismatch),/история открытой линии относится к другой сессии/i);
});
test('дублирующееся сообщение другой сессии не создаёт ложное подтверждение полноты группы',async()=>{
 const f=fixture(),original=f.collection.raw.sessions[0].history;
 const other={chatId:12,sessionId:35,chat:structuredClone(original.chat),users:structuredClone(original.users),files:{},
  message:{50:structuredClone(original.message[50])}};
 f.collection.raw.sessions.unshift({session_id:35,history:other});
 const messages=await normalized(f);
 assert.ok(messages.every(item=>item._session_context_ambiguous===true));
 assert.equal((await inference(messages)).calls,0);
});
test('изменение или замена карточки чата во время STT либо модели отменяет подтверждение',async()=>{
 for(const phase of ['stt','model'])for(const method of ['change','replace']){
  const f=voiceFixture();const alter=()=>{if(method==='change')f.collection.raw.chats[0].CONNECTOR_TITLE='Другая';
   else f.collection.raw.chats[0]=structuredClone(f.collection.raw.chats[0]);};
  const messages=(await normalizeCommunications({collection:f.collection,verifyFallbackSession:f.verifier,
   resolveFile:async()=>({ID:77,NAME:'voice.ogg',DOWNLOAD_URL:'https://example.test/voice'}),
   transcribeVoice:async info=>{if(phase==='stt')alter();return trustedVoice(info,'Текст');}})).deal_data.communications;
  let calls=0;const out=await inferChatRoles({communications:messages,dealId:'127114',cutoff,client:{async complete(){
   calls++;if(phase==='model')alter();return response(['client','client','manager','client','manager']);
  }}});
  assert.equal(calls,phase==='stt'?0:1);assert.equal(out.communications[1]._wappi_author_ambiguous,true);
 }
});
