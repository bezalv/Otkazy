import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDeal } from '../../app/src/collect/index.mjs';
import { scopeCollectionAtLose } from '../../app/src/collect/temporal-scope.mjs';
import { normalizeCommunications } from '../../app/src/collect/normalize.mjs';
import { attachVerifiedCallTiming, verifiedCallTiming } from '../../app/src/collect/call-timing.mjs';
import { prepareRawCollectionArtifact } from '../../app/src/persistence/prejudge.mjs';
import { processDeal } from '../../app/src/process-deal.mjs';

const cutoff = '2026-11-26T09:42:46Z';
const planned = { ID:'1692680', TYPE_ID:'2', OWNER_TYPE_ID:'2', OWNER_ID:'127674',
  PROVIDER_ID:'VOXIMPLANT_CALL', COMPLETED:'Y', CREATED:'2026-11-17T09:04:46+03:00',
  START_TIME:'2026-11-26T13:05:00+03:00', END_TIME:'2026-11-26T18:05:00+03:00',
  LAST_UPDATED:'2026-11-26T12:43:33+03:00', ORIGIN_ID:'VI_externalCall.test',
  FILES:[{id:1723708,url:'https://example.test/audio?secret=hidden'}] };
// Фактическое время здесь — мок, а не утверждение о статистике живого звонка.
const statistic = { ID:'901', CRM_ACTIVITY_ID:'1692680', CALL_ID:'externalCall.test',
  CALL_START_DATE:'2026-11-26T12:39:58+03:00', CALL_DURATION:'150', RECORD_FILE_ID:'1723708' };
function fixture({ calls=[planned], stats=[statistic], override }={}) {
  const requests=[];
  const client={async request(method,body){
    requests.push({method,body});const result=await override?.(method,body);if(result!==undefined)return result;
    switch(method){
      case 'crm.deal.get':return {result:{ID:'127674',STAGE_ID:'C23:LOSE',ASSIGNED_BY_ID:'65'}};
      case 'crm.deal.userfield.list':return {result:[{LIST:[]}]};
      case 'crm.stagehistory.list':return {result:{items:[{ID:'478508',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}]}};
      case 'crm.activity.list':return {result:body.filter.TYPE_ID===2?calls:[]};
      case 'voximplant.statistic.get':return {result:stats};
      case 'crm.timeline.comment.list':case 'imopenlines.crm.chat.get':return {result:[]};
      case 'tasks.task.list':return {result:{tasks:[]}};
      default:throw Error('Unexpected '+method);
    }
  }};
  return {client,requests,run:()=>collectDeal({client,dealId:127674,now:Date.parse('2026-11-27T00:00:00Z'),
    wait:async()=>{},requireCurrentHistory:true})};
}
test('1692680: фактический разговор сохраняет файл, дату и длительность вместо планового окна',async()=>{
  const f=fixture(),c=await f.run();assert.equal(c._status,'pending_normalization');
  assert.equal(c._sources.calls.timing_verified,1);
  assert.deepEqual(f.requests.find(r=>r.method==='voximplant.statistic.get').body.FILTER,{CRM_ACTIVITY_ID:1692680});
  const scoped=scopeCollectionAtLose(c);assert.equal(scoped.error,undefined);assert.equal(scoped.excluded.calls,0);
  const normalized=await normalizeCommunications({collection:scoped.collection,temporalCutoff:cutoff});
  const event=normalized.deal_data.communications[0];assert.equal(event.type,'call');assert.equal(event._needs_transcription,true);
  assert.equal(event.date,'2026-11-26T09:39:58.000Z');
  assert.equal((Date.parse(event.duration_end)-Date.parse(event.duration_start))/1000,150);
  assert.equal(event.audio_files.length,1);assert.equal(c.raw.calls[0].START_TIME,planned.START_TIME);
  const artifact=prepareRawCollectionArtifact(scoped.collection,{unscopedCalls:c.raw.calls});
  assert.equal(artifact.payload.calls_before_temporal_scope[0].actual_timing.source,'voximplant.statistic.get');
  assert.deepEqual(artifact.payload.calls[0].file_ids,[1723708]);
  assert.ok(!JSON.stringify(artifact).includes('secret=hidden'));
});
test('без статистики запись не превращается в пустой план и не попадает судье',async()=>{
  const f=fixture({override(method){if(method==='voximplant.statistic.get')throw Object.assign(Error('insufficient_scope'),{status:401});}});
  const c=await f.run();assert.equal(c._sources.calls.complete,false);assert.match(c._error,/1692680/);
  assert.equal(c.raw.calls[0].FILES[0].id,1723708);assert.equal(c._sources.calls.timing_errors[0].error,'HTTP 401');
  assert.equal(scopeCollectionAtLose(c).error.source,'calls');
  const artifacts=[];const result=await processDeal({dealId:127674,bitrix:f.client,wait:async()=>{},
    nowMs:Date.parse('2026-11-27T00:00:00Z'),expectedHistoryId:'478508',expectedLoseDate:cutoff,
    judgeSystemPrompt:'test',prejudgeCheckLease:async()=>{},
    prejudgeCheckpoint:async({artifact})=>{artifacts.push(artifact);return {saved:true};},
    transcribe:async()=>assert.fail('STT запрещён без времени'),llm:{complete:async()=>assert.fail('Судья запрещён')}});
  assert.equal(result.status,'error');assert.equal(artifacts.length,1);
  assert.equal(artifacts[0].payload.stage,'call_timing_blocked');assert.equal(artifacts[0].payload.calls[0].has_recording,true);
});
test('чужая статистика, другой файл, дубли и некорректные даты не подтверждают звонок',async()=>{
  for(const rows of [[],[statistic,statistic],[{...statistic,CRM_ACTIVITY_ID:'7'}],
    [{...statistic,CALL_ID:'different'}],[{...statistic,RECORD_FILE_ID:'9'}],
    [{...statistic,CALL_DURATION:null}],[{...statistic,CALL_DURATION:'0'}],
    [{...statistic,CALL_START_DATE:'2026-11-26T09:00:00'}]]){
    assert.throws(()=>attachVerifiedCallTiming(planned,rows));
    assert.equal((await fixture({stats:rows}).run())._sources.calls.complete,false);
  }
});
test('статистика читается постранично; старый звонок повторно используемой активности не подменяет текущий',async()=>{
  const f=fixture({override(method,body){if(method==='voximplant.statistic.get')return body.start===0
    ? {result:[{...statistic,CALL_ID:'old',RECORD_FILE_ID:'8'}],next:50}:{result:[statistic]};}});
  const c=await f.run();assert.equal(c._sources.calls.complete,true);
  assert.equal(f.requests.filter(r=>r.method==='voximplant.statistic.get').length,2);
});
test('подтверждённая запись после отказа исключается целиком, пересекающая отказ блокируется',()=>{
  for(const [start,duration,expected] of [['2026-11-26T09:43:00Z','10','excluded'],['2026-11-26T09:42:00Z','60','blocked']]){
    const call=attachVerifiedCallTiming(planned,[{...statistic,CALL_START_DATE:start,CALL_DURATION:duration}]);
    const c={deal_data:{lose_date:cutoff},raw:{calls:[call],comments:[],tasks:[],sessions:[]}};
    const scoped=scopeCollectionAtLose(c);
    if(expected==='excluded'){assert.equal(scoped.collection.raw.calls.length,0);assert.equal(scoped.excluded.calls,1);}
    else assert.match(scoped.error.reason,/пересекает/);
  }
});
test('поддельные или перенесённые на другой звонок метаданные не обходят проверку',()=>{
  const call=attachVerifiedCallTiming(planned,[statistic]);
  assert.ok(verifiedCallTiming({...call}));assert.equal(verifiedCallTiming(structuredClone(call)),null);
  assert.equal(verifiedCallTiming({...call,ID:'9'}),null);
  assert.equal(verifiedCallTiming({...call,FILES:[{id:9}]}),null);
  assert.throws(()=>attachVerifiedCallTiming({...planned,ORIGIN_ID:null},[{...statistic,RECORD_FILE_ID:0}]));
  assert.ok(verifiedCallTiming(attachVerifiedCallTiming({...planned,ORIGIN_ID:null},[statistic])));
});
test('обычные записи не требуют дополнительных запросов статистики',async()=>{
  const call={...planned,CREATED:statistic.CALL_START_DATE,START_TIME:statistic.CALL_START_DATE,END_TIME:'2026-11-26T12:42:28+03:00'};
  const f=fixture({calls:[call]}),c=await f.run();assert.equal(c._sources.calls.complete,true);
  assert.equal(f.requests.some(r=>r.method==='voximplant.statistic.get'),false);
});
