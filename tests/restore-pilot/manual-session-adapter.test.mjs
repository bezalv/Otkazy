import test from 'node:test';
import assert from 'node:assert/strict';
import { runManualSessionPilot } from '../../app/src/pilot/manual-session-adapter.mjs';

const cutoff='2026-11-04T12:00:00.000Z',from='2026-01-01T00:00:00.000Z';
function fixture(){
  const calls=[],counts={roles:0,judge:0,writer:0};let histories=0;
  const state={changedHistory:false,changedStage:false,lookupMismatch:false,audioCall:false};
  const h={chatId:100,sessionId:80,chat:{100:{entityId:'wazzup|71|client|external'}},users:{55:{connector:true}},files:{},message:{
    1:{id:1,senderid:55,date:'2026-11-04T10:00:00Z',text:'=== Исходящее сообщение ===\nМожем предложить вам замену окна.'},
    2:{id:2,senderid:55,date:'2026-11-04T10:01:00Z',text:'Нет, спасибо, мы уже заказали окна в другом месте.'}}};
  const bitrix={async request(method,body){calls.push({method,body});
    if(method==='crm.deal.userfield.list')return {result:[{LIST:[{ID:'1',VALUE:'Другая'}]}]};
    if(method==='crm.deal.get')return {result:{ID:'42',STAGE_ID:'C23:LOSE',ASSIGNED_BY_ID:'65',UF_CRM_1584703948317:'1'}};
    if(method==='crm.stagehistory.list')return {result:{items:[{ID:state.changedStage?'102':'101',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}]},total:1};
    if(method==='crm.activity.list'&&body.filter.PROVIDER_ID==='IMOPENLINES_SESSION')return {result:[]};
    if(method==='imopenlines.crm.chat.get')return {result:[{CHAT_ID:100,CONNECTOR_ID:'wazzup',CONNECTOR_TITLE:'wazzup'}]};
    if(method==='imopenlines.session.history.get'){
      histories++;const copy=structuredClone(h);if(state.changedHistory&&histories>1)copy.message[2].text='Изменено';return {result:copy};
    }
    if(method==='imopenlines.v2.Session.list')return {result:{sessions:[{id:80,chatId:100,configId:71,
      crmEntityType:'deal',crmEntityId:state.lookupMismatch?43:42,dateCreate:'2026-11-01T00:00:00.000Z'}],hasNextPage:false}};
    if(method==='crm.activity.list'&&body.filter.TYPE_ID===2&&state.audioCall)return {result:[{ID:'201',CREATED:'2026-11-04T09:00:00Z',
      START_TIME:'2026-11-04T09:00:00Z',END_TIME:'2026-11-04T09:01:00Z',SETTINGS:{RECORD_URL:'https://example.invalid/?fileId=99'}}]};
    if(method==='crm.activity.list'||method==='crm.timeline.comment.list')return {result:[]};
    if(method==='tasks.task.list')return {result:{tasks:[]}};
    throw new Error(`unexpected ${method}`);
  }};
  const llm={async complete(body,options={}){
    if(options.role==='chat-role-inference'){
      counts.roles++;const entries=JSON.parse(body.messages[1].content).messages;
      return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({roles:entries.map((entry,i)=>({id:entry.id,
        role:i?'client':'manager',impact:'not_applicable'}))})}}]};
    }
    if(options.role==='judge'){
      counts.judge++;
      return {choices:[{message:{content:JSON.stringify({verdict:'недостаточно_данных',verdict_reason_short:'Недостаточно',
        recoverable_level:null,closure_reason_class:'other',misplaced:false,correct_stage:null,exact_reason:'Недостаточно данных',
        manager_mistakes:[],key_signals:[],risk_factors:[],questions_for_manager:[]})}}]};
    }
    if(options.role==='writer'){counts.writer++;return {choices:[{message:{content:'Тестовый комментарий'}}]};}
    throw Error('unexpected');
  }};
  return {calls,counts,state,args:{dealId:42,expectedHistoryId:'101',expectedLoseDate:cutoff,from,maxPages:20,
    silent:true,semanticChatRoles:true,bitrix,llm,judgeSystemPrompt:'Промпт судьи',writerSystemPrompt:'Промпт писателя',
    nowMs:Date.parse('2026-11-05T00:00:00Z'),audioWaitEnabledAt:'2026-11-01T00:00:00Z',wait:async()=>{}}};
}

test('ручной адаптер связывает сессию с переходом и не выдаёт предварительный анализ за полный',async()=>{
  const {args,calls,counts}=fixture(),result=await runManualSessionPilot(args);
  assert.equal(counts.roles,1);assert.equal(counts.judge,1);
  assert.equal(result.preliminary.status,'processed');assert.equal(result.status,'unverified');
  assert.equal(result.history_complete,null);assert.equal(result.delivery_permitted,false);
  assert.equal(result.preliminary.dealData.communications.filter(x=>x.type==='chat')[0].message_id,'chat_100_1');
  assert.ok(calls.some(x=>x.method==='imopenlines.v2.Session.list'));
  assert.ok(calls.every(x=>!/(?:update|add|delete|send)/i.test(x.method)));
});

test('без тихого ручного режима и точного перехода обращения не выполняются',async()=>{
  for(const changes of [{silent:false},{semanticChatRoles:false},{expectedHistoryId:null},
    {expectedLoseDate:'2026-11-04T12:00:00.000001Z'},{from:'2024-01-01T00:00:00Z'},
    {maxPages:21},{dealId:0}]){
    const {args,calls}=fixture();await assert.rejects(runManualSessionPilot({...args,...changes}));assert.equal(calls.length,0);
  }
});

test('смена сделки, перехода, снимка или CRM-привязки не допускает вызов модели',async()=>{
  for(const change of [f=>f.args.dealId=43,f=>f.state.changedStage=true,f=>f.state.changedHistory=true,
    f=>f.state.lookupMismatch=true]){
    const f=fixture();change(f);const result=await runManualSessionPilot(f.args);
    assert.notEqual(result.preliminary.status,'processed');assert.equal(f.counts.roles,0);assert.equal(f.counts.judge,0);
    assert.equal(result.delivery_permitted,false);
  }
});

test('превышение окна поиска и отмена не дают обратиться к внешней системе',async()=>{
  const f=fixture(),abort=new AbortController();abort.abort();
  await assert.rejects(runManualSessionPilot({...f.args,signal:abort.signal}));assert.equal(f.calls.length,0);
  await assert.rejects(runManualSessionPilot({...f.args,from:'2025-01-01T00:00:00Z'}));assert.equal(f.calls.length,0);
});

test('внедрённые вызывающим адаптеры медиа игнорируются и запись звонка блокирует судью',async()=>{
  const f=fixture();f.state.audioCall=true;let media=0;
  const result=await runManualSessionPilot({...f.args,transcribe:async()=>{media++;},resolveFile:async()=>{media++;},
    downloadFile:async()=>{media++;},screenshots:true});
  assert.equal(media,0);assert.equal(result.preliminary.status,'blocked');assert.equal(f.counts.judge,0);
  assert.equal(result.delivery_permitted,false);
});
