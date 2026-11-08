import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectDeal } from '../../app/src/collect/index.mjs';
import { normalizeCommunications } from '../../app/src/collect/normalize.mjs';
import { processDeal } from '../../app/src/process-deal.mjs';
import { createGeneralSessionVerifier } from '../../app/src/pilot/general-session-verifier.mjs';
import { runManualSessionPilot } from '../../app/src/pilot/manual-session-adapter.mjs';
import { communicationRow } from '../../app/src/persistence/rows.mjs';

const cutoff='2026-11-04T00:00:00Z', now=Date.parse('2026-11-05T00:00:00Z');
const history=(session,id=1)=>({sessionId:session,chatId:25,chat:{25:{entityId:'wz_test|2|chat|user'}},users:{},files:{},
  message:{[id]:{id,senderid:1,date:'2026-11-03T01:00:00Z',text:'Текст'}}});
function fixture(){
 const state={ old:history(99), latest:history(100,2), active:true, connector:'wz_test', title:'Wazzup' }, calls=[];
 const client={async request(method,body){calls.push({method,body});
  if(method==='crm.deal.userfield.list')return {result:[{LIST:[{ID:'1',VALUE:'Другая'}]}]};
  if(method==='crm.deal.get')return {result:{ID:'42',STAGE_ID:'C23:LOSE',ASSIGNED_BY_ID:'65',UF_CRM_1584703948317:'1'}};
  if(method==='crm.stagehistory.list')return {result:{items:[{ID:'101',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}]},total:1};
  if(method==='crm.activity.list'&&body.filter.PROVIDER_ID==='IMOPENLINES_SESSION')return {result:state.active?[{ID:1,ASSOCIATED_ENTITY_ID:99}]:[]};
  if(method==='crm.activity.list'||method==='crm.timeline.comment.list')return {result:[]};
  if(method==='tasks.task.list')return {result:{tasks:[]}};
  if(method==='imopenlines.crm.chat.get')return {result:[{CHAT_ID:25,CONNECTOR_ID:state.connector,CONNECTOR_TITLE:state.title}]};
  if(method==='imopenlines.session.history.get')return {result:structuredClone(body.SESSION_ID===99?state.old:state.latest)};
  throw Error('forbidden');
 }};return {state,calls,client};
}
const proof = input => ({kind:'verified_fallback_session_v1',deal_id:input.deal_id,chat_id:input.chat_id,
 session_id:input.session_id,line_id:input.line_id,cutoff:input.cutoff,history_sha256:input.history_sha256,
 session_created_at:'2026-11-01T00:00:00Z',checks:{chat_bound_to_deal:true,session_matches_chat:true,
 session_matches_line:true,session_crm_matches_deal:true,direct_session_history_matches:true,current_chat_history_matches:true}});
const run=(f,verifyLatestSession)=>collectDeal({client:f.client,dealId:42,now,wait:async()=>{},silent:true,
 requireCurrentHistory:true,expectedHistoryId:'101',expectedLoseDate:cutoff,...(verifyLatestSession?{verifyLatestSession}:{})});

test('подтверждённая новая сессия доступна тихому ручному разбору без смены старых ID',async()=>{
 const f=fixture();let observed;
 const result=await run(f,async input=>{observed=input;return proof(input);});
 assert.equal(result._status,'pending_normalization');assert.equal(result._sources.openlines.complete,true);
 assert.equal(observed.transition_id,'101');assert.match(observed.history_sha256,/^[a-f0-9]{64}$/);
 assert.equal(result.raw.sessions.length,2);assert.equal(result.raw.sessions[0].session_id,99);
 assert.equal(result.raw.sessions[1].chat_id,25);assert.equal(result.raw.sessions[1].session_id,undefined);
 const normalized=await normalizeCommunications({collection:result,screenshots:false});
 const chats=normalized.deal_data.communications.filter(x=>x.type==='chat');
 assert.deepEqual(chats.map(x=>x.message_id),['99_1','chat_25_2']);
 assert.deepEqual(chats.map((x,i)=>communicationRow('42',x,i).event_id),['99_1','chat_25_2']);
});

test('в ручном режиме fallback без activity обязан пройти identity; обычный сбор сохраняет прежнее поведение',async()=>{
 const f=fixture();f.state.active=false;let checks=0;
 const good=await run(f,async input=>{checks++;return proof(input);});
 assert.equal(good._status,'pending_normalization');assert.equal(checks,1);assert.equal(good.raw.sessions[0].chat_id,25);
 const rejected=await run(f,async()=>null);assert.equal(rejected._status,'error');assert.equal(rejected._sources.openlines.reason,'latest_session_link_unverified');
 assert.equal(rejected.raw.sessions.length,0);
 const ordinary=await run(f);assert.equal(ordinary._status,'pending_normalization');assert.equal(ordinary.raw.sessions[0].chat_id,25);
});

test('Wappi с непрозрачным кодом и точным entityId доступен identity проверке без смены роли',async()=>{
 const f=fixture();f.state.active=false;f.state.connector='opaque_connector';f.state.title='Wappi';
 f.state.latest.chat[25].entityId='opaque_connector|2|chat|user';
 f.state.latest.users={1:{connector:true,extranet:false,externalAuthId:'imconnector'}};
 const lookupSession=async input=>({kind:'single_session_lookup_v1',status:'found',session:{id:input.session_id,
  chatId:input.chat_id,configId:input.line_id,crmEntityType:'deal',crmEntityId:'42',dateCreate:'2026-11-01T00:00:00Z'}});
 const identity=createGeneralSessionVerifier({client:f.client,lookupSession,dealId:'42',transitionId:'101',purpose:'session_identity'});
 const out=await run(f,identity);assert.equal(out._status,'pending_normalization');
 const normalized=await normalizeCommunications({collection:out,screenshots:false});
 assert.equal(normalized.deal_data.communications[0].role,'Клиент');
 assert.equal(normalized.deal_data.communications[0]._role_source,undefined);
 assert.equal(normalized.deal_data.communications[0].message_id,'chat_25_2');
 f.state.connector='other';const rejected=await run(f,identity);assert.equal(rejected._status,'error');
});

test('ручной адаптер проверяет identity fallback Wappi и оставляет разбор предварительным',async()=>{
 const f=fixture();f.state.active=false;f.state.connector='opaque_connector';f.state.title='Wappi';
 f.state.latest.chat[25].entityId='opaque_connector|2|chat|user';
 f.state.latest.message[2].text='Клиент сообщил, что уже оформил заказ у другой компании.';
 f.state.latest.users={1:{connector:true,extranet:false,externalAuthId:'imconnector'}};
 const base=f.client.request;let lookups=0,roleCalls=0,judgeCalls=0;
 f.client.request=async(method,body,opts)=>{
  if(method==='imopenlines.v2.Session.list'){lookups++;return {result:{sessions:[{id:100,chatId:25,configId:2,
   crmEntityType:'deal',crmEntityId:42,dateCreate:'2026-11-01T00:00:00Z'}],hasNextPage:false}};}
  return base(method,body,opts);
 };
 const llm={async complete(body,options){
  if(options.role==='chat-role-inference'){roleCalls++;throw Error('Wappi role inference forbidden');}
  if(options.role==='judge'){judgeCalls++;return {choices:[{message:{content:JSON.stringify({verdict:'недостаточно_данных',
   verdict_reason_short:'Недостаточно',recoverable_level:null,closure_reason_class:'other',misplaced:false,correct_stage:null,
   exact_reason:'Недостаточно данных',manager_mistakes:[],key_signals:[],risk_factors:[],questions_for_manager:[]})}}]};}
  throw Error('unexpected');
 }};
 const result=await runManualSessionPilot({dealId:42,expectedHistoryId:'101',expectedLoseDate:cutoff,
  from:'2026-01-01T00:00:00Z',silent:true,semanticChatRoles:true,bitrix:f.client,llm,
  judgeSystemPrompt:'Промпт',writerSystemPrompt:'Промпт',nowMs:now,
  audioWaitEnabledAt:'2026-11-01T00:00:00Z',wait:async()=>{}});
 assert.equal(lookups,1);assert.equal(roleCalls,0);assert.equal(judgeCalls,1);
 assert.equal(result.preliminary.status,'processed');assert.equal(result.status,'unverified');
 assert.equal(result.history_complete,null);assert.equal(result.delivery_permitted,false);
 const chat=result.preliminary.dealData.communications.find(x=>x.type==='chat');
 assert.equal(chat.role,'Клиент');assert.equal(chat._role_source,undefined);assert.equal(chat.message_id,'chat_25_2');
});

test('отсутствующий, ложный, устаревший или повреждённый proof сохраняет неполноту',async()=>{
 for(const verifier of [undefined,async()=>true,async()=>{throw Error('no');},
  async input=>({...proof(input),session_id:'101'}),async input=>({...proof(input),deal_id:'43'}),
  async input=>({...proof(input),line_id:'3'}),async input=>({...proof(input),cutoff:'2026-11-05T00:00:00Z'}),
  async input=>({...proof(input),history_sha256:'0'.repeat(64)}),
  async input=>({...proof(input),session_created_at:'2026-11-04T00:00:00.000001Z'}),
  async input=>({...proof(input),session_created_at:'2026-11-05T00:00:00Z'}),
  async input=>({...proof(input),checks:{...proof(input).checks,session_crm_matches_deal:false}}),
  async input=>{input.history.message[2].text='изменено';return proof(input);}]) {
   const out=await run(fixture(),verifier);
   assert.equal(out._status,'error');assert.equal(out._sources.openlines.reason,'latest_session_link_unverified');
   assert.equal(out.raw.sessions.length,1);
 }
});

test('отсутствие линии не вызывает проверяющего; неизвестный переход и нетихий режим запрещены',async()=>{
 const f=fixture();f.state.latest.chat[25].entityId='invalid';let calls=0;
 const out=await run(f,async input=>{calls++;return proof(input);});assert.equal(calls,0);assert.equal(out._status,'error');
 await assert.rejects(collectDeal({client:f.client,dealId:42,verifyLatestSession:async()=>true,silent:false}));
 await assert.rejects(collectDeal({client:f.client,dealId:42,verifyLatestSession:async()=>true,silent:true,requireCurrentHistory:true}));
 await assert.rejects(processDeal({dealId:42,bitrix:f.client,verifyLatestSession:async()=>true,silent:true,
  semanticChatRoles:false,expectedHistoryId:'101',expectedLoseDate:cutoff}));
});

test('изменение исходного снимка или отмена проверки не пропускают новую сессию',async()=>{
 const f=fixture(),original=f.client.request;
 f.client.request=async(method,body)=>method==='imopenlines.session.history.get'&&body.CHAT_ID
  ?{result:f.state.latest}:original(method,body);
 const changed=await run(f,async input=>{f.state.latest.message[2].text='изменение после начала';return proof(input);});
 assert.equal(changed._status,'error');assert.equal(changed._sources.openlines.reason,'latest_session_link_unverified');
 const cancelled=await run(fixture(),async()=>{const error=new Error('отмена');error.name='AbortError';throw error;});
 assert.equal(cancelled._status,'error');assert.equal(cancelled.raw.sessions.length,1);
});

test('сессия, возникшая при повторной сверке, проходит только через проверяющего',async()=>{
 const f=fixture();let chatReads=0;const original=f.client.request;
 f.client.request=async(method,body)=>{
  if(method==='imopenlines.session.history.get'&&body.CHAT_ID){
   chatReads++;const current=chatReads===1?history(99):history(100,2);
   if(chatReads===1)current.message[1].text='изменилось между чтениями';return {result:current};
  }
  return original(method,body);
 };
 let verified=0;const recovered=await run(f,async input=>{verified++;return proof(input);});
 assert.equal(verified,1);assert.equal(recovered._status,'pending_normalization');assert.equal(recovered.raw.sessions.length,2);
 assert.equal(recovered.raw.sessions[0].session_id,99);assert.equal(recovered.raw.sessions[1].chat_id,25);
});

test('реальный общий проверяющий повторно сверяет переход и сессию',async()=>{
 const f=fixture();let lookups=0;
 const lookupSession=async input=>{lookups++;return {kind:'single_session_lookup_v1',status:'found',session:{id:input.session_id,
  chatId:input.chat_id,configId:input.line_id,crmEntityType:'deal',crmEntityId:'42',dateCreate:'2026-11-01T00:00:00Z'}};};
 const verifier=createGeneralSessionVerifier({client:f.client,lookupSession,dealId:'42',transitionId:'101'});
 const result=await run(f,verifier);assert.equal(result._status,'pending_normalization');assert.equal(lookups,1);
 assert.equal(f.calls.filter(x=>x.method==='crm.stagehistory.list').length,3);
 const changed=fixture();let count=0;const old=changed.client.request;
 changed.client.request=async(method,body)=>{
  if(method==='crm.stagehistory.list'&&++count===3)return {result:{items:[{ID:'102',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}]},total:1};
  return old(method,body);
 };
 const check=createGeneralSessionVerifier({client:changed.client,lookupSession,dealId:'42',transitionId:'101'});
 const failed=await run(changed,check);assert.equal(failed._status,'error');assert.equal(failed.raw.sessions.length,1);
});

test('голосовое остаётся вложением и не обрабатывается автоматически при сборе',async()=>{
 const f=fixture();f.state.latest.message[2]={id:2,senderid:0,text:'',date:'2026-11-03T01:00:00Z',params:{FILE_ID:[7]}};
 f.state.latest.files={7:{id:7,name:'voice.ogg',type:'audio'}};let stt=0;
 const result=await run(f,async input=>proof(input));assert.equal(result._status,'pending_normalization');
 const normalized=await normalizeCommunications({collection:result,screenshots:false,transcribeVoice:async()=>{stt++;throw Error('disabled');}});
 assert.equal(stt,0);assert.equal(normalized.voice_failures.length,1);
 assert.ok(normalized.deal_data.communications.some(x=>x.message_id==='chat_25_2'&&x._has_files===true));
});


test('неизвестный Wappi запускает вторую проверку сессии перед оценкой роли',async()=>{
 const f=fixture();f.state.active=false;f.state.connector='opaque_connector';f.state.title='Wappi';
 f.state.latest.chat[25].entityId='opaque_connector|2|chat|user';
 f.state.latest.message[2].text='Клиент сообщил, что уже оформил заказ у другой компании.';
 f.state.latest.users={1:{name:'Неизвестно'}};
 const base=f.client.request;let lookups=0,roleCalls=0;
 f.client.request=async(method,body,opts)=>{
  if(method==='imopenlines.v2.Session.list'){lookups++;return {result:{sessions:[{id:100,chatId:25,configId:2,
   crmEntityType:'deal',crmEntityId:42,dateCreate:'2026-11-01T00:00:00Z'}],hasNextPage:false}};}
  return base(method,body,opts);
 };
 const llm={async complete(body,options){
  if(options.role==='chat-role-inference'){roleCalls++;return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({roles:[{id:'m001',role:'unknown',impact:'material_or_unclear'}]})}}]};}
  throw Error('Судья не должен запускаться');
 }};
 const result=await runManualSessionPilot({dealId:42,expectedHistoryId:'101',expectedLoseDate:cutoff,
  from:'2026-01-01T00:00:00Z',silent:true,semanticChatRoles:true,bitrix:f.client,llm,
  judgeSystemPrompt:'Промпт',writerSystemPrompt:'Промпт',nowMs:now,
  audioWaitEnabledAt:'2026-11-01T00:00:00Z',wait:async()=>{}});
 assert.equal(lookups,2);assert.equal(roleCalls,1);
 assert.equal(result.preliminary.pipelineGate.kind,'author_ambiguous');
 assert.equal(result.delivery_permitted,false);
});
