import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chatEventCandidates, selectExistingChatEvent } from '../../app/src/persistence/chat-identity.mjs';

function fixture() {
  const history={chatId:12,sessionId:34,chat:{12:{entityId:'connector|9|external|user'}},
    users:{},files:{},message:{56:{id:56,text:'Текст'}}};
  const sessionProof={kind:'verified_fallback_session_v1',deal_id:'42',chat_id:'12',session_id:'34',line_id:'9',
    cutoff:'2026-11-04T12:00:00.000Z',session_created_at:'2026-11-01T12:00:00.000Z',
    history_sha256:createHash('sha256').update(JSON.stringify(history)).digest('hex'),
    checks:{chat_bound_to_deal:true,session_matches_chat:true,session_matches_line:true,
      session_crm_matches_deal:true,direct_session_history_matches:true,current_chat_history_matches:true}};
  const messageIdentityProof={kind:'verified_chat_message_identity_v1',deal_id:'42',chat_id:'12',session_id:'34',message_id:'56',
    history_sha256:sessionProof.history_sha256,unique_in_chat:true};
  return {dealId:42,chatId:12,sessionId:34,messageId:56,currentEventId:'34_56',sessionProof,messageIdentityProof,history};
}
const row=(event_id,extra={})=>({deal_id:42,event_type:'chat',chat_id:12,event_id,...extra});

test('при подтверждённой сессии доступны ровно два полных идентификатора',()=>{
  const input=fixture();const result=chatEventCandidates(input);
  assert.equal(result.status,'eligible');assert.deepEqual(result.candidates,['34_56','chat_12_56']);
  assert.deepEqual(selectExistingChatEvent(input,[]),{status:'new',eventId:'34_56'});
});
test('fallback → activity и activity → fallback сохраняют существующий event_id',()=>{
  const explicit=fixture();
  assert.deepEqual(selectExistingChatEvent(explicit,[row('chat_12_56')]),{status:'existing',eventId:'chat_12_56'});
  const fallback={...fixture(),currentEventId:'chat_12_56'};
  assert.deepEqual(selectExistingChatEvent(fallback,[row('34_56')]),{status:'existing',eventId:'34_56'});
  assert.deepEqual(selectExistingChatEvent(fallback,[]),{status:'new',eventId:'chat_12_56'});
});
test('обе формы или повтор строки не выбираются молча и не меняются',()=>{
  const rows=[row('34_56'),row('chat_12_56')],before=structuredClone(rows);
  assert.deepEqual(selectExistingChatEvent(fixture(),rows),{status:'ambiguous',reason:'both_aliases_exist'});
  assert.deepEqual(rows,before);
  assert.deepEqual(selectExistingChatEvent(fixture(),[row('34_56'),row('34_56')]),{status:'ambiguous',reason:'duplicate_rows'});
});
test('несовпадения сделки, чата, сессии, message id и типа не объединяются',()=>{
  for(const other of [row('34_56',{deal_id:43}),row('34_56',{chat_id:13}),row('34_56',{event_type:'call'}),
    row('35_56'),row('34_57'),row('chat_13_56'),row('34_file_56'),row('chat_12_file_56')]) {
    assert.deepEqual(selectExistingChatEvent(fixture(),[other]),{status:'ambiguous',reason:'row_mismatch'});
  }
});
test('поддельный или неполный proof не является подтверждением',()=>{
  for(const mutate of [i=>i.sessionProof=null,i=>i.sessionProof=true,i=>i.sessionProof.checks.session_crm_matches_deal=false,
    i=>i.sessionProof.chat_id='13',i=>i.sessionProof.session_id='35',i=>i.sessionProof.line_id='10',
    i=>i.sessionProof.session_created_at='2026-11-05T12:00:00Z',i=>i.sessionProof.cutoff='2026-11-04T12:00:00.000001Z']) {
    const input=fixture();mutate(input);assert.equal(chatEventCandidates(input).status,'ambiguous');
  }
});
test('идентичность сообщения требует отдельного подтверждения уникальности во всём чате',()=>{
  for(const mutate of [i=>{delete i.messageIdentityProof;},i=>{i.messageIdentityProof.unique_in_chat=false;},
    i=>{i.messageIdentityProof.message_id='57';},i=>{i.messageIdentityProof.session_id='35';},
    i=>{i.messageIdentityProof.history_sha256='0'.repeat(64);},i=>{i.messageIdentityProof.extra=true;}]) {
    const input=fixture();mutate(input);
    assert.deepEqual(chatEventCandidates(input),{status:'ambiguous',reason:'unverified_message_identity'});
  }
});
test('дополнительные и отсутствующие поля proof, изменение и подмена истории блокируются',()=>{
  for(const mutate of [i=>{i.sessionProof.extra=true;},i=>{delete i.sessionProof.checks.chat_bound_to_deal;},
    i=>{i.history.message[56].text='Изменено';},i=>{i.history.chatId=13;},i=>{i.history.sessionId=35;},
    i=>{i.history.chat[12].entityId='connector|10|external|user';},i=>{delete i.history.message[56];}]) {
    const input=fixture();mutate(input);assert.equal(chatEventCandidates(input).status,'ambiguous');
  }
});
test('точные альтернативы не смешиваются с отдельными вложениями',()=>{
  const input=fixture();input.messageId='file_56';input.currentEventId='chat_12_file_56';
  assert.deepEqual(chatEventCandidates(input),{status:'ambiguous',reason:'invalid_identity'});
  const message=fixture();message.history.message[56].params={FILE_ID:[99]};
  message.sessionProof.history_sha256=createHash('sha256').update(JSON.stringify(message.history)).digest('hex');
  message.messageIdentityProof.history_sha256=message.sessionProof.history_sha256;
  assert.equal(selectExistingChatEvent(message,[row('chat_12_56')]).status,'existing');
  assert.equal(selectExistingChatEvent(message,[row('chat_12_file_99')]).status,'ambiguous');
});
test('проверка подтверждает единственное сообщение именно в снимке сессии',()=>{
  const duplicate=fixture();duplicate.history.message[57]={id:56,text:'Другая запись'};
  duplicate.sessionProof.history_sha256=createHash('sha256').update(JSON.stringify(duplicate.history)).digest('hex');
  duplicate.messageIdentityProof.history_sha256=duplicate.sessionProof.history_sha256;
  assert.deepEqual(chatEventCandidates(duplicate),{status:'ambiguous',reason:'duplicate_message'});
  const absent=fixture();absent.messageId=57;absent.currentEventId='34_57';absent.messageIdentityProof.message_id='57';
  assert.deepEqual(chatEventCandidates(absent),{status:'ambiguous',reason:'message_not_found'});
});
test('некорректные значения и чужой текущий ID не попадают в кандидаты',()=>{
  for(const [field,value] of [['dealId','01'],['chatId','12 OR 1=1'],['sessionId',0],['messageId',NaN],
    ['messageId','56_file_9'],['currentEventId','35_56'],['currentEventId','chat_13_56']]) {
    const input=fixture();input[field]=value;assert.equal(chatEventCandidates(input).status,'ambiguous');
  }
  assert.deepEqual(selectExistingChatEvent(fixture(),null),{status:'ambiguous',reason:'invalid_rows'});
});
