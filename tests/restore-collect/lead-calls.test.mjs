import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectDeal} from '../../app/src/collect/index.mjs';
import {scopeCollectionAtLose} from '../../app/src/collect/temporal-scope.mjs';
import {normalizeCommunications} from '../../app/src/collect/normalize.mjs';
import {assembleFacts} from '../../app/src/analysis/facts-assembler.mjs';
const now=Date.parse('2026-11-25T00:00:00Z'),cutoff='2026-11-20T06:50:06Z';
const leadCall={ID:'1689734',TYPE_ID:'2',OWNER_TYPE_ID:'1',OWNER_ID:'320282',COMPLETED:'Y',PROVIDER_ID:'VOXIMPLANT_CALL',
 CREATED:'2026-11-16T06:26:39+03:00',START_TIME:'2026-11-16T06:26:39+03:00',END_TIME:'2026-11-16T06:30:12+03:00',FILES:[{id:1710338,url:'https://example.test/record'}]};
function fixture({lead='320282',primary=[],calls=[leadCall],bindings=[{entityTypeId:1,entityId:320282},{entityTypeId:2,entityId:127888}],override}={}){
 const requests=[];
 const client={async request(method,body){requests.push({method,body});const x=await override?.(method,body);if(x!==undefined)return x;
 switch(method){
 case 'crm.deal.get':return {result:{ID:'127888',STAGE_ID:'C23:LOSE',LEAD_ID:lead,ASSIGNED_BY_ID:'65'}};
 case 'crm.deal.userfield.list':return {result:[{LIST:[]}]};
 case 'crm.stagehistory.list':return {result:{items:[{ID:'477450',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}]}};
 case 'crm.activity.list':return {result:body.filter.TYPE_ID===2?(body.filter.OWNER_TYPE_ID===1?calls:primary):[]};
 case 'crm.activity.binding.list':return {result:bindings};
 case 'crm.timeline.comment.list':case 'imopenlines.crm.chat.get':return {result:[]};
 case 'tasks.task.list':return {result:{tasks:[]}};
 default:throw Error('Unexpected '+method);
 }}};
 return {requests,run:()=>collectDeal({client,dealId:127888,now,wait:async()=>{},requireCurrentHistory:true})};
}
test('127888: связанный звонок исходного лида с файлом попадает в распознавание',async()=>{
 const f=fixture(),c=await f.run();assert.equal(c._sources.calls.complete,true);assert.equal(c._sources.calls.lead_calls_added,1);
 assert.equal(c.raw.calls[0]._verified_deal_binding,'127888');assert.equal(c.raw.calls[0]._source_lead_id,'320282');
 const scoped=scopeCollectionAtLose(c);assert.equal(scoped.error,undefined);
 const n=await normalizeCommunications({collection:scoped.collection,temporalCutoff:cutoff});
 const event=n.deal_data.communications[0];assert.equal(event.activity_id,'1689734');assert.equal(event._needs_transcription,true);
 assert.equal((Date.parse(event.duration_end)-Date.parse(event.duration_start))/1000,213);
 assert.equal(f.requests.filter(x=>x.method==='crm.activity.binding.list').length,1);
});
test('общий контакт и другая сделка не подтверждают принадлежность звонка',async()=>{
 for(const bindings of [[],[{entityTypeId:3,entityId:127888}],[{entityTypeId:2,entityId:127889}]]){
  const c=await fixture({bindings}).run();assert.equal(c._sources.calls.complete,true);assert.equal(c.raw.calls.length,0);assert.equal(c._sources.calls.lead_calls_unbound,1);
 }
});
test('ошибка или повреждённые привязки не объявляют сбор полным',async()=>{
 for(const bindings of [null,[{}],[{entityTypeId:2,entityId:'invalid'}]]){
  const c=await fixture({bindings}).run();assert.equal(c._sources.calls.complete,false);assert.equal(c._status,'error');
 }
 const c=await fixture({override(method){if(method==='crm.activity.binding.list')throw Error('unavailable');}}).run();
 assert.equal(c._sources.calls.complete,false);
});
test('страницы лида и привязок читаются полностью, повтор ID не дублирует звонок',async()=>{
 const c=await fixture({override(method,body){
  if(method==='crm.activity.list'&&body.filter.OWNER_TYPE_ID===1)return body.start===0?{result:[leadCall],next:50}:{result:[leadCall]};
  if(method==='crm.activity.binding.list')return body.start===0?{result:[{entityTypeId:1,entityId:320282}],next:50}:{result:[{entityTypeId:2,entityId:127888}]};
 }}).run();assert.equal(c._sources.calls.complete,true);assert.equal(c.raw.calls.length,1);
});
test('одна активность из двух выборок сохраняется один раз',async()=>{
 const f=fixture({primary:[leadCall]});const c=await f.run();assert.equal(c.raw.calls.length,1);
 assert.equal(f.requests.some(x=>x.method==='crm.activity.binding.list'),false);
});
test('при отсутствии лида дополнительных запросов нет',async()=>{
 for(const lead of [null,'0']){const f=fixture({lead}),c=await f.run();
  assert.equal(c.raw.calls.length,0);assert.equal(f.requests.some(x=>x.body?.filter?.OWNER_TYPE_ID===1),false);
 }
});
test('некорректный лид или владелец активности блокирует неполный сбор',async()=>{
 assert.equal((await fixture({lead:'bad'}).run())._sources.calls.complete,false);
 assert.equal((await fixture({calls:[{...leadCall,OWNER_ID:'999'}]}).run())._sources.calls.complete,false);
});
test('поздний звонок лида не попадает в исторический разбор',async()=>{
 const c=await fixture({calls:[{...leadCall,CREATED:'2026-11-21T10:00:00Z',START_TIME:'2026-11-21T10:00:00Z',END_TIME:'2026-11-21T10:01:00Z'}]}).run();
 const scoped=scopeCollectionAtLose(c);assert.equal(scoped.collection.raw.calls.length,0);assert.equal(scoped.excluded.calls,1);
});
test('короткое событие без записи остаётся неизвестным; короткая запись распознаётся',async()=>{
 const short={...leadCall,ID:'1697414',FILES:[],END_TIME:'2026-11-16T06:26:43+03:00'};
 const c=await fixture({primary:[short],calls:[]}).run();
 const n=await normalizeCommunications({collection:c,temporalCutoff:cutoff});
 const event=n.deal_data.communications[0];
 assert.equal(event._recording_wait_exempt_reason,'short_unrecorded_content_unknown');
 const facts=assembleFacts(n.deal_data,'test').facts_packet.facts;
 assert.equal(facts.length,1);assert.equal(facts[0].actor,'system');assert.match(facts[0].content,/содержание неизвестно/);
 const recorded=await fixture({primary:[{...short,FILES:leadCall.FILES}],calls:[]}).run();
 const n2=await normalizeCommunications({collection:recorded,temporalCutoff:cutoff});
 assert.equal(n2.deal_data.communications[0]._needs_transcription,true);
 assert.equal(n2.deal_data.communications[0]._recording_wait_exempt_reason,null);
});
