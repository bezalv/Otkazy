import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRoleSessionContext } from '../../app/src/worker/role-session-context.mjs';

const cutoff = '2026-10-28T05:35:03.000Z';
const from = '2026-01-01T00:00:00.000Z';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture() {
  const history = { chatId:12, sessionId:34, chat:{12:{entityId:'wz_test|9|client|user'}}, users:{}, files:{},
    message:{50:{id:50,text:'Синтетическое сообщение',date:'2026-10-27T00:00:00Z'}} };
  const input = { deal_id:'127114',chat_id:'12',session_id:'34',line_id:'9',cutoff,
    history_sha256:digest(history),history };
  const state = { calls:[], history, transition:'321', connector:'wz_test',title:'Wazzup',
    record:{id:34,chatId:12,configId:9,crmEntityType:'deal',crmEntityId:'127114',dateCreate:'2026-10-27T00:00:00Z'},
    changed:false,truncated:false };
  const client = { async request(method, body) {
    state.calls.push({method,body:structuredClone(body)});
    if (method === 'crm.deal.get') return {result:{ID:'127114',STAGE_ID:'C23:LOSE'}};
    if (method === 'crm.stagehistory.list') return {result:{items:[
      {ID:state.transition,STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff},
      {ID:'300',STAGE_ID:'C23:NEW',CREATED_TIME:'2026-10-27T00:00:00Z'}]}};
    if (method === 'imopenlines.crm.chat.get') return {result:[{CHAT_ID:12,CONNECTOR_ID:state.connector,CONNECTOR_TITLE:state.title}]};
    if (method === 'imopenlines.session.history.get') {
      const h=structuredClone(state.history);if(state.changed)h.message[50].text='Изменено';return {result:h};
    }
    if (method === 'imopenlines.v2.Session.list') {
      assert.equal(body.configId,9); assert.equal(body.dateCreateFrom,from); assert.equal(body.dateCreateTo,cutoff);
      assert.equal(body.limit,200); assert.equal(body.offset,0);
      return {result:{sessions:state.truncated?Array.from({length:200},(_,i)=>({...state.record,id:100+i})):[state.record],
        hasNextPage:state.truncated}};
    }
    throw Error('неожиданный метод');
  }};
  const options={client,dealId:'127114',transitionId:'321',cutoff,from};
  return {input,state,options};
}

test('контекст привязывает доказательство к сделке, переходу и неизменённой сессии без доказательства всей истории',async()=>{
  const f=fixture(), context=createRoleSessionContext(f.options);
  assert.equal(f.state.calls.length,0);
  const result=await context.verify(f.input);
  assert.equal(result?.kind,'verified_fallback_session_v1');
  assert.equal(result?.deal_id,'127114');assert.equal(result?.checks.session_crm_matches_deal,true);
  assert.equal('history_complete' in result,false);
  assert.equal(context.stats().reads,f.state.calls.length);
  assert.equal(context.stats().budget_exhausted,false);
});
test('отдельная Wappi-сессия подтверждает только identity, а не авторство',async()=>{
  const f=fixture();f.state.connector='opaque';f.state.title='Wappi WhatsApp';
  f.state.history.chat[12].entityId='opaque|9|client|user';f.input.history_sha256=digest(f.input.history);
  const proof=await createRoleSessionContext(f.options).verify(f.input);
  assert.equal(proof?.kind,'verified_fallback_session_v1');
  assert.equal('author' in proof,false);assert.equal('history_complete' in proof,false);
});
test('чужая сделка или иное время перехода отклоняются до чтения',async()=>{
  for(const mutate of [f=>f.input.deal_id='5',f=>f.input.cutoff='2026-10-28T05:35:04.000Z']){
    const f=fixture();mutate(f);assert.equal(await createRoleSessionContext(f.options).verify(f.input),null);
    assert.equal(f.state.calls.length,0);
  }
});
test('неподтверждённый переход, изменённая история или неполная выдача lookup не подтверждают сессию',async()=>{
  for(const mutate of [f=>f.state.transition='322',f=>f.state.changed=true,f=>f.state.truncated=true]){
    const f=fixture();mutate(f);const context=createRoleSessionContext({...f.options,maxPages:1});
    assert.equal(await context.verify(f.input),null);
  }
});
test('ограничение числа чтений срабатывает до следующего запроса и не выдаёт подтверждение',async()=>{
  const f=fixture(), context=createRoleSessionContext({...f.options,maxReads:3});
  assert.equal(await context.verify(f.input),null);assert.equal(f.state.calls.length,3);
  assert.deepEqual(context.stats(),{reads:3,budget_exhausted:true});
});
test('параллельные вызовы не делят состояние сессии и не обходят пределы чтения',async()=>{
  const f=fixture(), request=f.options.client.request;let release;
  const gate=new Promise(resolve=>{release=resolve;});let first=true;
  f.options.client={async request(...args){if(first){first=false;await gate;}return request(...args);}};
  const context=createRoleSessionContext(f.options), pending=context.verify(f.input);
  assert.equal(await context.verify(f.input),null);release();
  assert.equal((await pending)?.kind,'verified_fallback_session_v1');
});
test('смена переданного снимка во время чтения не меняет то, что проверяется',async()=>{
  const f=fixture(), request=f.options.client.request;f.state.history=structuredClone(f.state.history);
  let release;const gate=new Promise(resolve=>{release=resolve;});let first=true;
  f.options.client={async request(...args){if(first){first=false;await gate;}return request(...args);}};
  const oldHash=f.input.history_sha256, context=createRoleSessionContext(f.options), pending=context.verify(f.input);
  f.input.history.message[50].text='подмена';f.input.history_sha256=digest(f.input.history);release();
  const proof=await pending;
  assert.equal(proof?.kind,'verified_fallback_session_v1');assert.equal(proof.history_sha256,oldHash);
  assert.notEqual(proof.history_sha256,f.input.history_sha256);
});
test('ошибки параметров и отмена до вызова не выполняют чтение',async()=>{
  const f=fixture();
  for(const patch of [{dealId:'0'},{transitionId:null},{cutoff:'2026-10-28'},
    {from:'2020-01-01T00:00:00Z'},{maxPages:21},{maxReads:0}])
    assert.throws(()=>createRoleSessionContext({...f.options,...patch}),TypeError);
  const controller=new AbortController();controller.abort();
  const context=createRoleSessionContext({...f.options,signal:controller.signal});
  assert.equal(await context.verify(f.input),null);assert.equal(f.state.calls.length,0);
});
