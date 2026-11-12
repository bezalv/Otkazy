import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGeneralSessionVerifier } from '../../app/src/pilot/general-session-verifier.mjs';
import { normalizeCommunications } from '../../app/src/collect/normalize.mjs';
import { inferChatRoles } from '../../app/src/analysis/chat-role-inference.mjs';
import { communicationRow } from '../../app/src/persistence/rows.mjs';
import { createSessionLookup } from '../../app/src/pilot/general-session-lookup.mjs';

const cutoff = '2026-10-28T05:35:03.000Z';
function fixture(deal = '127114', transition = '321') {
  const history = { chatId: 12, sessionId: 34, chat: { 12: { entityId: 'wz_test|9|client|user' } }, users: {}, files: {},
    message: { 50: { id: 50, text: 'Синтетический текст', date: '2026-10-27T00:00:00Z' } } };
  const input = { deal_id: deal, chat_id:'12', session_id:'34', line_id:'9', cutoff,
    history_sha256:createHash('sha256').update(JSON.stringify(history)).digest('hex'), history };
  const state = { deal, transition, history, chat:12, connector:'wz_test', title:'Wazzup',
    record:{id:34,chatId:12,configId:9,crmEntityType:'deal',crmEntityId:deal,dateCreate:'2026-10-27T00:00:00Z'},
    calls:[], lookupCalls:0, changed:false, next:null, stage:'C23:LOSE', stageRows:null, stageResponses:null };
  const client = { async request(method, body) {
    state.calls.push({method, body:structuredClone(body)});
    if (method === 'crm.deal.get') return {result:{ID:state.deal, STAGE_ID:state.stage}};
    if (method === 'crm.stagehistory.list' && state.stageResponses) return structuredClone(state.stageResponses[body.start] ?? {result:{items:[]}});
    if (method === 'crm.stagehistory.list') return {result:{items:state.stageRows ?? [
      {ID:state.transition,STAGE_ID:state.stage,CREATED_TIME:cutoff},
      {ID:'300',STAGE_ID:'C23:NEW',CREATED_TIME:'2026-10-27T00:00:00Z'}]}, ...(state.next == null ? {} : {next:state.next})};
    if (method === 'imopenlines.crm.chat.get') return {result:[{CHAT_ID:state.chat,CONNECTOR_ID:state.connector,CONNECTOR_TITLE:state.title}]};
    if (method === 'imopenlines.session.history.get') {
      const h = structuredClone(state.history);
      if (state.changed) h.message[50].text = 'Изменено';
      return {result:h};
    }
    throw Error('Запрещённый метод');
  }};
  const lookup = async scope => {
    state.lookupCalls++; assert.equal(Object.isFrozen(scope), true);
    assert.deepEqual(scope, {deal_id:deal,chat_id:'12',session_id:'34',line_id:'9',cutoff});
    return {kind:'single_session_lookup_v1',status:'found',session:structuredClone(state.record)};
  };
  const verifier = createGeneralSessionVerifier({client,lookupSession:lookup,dealId:deal,transitionId:transition});
  return {input,state,client,lookup,verifier};
}

test('одна сессия привязана к сделке, переходу, чату, линии и неизменной истории; произвольные сделки', async () => {
  for (const deal of ['127114','98765']) {
    const f=fixture(deal); const proof=await f.verifier(f.input);
    assert.equal(proof?.kind,'verified_fallback_session_v1');
    assert.equal(proof?.deal_id,deal); assert.equal(proof?.session_created_at,f.state.record.dateCreate);
    assert.equal(proof?.checks.session_crm_matches_deal,true);
    assert.equal(f.state.lookupCalls,1);
    assert.deepEqual(f.state.calls.map(x=>x.method),['crm.deal.get','crm.stagehistory.list','imopenlines.crm.chat.get',
      'imopenlines.session.history.get','imopenlines.session.history.get','imopenlines.session.history.get',
      'imopenlines.crm.chat.get','crm.deal.get','crm.stagehistory.list']);
    assert.equal('history_complete' in proof,false);
  }
});
test('identity Wappi с непрозрачным кодом подтверждает сессию, но default не подтверждает авторство',async()=>{
 const f=fixture();f.state.connector='opaque_connector';f.state.title='Wappi WhatsApp';
 f.input.history.chat[12].entityId='opaque_connector|9|client|user';
 f.input.history_sha256=createHash('sha256').update(JSON.stringify(f.input.history)).digest('hex');
 assert.equal(await f.verifier(f.input),null);
 const identity=createGeneralSessionVerifier({client:f.client,lookupSession:f.lookup,dealId:'127114',transitionId:'321',purpose:'session_identity'});
 assert.equal((await identity(f.input))?.checks.session_crm_matches_deal,true);
 assert.equal('history_complete' in await identity(f.input),false);
 for(const change of [()=>f.state.connector='different',()=>{f.state.connector='opaque_connector';f.state.title='Другой';},
  ()=>{f.state.connector='unknown';f.state.title='Wappi';},()=>{f.state.connector='wz_test';f.state.title='Wappi';}]){
  change();assert.equal(await identity(f.input),null);
 }
 assert.throws(()=>createGeneralSessionVerifier({client:f.client,lookupSession:f.lookup,dealId:'127114',transitionId:'321',purpose:'invalid'}));
});
test('identity проверка Wazzup требует точного совпадения кода с entityId',async()=>{
 const f=fixture(),identity=createGeneralSessionVerifier({client:f.client,lookupSession:f.lookup,dealId:'127114',transitionId:'321',purpose:'session_identity'});
 assert.equal((await identity(f.input))?.kind,'verified_fallback_session_v1');
 f.state.connector='wz_other';assert.equal(await identity(f.input),null);
});
test('Telegram identity не подтверждает авторство и требует точного кода и привязки к сделке',async()=>{
 const f=fixture();f.state.connector='telegrambot';f.state.title='Telegram';
 f.input.history.chat[12].entityId='telegrambot|9|client|user';
 f.input.history_sha256=createHash('sha256').update(JSON.stringify(f.input.history)).digest('hex');
 const identity=createGeneralSessionVerifier({client:f.client,lookupSession:f.lookup,dealId:'127114',transitionId:'321',purpose:'session_identity'});
 assert.equal((await identity(f.input))?.kind,'verified_fallback_session_v1');
 assert.equal(await f.verifier(f.input),null);
 f.state.record.crmEntityId='1';assert.equal(await identity(f.input),null);f.state.record.crmEntityId='127114';
 f.state.connector='telegrambot_fake';assert.equal(await identity(f.input),null);f.state.connector='telegrambot';
 f.state.title='Wappi Telegram';assert.equal(await identity(f.input),null);
});
test('role_inference требует точный код коннектора исходного снимка и проверяет его повторно',async()=>{
  for(const change of [f=>{f.state.connector='wz_other';}, f=>{f.state.connector='';},
    f=>{f.state.connector='unknown';},f=>{f.state.title='Wappi';}]) {
    const f=fixture();change(f);
    assert.equal(await f.verifier(f.input),null);
    assert.equal(f.state.lookupCalls,0);
  }
  const f=fixture();
  const lookup=async scope=>{const proof=await f.lookup(scope);f.state.connector='wz_other';return proof;};
  const verifier=createGeneralSessionVerifier({client:f.client,lookupSession:lookup,dealId:'127114',transitionId:'321'});
  assert.equal(await verifier(f.input),null);
  assert.equal(f.state.lookupCalls,1); // Совпадение обязательно и после lookup.
});
test('границы и входной снимок до чтения: чужая сделка, неверная дата, ID, линия или hash', async () => {
  for (const change of [f=>f.input.deal_id='2',f=>f.input.chat_id='0',f=>f.input.session_id='01',
    f=>f.input.line_id='10',f=>f.input.cutoff='2026-02-30T00:00:00Z',f=>f.input.history_sha256='a'.repeat(64),
    f=>f.input.history.chat[12].entityId='wz_test|9|other|user']) {
    const f=fixture();change(f);assert.equal(await f.verifier(f.input),null);assert.equal(f.state.calls.length,0);
  }
  assert.throws(()=>createGeneralSessionVerifier({client:{request(){}},lookupSession:()=>{},dealId:'1'}));
});
test('полученные сырые поля сессии и результат lookup проверяются, boolean сам по себе недостаточен', async () => {
  for (const change of [r=>r.id=35,r=>r.chatId=13,r=>r.configId=10,r=>r.crmEntityType='lead',
    r=>r.crmEntityId='1',r=>r.dateCreate='2026-11-01T00:00:00Z',r=>r.dateCreate='2026-02-30T00:00:00Z',
    r=>r.dateClose='2026-01-01T00:00:00Z']) {
    const f=fixture();change(f.state.record);assert.equal(await f.verifier(f.input),null);
  }
  const f=fixture();const verifier=createGeneralSessionVerifier({client:f.client,lookupSession:async()=>true,dealId:'127114',transitionId:'321'});
  assert.equal(await verifier(f.input),null);
});
test('отсутствующая CRM-связь чата, другой коннектор, переход или соседний переход с равной датой блокируют проверку', async () => {
  for (const change of [f=>f.state.chat=13,f=>f.state.connector='wappi',f=>f.state.title='Wappi',
    f=>f.state.stage='C23:NEW',f=>f.state.transition='322',
    f=>f.state.stageRows=[{ID:'321',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff},{ID:'320',STAGE_ID:'C23:NEW',CREATED_TIME:cutoff}],
    f=>{f.state.stageRows=[{ID:'321',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}];f.state.next=50;}]) {
    const f=fixture();change(f);assert.equal(await f.verifier(f.input),null);assert.equal(f.state.lookupCalls,0);
  }
});
test('изменение или несоответствие повторно прочитанной истории и сессии после lookup блокирует проверку', async () => {
  for(const mutate of [f=>{f.state.changed=true;}, f=>{f.state.history.chat[12].entityId='wz_test|9|other|user';},
    f=>{f.state.chat=13;},f=>{f.state.transition='322';},f=>{f.input.history.message[50].text='подмена';}]) {
    const f=fixture();
    const lookup=async scope=>{const result=await f.lookup(scope);mutate(f);return result;};
    const verifier=createGeneralSessionVerifier({client:f.client,lookupSession:lookup,dealId:'127114',transitionId:'321'});
    assert.equal(await verifier(f.input),null);
  }
});
test('ошибка lookup или клиента остаётся неопределённостью, сведения об ошибке не выводятся', async () => {
  const f=fixture();
  const verifier=createGeneralSessionVerifier({client:f.client,lookupSession:async()=>{throw Error('приватная ошибка');},dealId:'127114',transitionId:'321'});
  assert.equal(await verifier(f.input),null);
  const broken=createGeneralSessionVerifier({client:{async request(){throw Error('приватная ошибка');}},lookupSession:f.lookup,dealId:'127114',transitionId:'321'});
  assert.equal(await broken(f.input),null);
});
test('подключение к нормализатору только в silent, без изменения прежних идентификаторов', async () => {
  const f=fixture();
  const collection={_status:'pending_normalization',deal_id:'127114',silent:true,deal_data:{lose_date:cutoff},
    _sources:Object.fromEntries(['calls','openlines','comments','tasks'].map(k=>[k,{complete:true}])),
    raw:{calls:[],comments:[],tasks:[],chats:[{CHAT_ID:12,CONNECTOR_ID:'wz_test'}],
      sessions:[{chat_id:12,history:f.input.history}]}};
  const original=(await normalizeCommunications({collection})).deal_data.communications;
  const normalized=(await normalizeCommunications({collection,verifyFallbackSession:f.verifier})).deal_data.communications;
  assert.equal(normalized.length,1);
  assert.equal(normalized[0].session_id,original[0].session_id);
  assert.equal(normalized[0].message_id,original[0].message_id);
  assert.equal(communicationRow('127114',normalized[0],0).event_id,communicationRow('127114',original[0],0).event_id);
  let calls=0;
  const inferred=await inferChatRoles({communications:normalized,dealId:'127114',cutoff,client:{async complete(body){
    calls++; const entries=JSON.parse(body.messages[1].content).messages;
    return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({roles:entries.map(x=>({id:x.id,role:'client',impact:'not_applicable'}))})}}]};
  }}});
  assert.equal(calls,1);assert.equal(inferred.communications[0].role,'Клиент');
  collection.silent=false;
  const before=f.state.calls.length;
  const disabled=(await normalizeCommunications({collection,verifyFallbackSession:f.verifier})).deal_data.communications;
  assert.equal(disabled[0].inference_session_id,undefined);assert.equal(f.state.calls.length,before);
});
test('ограниченный поиск и обобщённая проверка совместимы; неполная пагинация не выдаёт подтверждение', async () => {
  const f=fixture('98765');
  let requests=0, truncated=false;
  const lookupClient={async request(method,body){
    requests++;assert.equal(method,'imopenlines.v2.Session.list');
    assert.equal(body.configId,9);assert.equal(body.limit,200);assert.equal(body.offset,0);
    return {result:{sessions:truncated?Array.from({length:200},(_,i)=>({...f.state.record,id:i+100})):[f.state.record],hasNextPage:truncated}};
  }};
  const lookup=createSessionLookup({client:lookupClient,from:'2026-01-01T00:00:00Z',maxPages:1});
  const verifier=createGeneralSessionVerifier({client:f.client,lookupSession:lookup,dealId:'98765',transitionId:'321'});
  assert.equal((await verifier(f.input))?.deal_id,'98765'); assert.equal(requests,1);
  truncated=true;
  assert.equal(await verifier(f.input),null);assert.equal(requests,2);
});
test('история стадий читается полностью, одинаковые total согласованы между страницами и повтором', async () => {
  const f=fixture(); const t=Date.parse(cutoff);
  const rows=Array.from({length:51},(_,i)=>({ID:String(i===0?321:500+i),STAGE_ID:i===0?'C23:LOSE':'C23:NEW',
    CREATED_TIME:new Date(t-i*1000).toISOString()}));
  f.state.stageResponses={0:{result:{items:rows.slice(0,50)},total:51,next:50},
    50:{result:{items:rows.slice(50)},total:51}};
  assert.equal((await f.verifier(f.input))?.deal_id,'127114');
  assert.deepEqual(f.state.calls.filter(x=>x.method==='crm.stagehistory.list').map(x=>x.body.start),[0,50,0,50]);
});
test('неполные, несконсистентные или повреждённые страницы истории стадий не дают подтверждение', async () => {
  const t=Date.parse(cutoff);
  const base=Array.from({length:51},(_,i)=>({ID:String(i===0?321:500+i),STAGE_ID:i===0?'C23:LOSE':'C23:NEW',
    CREATED_TIME:new Date(t-i*1000).toISOString()}));
  for(const mutate of [
    r=>{delete r[0].next;}, r=>{r[50].total=52;}, r=>{r[50].total=undefined; r[50].result.items=[];},
    r=>{r[0].next=49;},r=>{r[0].total=50;},r=>{r[50].result.items[0].ID=r[0].result.items[20].ID;},
    r=>{r[50].result.items[0].CREATED_TIME=r[0].result.items[10].CREATED_TIME;},
    r=>{r[0].result.items[15].CREATED_TIME='не дата';},
    r=>{r[0].result.items[15].STAGE_ID='';},
  ]) {
    const f=fixture(), responses={0:{result:{items:structuredClone(base.slice(0,50))},total:51,next:50},
      50:{result:{items:structuredClone(base.slice(50))},total:51}};
    mutate(responses);f.state.stageResponses=responses;
    assert.equal(await f.verifier(f.input),null);assert.equal(f.state.lookupCalls,0);
  }
  const f=fixture(); f.state.stageRows=base.slice(0,50); // Полная страница без total и next — не доказательство конца.
  assert.equal(await f.verifier(f.input),null);
});
test('точность времени не округляется: микросекунды в cutoff, переходе и записи сессии блокируют проверку', async () => {
  const before=fixture(); before.input.cutoff='2026-10-28T05:35:03.000001Z';
  assert.equal(await before.verifier(before.input),null);assert.equal(before.state.calls.length,0);
  const event=fixture();event.state.stageRows=[{ID:'321',STAGE_ID:'C23:LOSE',CREATED_TIME:'2026-10-28T05:35:03.000001Z'}];
  assert.equal(await event.verifier(event.input),null);assert.equal(event.state.lookupCalls,0);
  const record=fixture();record.state.record.dateCreate='2026-10-28T05:35:03.000001Z';
  assert.equal(await record.verifier(record.input),null);
});
