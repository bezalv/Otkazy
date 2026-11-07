import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, constants, privateDecrypt, createDecipheriv } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { summarizeHistory, runSampleCase } from '../../app/src/pilot/wazzup-samples.mjs';
import { sealEvidenceReport } from '../../app/src/pilot/evidence-review.mjs';

const dealId='127114',chats=[{CHAT_ID:12,CONNECTOR_ID:'wz_connector',CONNECTOR_TITLE:'Wazzup'}];
const messages={
  1:{id:1,senderid:4,text:'=== Исходящее сообщение === Мы можем предложить заменить конструкцию. +7 (900) 555-55-55'},
  2:{id:2,senderid:4,text:'Не надо менять окно, варианты у нас есть уже. secret-private-data'},
  3:{id:3,senderid:4,text:'=== Входящее сообщение === Я уже заказала'},
  4:{id:4,senderid:7,text:'клиент процитировал: === Исходящее сообщение === спасибо'},
};
const history={chat:{12:{}},users:{4:{connector:true,extranet:true,externalAuthId:'imconnector'},7:{connector:false}},message:messages};
const sessions=[{history}];
test('исходящее без имени, общий sender и отсутствие заголовка различаются без исходных текстов',()=>{
  const value=summarizeHistory({dealId,chats,sessions});
  assert.equal(value.session_count,1);assert.equal(value.message_count,4);
  const s=value.sessions[0];assert.equal(s.connector,'wazzup');assert.equal(s.counts.outgoing_start,1);assert.equal(s.counts.incoming_start,1);
  assert.equal(s.counts.headerless,1);assert.equal(s.counts.embedded_or_quoted,1);assert.equal(s.counts.outgoing_as_client,1);
  assert.equal(s.sender_summary[0].outgoing_start,1);assert.equal(s.sender_summary[0].headerless,1);
  assert.equal(s.examples[0].old_role,'client');assert.equal(s.examples[0].content_hint,'seller_offer');
  assert.equal(s.examples[1].header_direction,'none');assert.equal(s.examples[1].old_role,'client');
  assert.doesNotMatch(JSON.stringify(value),/555|secret-private|предложить|Не надо|senderid|CHAT_ID/i);
});
test('неизвестный коннектор не превращается в Wazzup, цитаты не считаются началом заголовка',()=>{
  const value=summarizeHistory({dealId,chats:[{CHAT_ID:12}],sessions});
  assert.equal(value.sessions[0].connector,'other_or_unknown');
  assert.equal(value.sessions[0].examples.at(-1).header_position,'embedded');
  const quoted={...history,message:{1:{senderid:4,text:'[QUOTE]=== Исходящее сообщение === ...[/QUOTE]'}}};
  assert.equal(summarizeHistory({dealId,chats,sessions:[{history:quoted}]}).sessions[0].examples[0].header_position,'quote');
});
test('отклоняет произвольные сделки, неоднозначные чаты и превышение сессий',()=>{
  assert.throws(()=>summarizeHistory({dealId:'1',chats,sessions}));
  assert.throws(()=>summarizeHistory({dealId,chats:[...chats,...chats],sessions}));
  assert.throws(()=>summarizeHistory({dealId,chats,sessions:Array(13).fill(sessions[0])}));
});
const env={BITRIX_REST_BASE:'https://dinalnsk.bitrix24.ru/rest/1/thisisatesttoken'};
test('читает только чаты и связанные истории, закрывает лимитер и не вызывает иные методы',async()=>{
  let closed=false;const calls=[];
  const fake={async request(method,body){calls.push({method,body});
    if(method==='imopenlines.crm.chat.get')return {result:chats};
    if(method==='crm.activity.list')return {result:[{ID:20,ASSOCIATED_ENTITY_ID:23}],total:1};
    if(method==='imopenlines.session.history.get'){assert.equal(body.SESSION_ID,23);return {result:history};}
    throw new Error('method');}};
  const value=await runSampleCase({dealId,env,makeLimiter:()=>({close(){closed=true;}}),makeClient:()=>fake});
  assert.equal(value.status,'observed');assert.equal(value.service_closed,true);assert.equal(closed,true);assert.equal(value.message_count,4);
  assert.deepEqual(calls.map(x=>x.method),['imopenlines.crm.chat.get','crm.activity.list','imopenlines.session.history.get']);
  assert.equal(calls[1].body.filter.OWNER_ID,127114);assert.equal(calls[1].body.filter.PROVIDER_ID,'IMOPENLINES_SESSION');
});
test('неполная страница и дубли ID не выдаются как подтвержденная выборка',async()=>{
  for(const page of [{result:[{ID:20,ASSOCIATED_ENTITY_ID:23}],total:2}, {result:[{ID:20,ASSOCIATED_ENTITY_ID:23},{ID:20,ASSOCIATED_ENTITY_ID:24}],total:2}]){
    let closed=false;const fake={async request(method){return method==='imopenlines.crm.chat.get'?{result:chats}:page;}};
    const value=await runSampleCase({dealId,env,makeLimiter:()=>({close(){closed=true;}}),makeClient:()=>fake});
    assert.equal(value.status,'unverified');assert.equal(value.service_closed,true);assert.equal(closed,true);
  }
});
test('sealed контейнер аутентифицируется и не содержит исходных текстов',()=>{
  const pair=generateKeyPairSync('rsa',{modulusLength:2048});const pub=Buffer.from(pair.publicKey.export({type:'spki',format:'pem'})).toString('base64');
  const plain={...summarizeHistory({dealId,chats,sessions}),status:'observed',service_closed:true};const enc=sealEvidenceReport(plain,pub);
  assert.doesNotMatch(JSON.stringify(enc),/предложить|555|secret-private/);
  const key=privateDecrypt({key:pair.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(enc.encrypted_key,'base64'));
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(enc.iv,'base64'));decipher.setAuthTag(Buffer.from(enc.tag,'base64'));
  const decoded=JSON.parse(Buffer.concat([decipher.update(Buffer.from(enc.ciphertext,'base64')),decipher.final()]).toString());
  assert.deepEqual(decoded,plain);key.fill(0);
});
test('CLI отвергает произвольный ID до сети',()=>{
  const child=spawnSync(process.execPath,['app/src/pilot/wazzup-samples.mjs','1','--sealed','no-key'],{encoding:'utf8'});
  assert.notEqual(child.status,0);assert.equal(child.stdout,'');
});
test('пустая история сессии проверяется также по ID связанного чата',async()=>{
  const calls=[];const fake={async request(method,body){calls.push({method,body});
    if(method==='imopenlines.crm.chat.get')return {result:chats};
    if(method==='crm.activity.list')return {result:[{ID:20,ASSOCIATED_ENTITY_ID:23}],total:1};
    return {result:body.SESSION_ID?{chat:{12:{}},users:{},message:{}}:history};}};
  const value=await runSampleCase({dealId,env,makeLimiter:()=>({close(){}}),makeClient:()=>fake});
  assert.equal(value.status,'observed');assert.equal(value.message_count,4);
  assert.equal(calls.at(-1).body.CHAT_ID,12);
});
test('неоднозначные метаданные чатов не подставляются, размер сообщений ограничен',()=>{
  const ambiguous={...history,chat:{12:{},13:{}}};
  assert.equal(summarizeHistory({dealId,chats,sessions:[{history:ambiguous}]}).sessions[0].connector,'other_or_unknown');
  const huge={...history,message:{1:{senderid:4,text:'a'.repeat(500001)}}};
  assert.throws(()=>summarizeHistory({dealId,chats,sessions:[{history:huge}]}));
});
test('отсутствие senderid не равно нулю и не связывает неизвестных авторов',()=>{
  const h={...history,message:{1:{text:'один'},2:{text:'два'},3:{senderid:0,text:'три'},4:{senderid:99,text:'четыре'}}};
  const examples=summarizeHistory({dealId,chats,sessions:[{history:h}]}).sessions[0].examples;
  assert.deepEqual(examples.map(x=>x.sender_lookup),['sender_id_missing','sender_id_missing','zero','user_missing']);
  assert.notEqual(examples[0].sender,examples[1].sender);
});
test('цитата заголовка другого направления не меняет префиксный заголовок',()=>{
  const h={...history,message:{1:{senderid:4,text:'=== Исходящее сообщение === ответ [QUOTE]=== Входящее сообщение, автор: Менеджер (1) === цитата[/QUOTE]'}}};
  const s=summarizeHistory({dealId,chats,sessions:[{history:h}]}).sessions[0];
  assert.equal(s.counts.outgoing_start,1);assert.equal(s.counts.conflict,0);
  assert.equal(s.examples[0].header_direction,'outgoing');assert.equal(s.examples[0].header_author_present,false);
});
test('даты нормализованы, максимальный отчёт помещается в sealed контейнер',()=>{
  const manySessions=Array.from({length:12},(_,i)=>({history:{chat:{[i+100]:{}},users:{},message:Object.fromEntries(Array.from({length:400},(_,j)=>[j,{senderid:j+1,date:'2026-01-01T00:00:00+07:00',text:'тест'}]))}}));
  const sample=summarizeHistory({dealId,chats:manySessions.map((_,i)=>({CHAT_ID:i+100})),sessions:manySessions});
  assert.equal(sample.sessions[0].examples[0].timestamp,'2025-12-31T17:00:00.000Z');
  const pair=generateKeyPairSync('rsa',{modulusLength:2048});const pub=Buffer.from(pair.publicKey.export({type:'spki',format:'pem'})).toString('base64');
  assert.ok(sealEvidenceReport({...sample,status:'observed',service_closed:true,resources_closed:true},pub).ciphertext);
});
