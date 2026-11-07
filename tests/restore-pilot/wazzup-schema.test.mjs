import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHistory, runSchemaCase } from '../../app/src/pilot/wazzup-schema.mjs';

function fixture() {
  const secret='DO_NOT_DISCLOSE_CLIENT_DATA_OR_TOKENS';
  return { dealId:'127114', chats:[{CHAT_ID:'11',CONNECTOR_ID:'wz_1',CONNECTOR_TITLE:'Wazzup',SECRET:secret}],
    sessions:[{chat_id:'11',history:{chat:{11:{entity_id:secret}},users:{44:{connector:true,extranet:true,externalAuthId:'imconnector',name:secret}},
      message:{55:{senderid:44,text:`=== Исходящее сообщение === ${secret}`,params:{connectorMid:'ABC',DIRECTION:'outgoing',isEcho:true,from_me:false,UNKNOWN:secret}},
        56:{senderid:44,text:secret,params:{connectorMid:'ABC'}},57:{senderid:0,text:'=== Входящее сообщение === data',params:{connectorMid:['id']}}}}}],
    additional:[{chat_id:'11',dialog:{id:11,entity_id:secret},messages:[{id:55,author_id:44,uuid:secret,params:{connectorMid:'ABC'}},{id:99,author_id:44,text:secret}]}] };
}

test('группирует только заранее разрешённые поля и типы, не раскрывая данные',()=>{
  const report=summarizeHistory(fixture()),s=report.sessions[0];
  assert.equal(report.message_count,3);assert.equal(s.connector,'wazzup');
  assert.equal(s.groups.outgoing.messages,1);assert.equal(s.groups.incoming.messages,1);assert.equal(s.groups.headerless.messages,1);
  assert.deepEqual(s.groups.outgoing.params.CONNECTORMID,[0,1,0,0,0,0]);
  assert.deepEqual(s.groups.outgoing.params.ISECHO,[0,0,0,1,0,0]);assert.deepEqual(s.groups.outgoing.params.FROM_ME,[0,0,0,1,0,0]);
  assert.equal(s.groups.outgoing.params_echo.true,1);assert.equal(s.groups.outgoing.params_from_me.false,1);
  assert.equal(s.groups.outgoing.params_direction.outgoing,1);assert.equal(s.groups.headerless.params_direction.missing,1);
  assert.deepEqual(s.groups.incoming.params.CONNECTORMID,[0,0,0,0,1,0]);
  assert.equal(s.sender_with_outgoing_and_headerless,1);
  assert.equal(s.connector_mid_comparable_values,3);assert.equal(s.connector_mid_distinct_values,2);assert.equal(s.connector_mid_duplicate_occurrences,1);
  assert.equal(report.additional.matched_messages,1);assert.equal(report.additional.matched_author_sender,1);assert.equal(report.additional.matched_connector_mid,1);
  const data=JSON.stringify(report);assert.doesNotMatch(data,/DO_NOT_DISCLOSE|ABC|UNKNOWN|imconnector/);
});

test('неизвестные поля не раскрываются, неоднозначная схема отклоняется',()=>{
  const x=fixture();x.sessions[0].history.message[55].senderID='private';
  assert.throws(()=>summarizeHistory(x),/Неоднозначное имя поля/);
  assert.throws(()=>summarizeHistory({...fixture(),dealId:'1'}),/Недопустимая/);
});

test('сообщения сопоставляются только внутри одного чата, неоднозначные повторы исключены',()=>{
  const x=fixture();
  x.chats.push({CHAT_ID:'12',CONNECTOR_ID:'wappi',CONNECTOR_TITLE:'Wazzup'});
  x.sessions.push({chat_id:'12',history:{chat:{12:{}},users:{},message:{55:{id:55,senderid:99,text:'private'}}}});
  x.additional.push({chat_id:'12',dialog:{},messages:[{id:55,author_id:99}]});
  let result=summarizeHistory(x);
  assert.equal(result.sessions[1].connector,'other_or_unknown');
  assert.equal(result.additional.matched_messages,2);assert.equal(result.additional.matched_author_sender,2);
  x.sessions.push({chat_id:'11',history:{chat:{11:{}},users:{},message:{55:{id:55,senderid:44,text:'private'}}}});
  result=summarizeHistory(x);
  assert.equal(result.additional.history_id_collisions,1);
  assert.equal(result.additional.matched_messages,1);assert.equal(result.additional.matched_author_sender,1);
});

test('пилот читает только зафиксированные методы и не требует доступа к im',async()=>{
  const calls=[],x=fixture();let closed=false;
  const responses={'imopenlines.crm.chat.get':{result:x.chats},'crm.activity.list':{result:[{ID:'22',ASSOCIATED_ENTITY_ID:'33'}],total:1},
    'imopenlines.session.history.get':{result:x.sessions[0].history},'imopenlines.dialog.get':{result:x.additional[0].dialog}};
  const result=await runSchemaCase({dealId:x.dealId,env:{BITRIX_REST_BASE:'https://dinalnsk.bitrix24.ru/rest/1/TESTTOKEN'},
    makeLimiter:()=>({close(){closed=true;}}),makeClient:()=>({async request(method,body){calls.push({method,body});
      if(method==='im.dialog.messages.get')throw new Error('SECRET: access denied');
      if(!Object.hasOwn(responses,method))throw new Error('forbidden');return responses[method];}})});
  assert.equal(result.status,'observed');assert.equal(result.additional.pages_unavailable,1);assert.equal(result.additional.dialogs_ok,1);
  assert.equal(closed,true);assert.doesNotMatch(JSON.stringify(result),/SECRET|TESTTOKEN|DO_NOT_DISCLOSE/);
  assert.deepEqual(new Set(calls.map(c=>c.method)),new Set(['imopenlines.crm.chat.get','crm.activity.list','imopenlines.session.history.get','imopenlines.dialog.get','im.dialog.messages.get']));
  assert.deepEqual(calls.find(c=>c.method==='im.dialog.messages.get').body,{DIALOG_ID:'chat11',LIMIT:50});
});

test('неизвестная сделка и внешний адрес запрещены до сети',async()=>{
  let called=false;
  const opts={env:{BITRIX_REST_BASE:'https://example.invalid/rest/1/TESTTOKEN'},makeClient:()=>{called=true;return {};},makeLimiter:()=>({})};
  await assert.rejects(runSchemaCase({...opts,dealId:'1'}));
  await assert.rejects(runSchemaCase({...opts,dealId:'127114'}));assert.equal(called,false);
});
