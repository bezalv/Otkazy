import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectDeal } from '../../app/src/collect/index.mjs';
import { normalizeCommunications } from '../../app/src/collect/normalize.mjs';
import { communicationRow } from '../../app/src/persistence/rows.mjs';

const NOW=Date.parse('2026-11-05T00:00:00Z');
const attachment={id:7,type:'audio',name:'voice.ogg'};
function history(sessionId=99,chatId=25) {
  return {sessionId,chatId,chat:{[chatId]:{entityId:`wz_example|2|chat|user`}},users:{},
    message:{1:{id:1,senderid:0,text:'',date:'2026-11-04T01:00:00Z',params:{FILE_ID:[7]}}},files:{7:structuredClone(attachment)}};
}
function fixture({connector='wz_example',sessions=[99],direct=history(),latest=history(),latestError=false}={}) {
 const calls=[];
 return {calls,client:{async request(method,body){
  calls.push({method,body});
  if(method==='crm.deal.userfield.list')return {result:[{LIST:[{ID:'1',VALUE:'Другая'}]}]};
  if(method==='crm.deal.get')return {result:{ID:'42',STAGE_ID:'C23:LOSE',ASSIGNED_BY_ID:'65',UF_CRM_1584703948317:'1'}};
  if(method==='crm.stagehistory.list')return {result:{items:[{ID:'101',STAGE_ID:'C23:LOSE',CREATED_TIME:'2026-11-04T00:00:00Z'}]}};
  if(method==='crm.activity.list'&&body.filter.PROVIDER_ID==='IMOPENLINES_SESSION')return {result:sessions.map((x,i)=>({ID:i+1,ASSOCIATED_ENTITY_ID:x}))};
  if(method==='crm.activity.list'||method==='crm.timeline.comment.list')return {result:[]};
  if(method==='tasks.task.list')return {result:{tasks:[]}};
  if(method==='imopenlines.crm.chat.get')return {result:[{CHAT_ID:25,CONNECTOR_ID:connector,CONNECTOR_TITLE:connector}]};
  if(method==='imopenlines.session.history.get'){
    if(body.SESSION_ID)return {result:structuredClone(direct)};
    if(latestError)throw Error('history unavailable');
    return {result:structuredClone(latest)};
  }
  throw Error('unexpected method');
 }}};
}
const run=x=>collectDeal({client:x.client,dealId:42,now:NOW,wait:async()=>{},silent:true,requireCurrentHistory:true});

test('старая activity и более новая сессия: источник неполон, новую сессию сделке не приписываем',async()=>{
 for(const connector of ['wz_example','wappi']){
  const f=fixture({connector,latest:history(100)});const out=await run(f);
  assert.equal(out._status,'error');assert.equal(out._sources.openlines.complete,false);
  assert.equal(out._sources.openlines.reason,'latest_session_link_unverified');
  assert.equal(out.raw.sessions.length,1);assert.equal(out.raw.sessions[0].session_id,99);
  assert.deepEqual(f.calls.filter(x=>x.method==='imopenlines.session.history.get').map(x=>x.body),[{SESSION_ID:99},{CHAT_ID:25}]);
 }
});

test('совпадение последней и activity-сессии подтверждается снимком без дубля и сохраняет event_id',async()=>{
 for(const connector of ['wz_example','wappi']){
  const f=fixture({connector});const out=await run(f);
  assert.equal(out._status,'pending_normalization');assert.equal(out.raw.sessions.length,1);
  assert.equal(out._sources.openlines.complete,true);
  assert.equal(out._sources.openlines.history_coverage,'unverified');
  assert.equal(out._sources.openlines.history_scope,'activity_and_latest');
  const normalize=()=>normalizeCommunications({collection:out,screenshots:false,
    resolveFile:async()=>({result:{NAME:'voice.ogg',DOWNLOAD_URL:'https://example.invalid/voice.ogg'}}),
    transcribeVoice:async()=>({success:true,formatted_dialog:'тест',manager_text:'тест',client_text:'',total_replicas:1})});
  const first=await normalize(),second=await normalize();
  const a=first.deal_data.communications.find(x=>x.type==='chat'),b=second.deal_data.communications.find(x=>x.type==='chat');
  assert.ok(a);assert.equal(a.session_id,99);assert.equal(a.message_id,'99_1');
  assert.equal(communicationRow('42',a,0).event_id,communicationRow('42',b,0).event_id);
  assert.equal(a._has_files,true);assert.equal(a._has_audio_transcript,true);
 }
});

test('ошибка получения последней истории не считается полным источником',async()=>{
 const out=await run(fixture({latestError:true}));assert.equal(out._status,'error');
 assert.equal(out._sources.openlines.complete,false);
});

test('отсутствие или противоречие ID в истории блокирует разбор',async()=>{
 for(const options of [
  {direct:{...history(),sessionId:100}}, {direct:{...history(),chatId:null}},
  {latest:{...history(),sessionId:null}}, {latest:{...history(),chatId:26}},
  {latest:{...history(),sessionId:'bad'}}, {latest:{...history(),chatId:null}},
 ]){
  const out=await run(fixture(options));assert.equal(out._status,'error');assert.equal(out._sources.openlines.complete,false);
 }
});

test('различие содержимого, файлов или отправителей одной сессии блокирует разбор',async()=>{
 for(const change of [
  h=>{h.message[1].text='новая версия';},h=>{h.files[7].name='changed.ogg';},
  h=>{h.users['1']={name:'changed'};},h=>{h.chat['25'].entityId='wz_example|3|chat|user';},
 ]){
  const latest=history();change(latest);
  const out=await run(fixture({latest}));assert.equal(out._status,'error');assert.equal(out._sources.openlines.complete,false);
 }
});

test('новое сообщение между чтениями допускается после согласованной пары, event_id не меняется',async()=>{
 const f=fixture();const original=f.client.request.bind(f.client);let sessions=0,chats=0;
 const newer=history();newer.message[2]={id:2,senderid:1,date:'2026-11-04T01:01:00Z',text:'второе сообщение'};
 f.client.request=async(method,body)=>{
  if(method==='imopenlines.session.history.get'){
   if(body.SESSION_ID){sessions++;return {result:structuredClone(sessions===1?history():newer)};}
   chats++;return {result:structuredClone(newer)};
  }
  return original(method,body);
 };
 const out=await run(f);assert.equal(out._status,'pending_normalization');assert.equal(out.raw.sessions.length,1);
 assert.equal(sessions,2);assert.equal(chats,2);assert.equal(Object.keys(out.raw.sessions[0].history.message).length,2);
 const norm=await normalizeCommunications({collection:out,screenshots:false,resolveFile:async()=>{throw Error('media disabled');}});
 const messages=norm.deal_data.communications.filter(x=>x.type==='chat');
 assert.equal(messages.length,2);assert.equal(messages[0].message_id,'99_1');assert.equal(messages[1].message_id,'99_2');
 assert.equal(communicationRow('42',messages[0],0).event_id,'99_1');
});

test('две нестабильные пары исчерпывают лимит и не подтверждают источник',async()=>{
 const f=fixture();const original=f.client.request.bind(f.client);let sessions=0,chats=0;
 f.client.request=async(method,body)=>{
  if(method==='imopenlines.session.history.get'){
   const value=history();if(body.SESSION_ID){sessions++;value.message[1].text=`session ${sessions}`;}
   else {chats++;value.message[1].text=`chat ${chats}`;}
   return {result:value};
  }
  return original(method,body);
 };
 const out=await run(f);assert.equal(out._status,'error');assert.equal(out._sources.openlines.complete,false);
 assert.equal(sessions,3);assert.equal(chats,3);assert.equal(out.raw.sessions.length,1);
});

test('при появлении другой последней сессии во время повторной пары она не приписывается сделке',async()=>{
 const f=fixture();const original=f.client.request.bind(f.client);let chats=0;
 f.client.request=async(method,body)=>{
  if(method==='imopenlines.session.history.get'){
   if(body.SESSION_ID)return {result:history()};
   chats++;const value=history(chats===1?99:100);value.message[1].text='changed';return {result:value};
  }
  return original(method,body);
 };
 const out=await run(f);assert.equal(out._status,'error');assert.equal(out._sources.openlines.complete,false);
 assert.equal(out._sources.openlines.reason,'latest_session_link_unverified');assert.equal(out.raw.sessions.length,1);
});

test('прежний fallback без activity сохраняет синтетический session_id и не объявляет границы доказанными',async()=>{
 const out=await run(fixture({sessions:[]}));assert.equal(out._status,'pending_normalization');
 assert.equal(out.raw.sessions.length,1);assert.equal(out.raw.sessions[0].chat_id,25);
 const normalized=await normalizeCommunications({collection:out,screenshots:false,resolveFile:async()=>{throw Error('media disabled');}});
 const message=normalized.deal_data.communications.find(x=>x.type==='chat');
 assert.equal(message.session_id,'chat_25');assert.equal(message.message_id,'chat_25_1');
 assert.equal(message.inference_session_id,undefined);
});

test('activity одного чата не закрывает fallback другого чата той же сделки',async()=>{
 const f=fixture();const original=f.client.request.bind(f.client);
 f.client.request=async(method,body)=>{
  if(method==='imopenlines.crm.chat.get')return {result:[
   {CHAT_ID:25,CONNECTOR_ID:'wz_example'}, {CHAT_ID:26,CONNECTOR_ID:'wappi'}]};
  if(method==='imopenlines.session.history.get'&&body.CHAT_ID===26)return {result:history(100,26)};
  return original(method,body);
 };
 const out=await run(f);assert.equal(out._status,'pending_normalization');assert.equal(out._sources.openlines.complete,true);
 assert.equal(out.raw.sessions.length,2);assert.equal(out.raw.sessions[0].session_id,99);
 assert.equal(out.raw.sessions[1].chat_id,26);assert.equal(out.raw.sessions[1].history.sessionId,100);
});
