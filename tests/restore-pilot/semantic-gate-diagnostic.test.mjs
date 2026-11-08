import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEligibility, summarizeHistoryIds, transitionMatches, runDiagnostic } from '../../app/src/pilot/semantic-gate-diagnostic.mjs';
import { inferChatRoles } from '../../app/src/analysis/chat-role-inference.mjs';

const cutoff='2026-10-29T00:00:00Z';
const base=(n=1)=>({type:'chat',chat_id:'101',session_id:'202',message_id:`202_${n}`,connector_id:'wazzup',
  date:`2026-10-28T10:0${n}:00Z`,text:`PRIVATE_${n}`,role:'unknown',direction:'unknown',_wazzup_author_ambiguous:true});

test('сводка совпадает с вызовами настоящего классификатора и не содержит исходные данные',async()=>{
  const input=[base(1),base(2)];let calls=0;
  const summary=summarizeEligibility(input,cutoff);
  const actual=await inferChatRoles({communications:input,cutoff,client:{async complete(){calls++;throw new Error('no network');}}});
  assert.equal(summary.expected_mock_calls,calls);assert.equal(calls,1);assert.equal(actual.stats.failed_sessions,1);
  assert.doesNotMatch(JSON.stringify(summary),/PRIVATE_|101|202|wazzup/i);
});
test('синтетическая сессия, неизвестный чат и поздние сообщения не выдаются за проверенные',async()=>{
  const synthetic={...base(1),session_id:'chat_101'};
  const unknown={...base(2),chat_id:null};
  const late={...base(3),date:'2026-10-29T01:00:00Z'};
  const input=[synthetic,unknown,late];let calls=0;
  const summary=summarizeEligibility(input,cutoff);
  await inferChatRoles({communications:input,cutoff,client:{async complete(){calls++;throw new Error('offline');}}});
  assert.equal(summary.reasons.synthetic_session_id,1);assert.equal(summary.reasons.invalid_chat_id,1);
  assert.equal(summary.reasons.after_cutoff_ambiguous,1);assert.equal(summary.expected_mock_calls,calls);
});
test('время кандидатов синтетической сессии учитывается отдельно и не раскрывается',()=>{
  const input=[{...base(1),session_id:'chat_101',date:'2026-10-28'},
    {...base(2),session_id:'chat_101',date:'2026-10-29T01:00:00Z'}];
  const summary=summarizeEligibility(input,cutoff);
  assert.equal(summary.ungrouped_time_evaluated,true);assert.equal(summary.reasons.ungrouped_invalid_timestamp,1);
  assert.equal(summary.reasons.ungrouped_after_cutoff_ambiguous,1);
  assert.equal(summarizeEligibility(input,'invalid').ungrouped_time_evaluated,false);
});
test('вложения, неопределённые даты, дубли, конфликты и чрезмерные размеры не пропускаются',async()=>{
  for(const [kind,change,reason] of [
    ['attachment',x=>({...x,_has_files:true}),'attachment'],
    ['date',x=>({...x,date:'2026-10-28'}),'invalid_timestamp'],
    ['duplicate',x=>({...x,message_id:'202_1'}),'duplicate_message_id'],
    ['time',x=>({...x,date:'2026-10-28T10:01:00Z'}),'duplicate_timestamp'],
    ['role',x=>({...x,role:'Менеджер',direction:'incoming'}),'role_conflict'],
    ['large',x=>({...x,text:'X'.repeat(5001)}),'long_message'],
  ]){
    const input=[base(1),change(base(2))];let calls=0;
    const summary=summarizeEligibility(input,cutoff);
    await inferChatRoles({communications:input,cutoff,client:{async complete(){calls++;throw new Error('offline');}}});
    assert.ok(summary.reasons[reason]>0,kind);assert.equal(summary.expected_mock_calls,calls,kind);assert.equal(calls,0,kind);
  }
});
test('невалидная дата отказа и недопустимые входные данные отклоняются',()=>{
  const summary=summarizeEligibility([base(1)],'2026-10-29');
  assert.equal(summary.reasons.invalid_cutoff,1);assert.equal(summary.expected_mock_calls,0);
  assert.throws(()=>summarizeEligibility(null,cutoff));
});
test('диагностика допускает только тот же подтверждённый переход в отказ',()=>{
  assert.equal(transitionMatches('2026-10-29T00:00:00Z','2026-10-29T07:00:00+07:00'),true);
  for(const actual of [null,'','bad','2026-10-28T23:59:59Z','2026-10-29T00:00:01Z'])
    assert.equal(transitionMatches('2026-10-29T00:00:00Z',actual),false);
  for(const expected of [null,'','bad'])assert.equal(transitionMatches(expected,'2026-10-29T00:00:00Z'),false);
});
test('при другом или некорректном переходе не выдаётся диагностическая сводка',async()=>{
  const bitrix={async request(method){
    if(method==='crm.deal.userfield.list')return {result:[{LIST:[{ID:'1',VALUE:'Другая'}]}]};
    if(method==='crm.deal.get')return {result:{ID:'127114',STAGE_ID:'C23:LOSE',ASSIGNED_BY_ID:'65',UF_CRM_1584703948317:'1'}};
    if(method==='crm.stagehistory.list')return {result:{items:[{ID:'101',STAGE_ID:'C23:LOSE',CREATED_TIME:'2026-10-29T00:00:00Z'}]}};
    if(method==='imopenlines.crm.chat.get'||method==='crm.activity.list'||method==='crm.timeline.comment.list')return {result:[]};
    if(method==='tasks.task.list')return {result:{tasks:[]}};
    throw new Error('unexpected');
  }};
  for(const expected of ['2026-10-28T23:59:59Z','2026-10-29T00:00:01Z','invalid',null]){
    const result=await runDiagnostic({caseRunner:async({processFn})=>{
      const outcome=await processFn({dealId:127114,bitrix,silent:true,expectedLoseDate:expected,
        expectedHistoryId:null,audioWaitEnabledAt:'2026-10-01T00:00:00Z',savedAudioWait:null,wait:async()=>{}});
      assert.equal(outcome.status,'unverified');return {status:'unverified',deal_id:'127114',analysis_id:'1968',service_closed:true};
    }});
    assert.deepEqual(result,{status:'unverified',deal_id:'127114',service_closed:true});
  }
});
test('идентификаторы history проверяются только по наличию и совпадению, без раскрытия',()=>{
  const data=[{chat_id:101,history:{sessionId:202,chatId:101}},{chat_id:102,history:{sessionId:203,chatId:999}},
    {session_id:555,history:{sessionId:555}},{session_id:556,history:{sessionId:999}},{history:{sessionId:777}}];
  const s=summarizeHistoryIds(data);
  assert.equal(s.fallback_sessions,2);assert.equal(s.fallback_session_id_available,2);
  assert.equal(s.fallback_chat_id_matches,1);assert.equal(s.fallback_both_available_and_chat_matches,1);
  assert.equal(s.session_queries,2);assert.equal(s.session_returned_id_matches,1);assert.equal(s.unknown_source,1);
  assert.doesNotMatch(JSON.stringify(s),/101|202|999|555|777/);
  assert.throws(()=>summarizeHistoryIds(null));
});
test('обёртка не допускает чужую сделку и неподтверждённое закрытие',async()=>{
  await assert.rejects(runDiagnostic({caseRunner:async()=>({service_closed:false})}),/Завершение/);
  await assert.rejects(runDiagnostic({caseRunner:async({processFn})=>processFn({dealId:12,silent:true})}),/Границы/);
});
test('сбор и нормализация fallback-чата сравниваются с реальным классификатором без модели и медиа',async()=>{
  const methods=[];
  const bitrix={async request(method,body){
    methods.push(method);
    if(method==='crm.deal.userfield.list')return {result:[{LIST:[{ID:'1',VALUE:'Другая'}]}]};
    if(method==='crm.deal.get')return {result:{ID:'127114',STAGE_ID:'C23:LOSE',ASSIGNED_BY_ID:'65',UF_CRM_1584703948317:'1'}};
    if(method==='crm.stagehistory.list')return {result:{items:[{ID:'101',STAGE_ID:'C23:LOSE',CREATED_TIME:'2026-10-29T00:00:00Z'}]}};
    if(method==='imopenlines.crm.chat.get')return {result:[{CHAT_ID:100,CONNECTOR_ID:'wazzup',CONNECTOR_TITLE:'Wazzup'}]};
    if(method==='imopenlines.session.history.get')return {result:{sessionId:80,chatId:100,chat:{100:{}},users:{55:{connector:true}},
      message:{1:{id:1,senderid:55,date:'2026-10-28T10:00:00Z',text:'PRIVATE_РЕПЛИКА'}},files:{}}};
    if(method==='crm.activity.list'||method==='crm.timeline.comment.list')return {result:[]};
    if(method==='tasks.task.list')return {result:{tasks:[]}};
    throw new Error('unexpected');
  }};
  const runner=(reportStatus='blocked')=>async({dealId,analysisId,processFn})=>{
    assert.equal(dealId,'127114');assert.equal(analysisId,'1968');
    const outcome=await processFn({dealId:127114,bitrix,silent:true,expectedLoseDate:'2026-10-29T00:00:00Z',
      expectedHistoryId:null,audioWaitEnabledAt:'2026-10-01T00:00:00Z',savedAudioWait:null,wait:async()=>{}});
    assert.equal(outcome.status,'blocked');return {status:reportStatus,deal_id:'127114',analysis_id:'1968',service_closed:true};
  };
  const result=await runDiagnostic({caseRunner:runner()});
  assert.equal(result.status,'diagnosed');assert.equal(result.summary.reasons.synthetic_session_id,1);
  assert.equal(result.history_identifiers.fallback_both_available_and_chat_matches,1);
  assert.equal(result.mock_calls,0);assert.equal(result.mock_call_count_matches,true);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_РЕПЛИКА/);
  assert.ok(!methods.some(m=>/disk|add|update|delete/i.test(m)));
  assert.deepEqual(await runDiagnostic({caseRunner:runner('error')}),{status:'unverified',deal_id:'127114',service_closed:true});
});

test('настоящий адаптер cohort сохраняет только агрегаты и не вызывает модель',async()=>{
  let forbidden=0;
  const bitrix={async request(method){
    if(method==='crm.deal.userfield.list')return {result:[{LIST:[{ID:'1',VALUE:'Другая'}]}]};
    if(method==='crm.deal.get')return {result:{ID:'127114',STAGE_ID:'C23:LOSE',ASSIGNED_BY_ID:'65',UF_CRM_1584703948317:'1'}};
    if(method==='crm.stagehistory.list')return {result:{items:[{ID:'101',STAGE_ID:'C23:LOSE',CREATED_TIME:'2026-10-29T00:00:00Z'}]}};
    if(method==='imopenlines.crm.chat.get')return {result:[{CHAT_ID:100,CONNECTOR_ID:'wazzup',CONNECTOR_TITLE:'Wazzup'}]};
    if(method==='imopenlines.session.history.get')return {result:{sessionId:80,chatId:100,chat:{100:{}},users:{55:{connector:true}},
      message:{1:{id:1,senderid:55,date:'2026-10-28T10:00:00Z',text:'PRIVATE_РЕПЛИКА'}},files:{}}};
    if(method==='crm.activity.list'||method==='crm.timeline.comment.list')return {result:[]};
    if(method==='tasks.task.list')return {result:{tasks:[]}};
    throw new Error('unexpected');
  }};
  const result=await runDiagnostic({env:{},pilotCommand:async({makeRunner})=>{
    const runner=makeRunner({bitrix,llm:{async complete(){forbidden++;}},transcribe:async()=>{forbidden++;},
      downloadFile:async()=>{forbidden++;},judgeSystemPrompt:'Тест',writerSystemPrompt:'Тест'});
    const outcome=await runner.run({dealId:127114,baseline:{deal_id:127114,analysis_id:'1968',
      lose_date:'2026-10-29T00:00:00Z',audio_wait_enabled_at:'2026-10-01T00:00:00Z'},screenshots:true});
    assert.equal(outcome.status,'blocked');return {selected:1,attempted:1,statuses:{blocked:1},service_closed:true};
  }});
  assert.equal(result.status,'diagnosed');assert.equal(result.mock_calls,0);assert.equal(result.mock_call_count_matches,true);
  assert.equal(result.history_identifiers.fallback_both_available_and_chat_matches,1);assert.equal(forbidden,0);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_РЕПЛИКА/);
});
