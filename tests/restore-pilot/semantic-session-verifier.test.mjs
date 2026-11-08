import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticSessionVerifier } from '../../app/src/pilot/semantic-session-verifier.mjs';

const cutoff='2026-10-28T05:35:03.000Z';
function fixture() {
  const history={chatId:12,sessionId:34,chat:{12:{entityId:'wz_x|9|c|u'}},users:{},files:{},
    message:{50:{id:50,text:'Текст',date:'2026-10-27T00:00:00Z'}}};
  const input={deal_id:'127114',chat_id:'12',session_id:'34',line_id:'9',cutoff,history_sha256:'a'.repeat(64),history};
  const state={current:structuredClone(history),direct:structuredClone(history),chat:12,inspected:true};
  const client={async request(method) {
    if(method==='imopenlines.crm.chat.get')return {result:[{CHAT_ID:state.chat,CONNECTOR_ID:'wz_test'}]};
    if(method==='imopenlines.session.history.get')return {result:arguments[1].CHAT_ID?state.current:state.direct};
    throw Error('forbidden');
  }};
  const inspect=async ({onVerified}) => {
    if(state.inspected)onVerified({session_id:'34',chat_id:'12',line_id:'9',session_created_at:'2026-10-27T00:00:00Z'});
    return {status:'verified',stage:'session_link_verified',deal_counts:{only_known_target_session:true}};
  };
  return {input,state,client,inspect};
}
test('подтверждает только тот снимок, чат и сессию, которые проверены на той же операции',async()=>{
  const {input,client,inspect}=fixture();
  const result=await createSemanticSessionVerifier(client,{inspect})(input);
  assert.equal(result?.session_created_at,'2026-10-27T00:00:00Z');
  assert.equal(result?.checks.session_crm_matches_deal,true);
});
test('изменение истории, другой чат или отсутствие подтверждения не разрешают классификацию',async()=>{
  for(const change of [f=>f.state.current.message[50].text='изменено',f=>f.state.direct.sessionId=35,
    f=>f.state.current.chat[12].entityId='wz_x|9|different|u',
    f=>f.state.chat=13,f=>f.state.inspected=false,f=>f.input.deal_id='127115',f=>f.input.line_id='10']) {
    const f=fixture();change(f);
    assert.equal(await createSemanticSessionVerifier(f.client,{inspect:f.inspect})(f.input),null);
  }
});
