import test from 'node:test';
import assert from 'node:assert/strict';
import {pollPilotRefusals} from '../../app/src/pilot/live-poll.mjs';

const cutoff='2026-11-12T00:00:00.000Z';
function fixture(){
 const jobs=new Map(), calls=[];
 const rows=[{ID:'1',STAGE_ID:'C23:LOSE'},{ID:'2',STAGE_ID:'C23:LOSE'}];
 const dates={1:'2026-11-11T23:00:00.000Z',2:'2026-11-12T01:00:00.000Z'};
 const bitrix={async request(method,body){calls.push(method);
  if(method==='crm.deal.list')return {result:rows,total:rows.length};
  if(method==='crm.deal.get')return {result:{ID:body.id,STAGE_ID:'C23:LOSE'}};
  if(method==='crm.stagehistory.list')return {result:{items:[{ID:String(body.filter.OWNER_ID+100),STAGE_ID:'C23:LOSE',CREATED_TIME:dates[body.filter.OWNER_ID]},{ID:'30',STAGE_ID:'C23:NEW',CREATED_TIME:'2026-11-10T00:00:00.000Z'}]},total:2};
  throw Error('неожиданный метод');
 }};
 const queue={async enqueue(job){const created=!jobs.has(job.requestKey);jobs.set(job.requestKey,job);return {created};}};
 return {bitrix,queue,jobs,rows,calls};
}
test('пилот выбирает только новые переходы и повторный проход не создаёт дубль',async()=>{
 const f=fixture();assert.deepEqual(await pollPilotRefusals({...f,enabledAt:cutoff}),{seen:2,queued:1});
 assert.deepEqual(await pollPilotRefusals({...f,enabledAt:cutoff}),{seen:2,queued:0});
 assert.deepEqual([...f.jobs.values()].map(x=>[x.dealId,x.triggerType,x.silent]),[[2,'live',false]]);
});
test('ошибочный список и неполная пагинация не выдаются за успешный проход',async()=>{
 const f=fixture();f.rows.push({ID:'2',STAGE_ID:'C23:LOSE'});
 await assert.rejects(pollPilotRefusals({...f,enabledAt:cutoff}),/страница/);
 const bitrix={async request(){return {result:[],total:2};}};
 await assert.rejects(pollPilotRefusals({bitrix,queue:f.queue,enabledAt:cutoff}),/полнота/);
});
