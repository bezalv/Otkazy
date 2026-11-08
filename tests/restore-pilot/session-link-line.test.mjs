import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSession, historiesMatch, restrictedReader, runSessionDiagnostic } from '../../app/src/pilot/session-link-line.mjs';
import { runPilotCommand } from '../../app/src/pilot/command.mjs';

const LOSE='2026-10-28T05:35:03.000Z';
const message=()=>({ '12':{id:'12',senderid:'34',date:'2026-10-27T04:00:00Z',text:'PRIVATE_CONTENT',params:{FILE_ID:[]}} });
const history=()=>({sessionId:80,chatId:100,chat:{'100':{entityId:'wazzup|71|chat1|user1'}},message:message()});
const record=()=>({id:80,chatId:100,configId:71,crmEntityType:'DEAL',crmEntityId:127114,
  dateCreate:'2026-10-27T00:00:00Z',dateClose:'2026-10-29T00:00:00Z'});
function fixture({pages,recordValue=record(),historyMutate,stageDate=LOSE,chatList,throwMethod}={}) {
  const calls=[]; let historyCalls=0;
  const client={async request(method,body){
    calls.push({method,body});if(method===throwMethod)throw new Error('PRIVATE_SECRET');
    if(method==='crm.deal.get')return {result:{ID:'127114',STAGE_ID:'C23:LOSE'}};
    if(method==='crm.stagehistory.list')return {result:{items:[{ID:101,STAGE_ID:'C23:LOSE',CREATED_TIME:stageDate}]}};
    if(method==='imopenlines.crm.chat.get')return {result:chatList??[{CHAT_ID:100,CONNECTOR_ID:'wazzup'}]};
    if(method==='imopenlines.session.history.get'){
      historyCalls++; const value=history();if(historyMutate)historyMutate(value,historyCalls);return {result:value};
    }
    if(method==='imopenlines.v2.Session.list'){
      const page=pages?pages[body.offset/200]:{sessions:[recordValue],hasNextPage:false};
      if(!page)throw new Error('unexpected');return {result:page};
    }
    throw new Error('unexpected method');
  }};
  return {client,calls};
}

test('подтверждает связь только после полного bounded поиска и двойной сверки истории',async()=>{
  const {client,calls}=fixture();const r=await inspectSession({client,loseDate:LOSE});
  assert.equal(r.status,'verified');assert.equal(r.stage,'session_link_verified');assert.equal(r.session_crm,'matches');
  assert.equal(r.current_chat_bound,true);assert.equal(r.history_identifiers_match,true);assert.equal(r.history_recheck_match,true);
  assert.equal(r.session_created_before_lose,true);assert.equal(r.session_close_after_lose,true);assert.equal(r.pagination_exhausted,true);
  assert.equal(calls.filter(x=>x.method==='imopenlines.session.history.get').length,3);
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE|"80"|"100"/);
  assert.ok(!calls.some(x=>/add|update|delete|send|read\b|disk/i.test(x.method)));
});

test('неполная пагинация и повтор ID не подтверждают связь',async()=>{
  const emptyRows=Array.from({length:200},(_,i)=>({id:1000+i}));
  const pages=Array.from({length:20},(_,i)=>({sessions:i===0?[record(),...emptyRows.slice(1)]:emptyRows,hasNextPage:true}));
  const incomplete=await inspectSession({client:fixture({pages}).client,loseDate:LOSE});
  assert.equal(incomplete.status,'unverified');assert.equal(incomplete.stage,'pagination_incomplete');assert.equal(incomplete.session_pages,20);
  assert.equal(incomplete.session_crm,'matches');assert.equal(incomplete.session_chat_matches,true);
  assert.equal(incomplete.session_line_matches,true);assert.equal(incomplete.session_created_before_lose,true);
  const duplicated=await inspectSession({client:fixture({pages:[{sessions:[record(),...emptyRows.slice(1)],hasNextPage:true},
    {sessions:[record()],hasNextPage:false}]}).client,loseDate:LOSE});
  assert.equal(duplicated.status,'unverified');assert.equal(duplicated.stage,'session_duplicate');
});

test('отсутствие, другой чат, CRM-права и дата fail closed',async()=>{
  for(const [change,stage] of [
    [{recordValue:{...record(),id:99}},'session_not_found'],
    [{recordValue:{...record(),chatId:101}},'session_chat_mismatch'],
    [{recordValue:{...record(),configId:72}},'session_line_mismatch'],
    [{recordValue:{...record(),crmEntityId:null}},'crm_unverified'],
    [{recordValue:{...record(),crmEntityId:999}},'crm_unverified'],
    [{recordValue:{...record(),dateCreate:'2026-02-31T00:00:00Z'}},'session_time_unverified'],
    [{recordValue:{...record(),dateCreate:'2026-10-29T00:00:00Z'}},'session_time_unverified'],
    [{throwMethod:'imopenlines.v2.Session.list'},'request_unavailable'],
    [{stageDate:'2026-10-28T05:35:04.000Z'},'transition_unverified'],
    [{chatList:[{CHAT_ID:100,CONNECTOR_ID:'wazzup'},{CHAT_ID:101,CONNECTOR_ID:'wappi'}]},'chat_unverified'],
  ]){
    const result=await inspectSession({client:fixture(change).client,loseDate:LOSE});
    assert.equal(result.status,'unverified',stage);assert.equal(result.stage,stage);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SECRET|PRIVATE_CONTENT/);
  }
  assert.equal((await inspectSession({client:fixture().client,loseDate:'invalid'})).stage,'invalid_cutoff');
});

test('смена сессии или содержимого истории не подтверждает совпадение',async()=>{
  for(const mutation of [(h,n)=>{if(n===2)h.sessionId=81;},(h,n)=>{if(n===3)h.message['12'].text='OTHER';}]){
    const result=await inspectSession({client:fixture({historyMutate:mutation}).client,loseDate:LOSE});
    assert.equal(result.status,'unverified');assert.equal(result.stage,'history_recheck_unverified');
  }
  assert.equal(historiesMatch(history(),history(),100,80),true);
  assert.equal(historiesMatch(history(),history(),101,80),false);
});

test('configId получают только из корректного entityId и повторно сверяют линию',async()=>{
  const good=fixture();const result=await inspectSession({client:good.client,loseDate:LOSE});
  assert.equal(result.line_identifiers_match,true);assert.equal(result.session_line_matches,true);
  const list=good.calls.filter(c=>c.method==='imopenlines.v2.Session.list');
  assert.equal(list.length,1);assert.equal(list[0].body.configId,71);
  for(const entity of [undefined,'wazzup|71|chat1','wazzup|71|chat1|user1|extra','wazzup|071|chat1|user1',
    'wazzup|0|chat1|user1','wazzup|NaN|chat1|user1','wazzup|71||user1','wazzup |71|chat1|user1']){
    const f=fixture({historyMutate:(h,n)=>{if(n===1)h.chat['100'].entityId=entity;}});
    const bad=await inspectSession({client:f.client,loseDate:LOSE});
    assert.equal(bad.status,'unverified');assert.equal(bad.stage,'line_unverified');
    assert.ok(!f.calls.some(c=>c.method==='imopenlines.v2.Session.list'));
  }
  for(const num of [2,3]){
    const bad=await inspectSession({client:fixture({historyMutate:(h,n)=>{if(n===num)h.chat['100'].entityId='wazzup|72|chat1|user1';}}).client,loseDate:LOSE});
    assert.equal(bad.status,'unverified');assert.equal(bad.stage,'line_unverified');assert.equal(bad.line_identifiers_match,false);
  }
});

test('сохраняет сигналы найденной записи при неполной выдаче и ошибке прав',async()=>{
  for(const broken of ['pagination','rights']){
    const rows=[record(),...Array.from({length:199},(_,i)=>({id:1000+i}))];
    const base=fixture({pages:[{sessions:rows,hasNextPage:true}]});
    const client={async request(method,body){
      if(method==='imopenlines.v2.Session.list'&&body.offset>0){
        if(broken==='rights')throw new Error('ACCESS_DENIED');
        return {result:{sessions:Array.from({length:200},(_,i)=>({id:1000+i})),hasNextPage:true}};
      }
      return base.client.request(method,body);
    }};
    const result=await inspectSession({client,loseDate:LOSE});
    assert.equal(result.status,'unverified');
    assert.equal(result.stage,broken==='rights'?'request_unavailable':'pagination_incomplete');
    assert.equal(result.session_crm,'matches');assert.equal(result.session_chat_matches,true);
    assert.equal(result.session_line_matches,true);assert.equal(result.session_created_before_lose,true);
    assert.ok(result.limitations.includes('line_may_have_changed'));
  }
});

test('сверяет все поля автора, users и files, различая отсутствие и ноль',async()=>{
  const variants=[
    h=>{h.message['12'].author_id=34;},
    h=>{h.message['12'].AUTHOR_ID=34;},
    h=>{h.message['12'].SENDER_ID=34;},
    h=>{h.message['12'].senderid=0;},
    h=>{delete h.message['12'].senderid;},
    h=>{h.users={'34':{name:'private'}};},
    h=>{h.files={'19':{name:'private'}};},
    h=>{h.message['12'].params.FILE_ID=['19'];},
    h=>{h.message['12'].invalid=undefined;},
  ];
  for(const mutate of variants){
    const altered=history();mutate(altered);
    assert.equal(historiesMatch(history(),altered,100,80),false);
    const result=await inspectSession({client:fixture({historyMutate:(h,n)=>{if(n===3)mutate(h);}}).client,loseDate:LOSE});
    assert.equal(result.status,'unverified');assert.equal(result.history_recheck_match,false);
  }
  const a=history(),b=history();a.users={'34':{name:'a',role:'b'}};b.users={'34':{role:'b',name:'a'}};
  a.files={'19':{name:'x',type:'y'}};b.files={'19':{type:'y',name:'x'}};
  assert.equal(historiesMatch(a,b,100,80),true);
});

test('reader запрещает чужую сделку, изменение CRM, произвольный скан и неподтверждённые ID',async()=>{
  let calls=0;const reader=restrictedReader({async request(){calls++;return {result:[]};}},LOSE);
  for(const [method,body] of [
    ['crm.deal.get',{id:123}],['crm.deal.update',{id:127114}],
    ['crm.stagehistory.list',{entityTypeId:2,filter:{OWNER_ID:127114},order:{CREATED_TIME:'DESC'},select:['ID','STAGE_ID','CREATED_TIME'],start:500}],
    ['imopenlines.crm.chat.get',{CRM_ENTITY_TYPE:'deal',CRM_ENTITY:127114,ACTIVE_ONLY:'N',OTHER:'x'}],
    ['imopenlines.session.history.get',{CHAT_ID:100}],['imopenlines.session.history.get',{SESSION_ID:80}],
    ['imopenlines.v2.Session.list',{dateCreateFrom:'2020-01-01',dateCreateTo:LOSE,limit:200,offset:0,order:'dateCreate',orderDirection:'desc'}],
    ['imopenlines.v2.Session.list',{dateCreateFrom:'2026-01-01T00:00:00.000Z',dateCreateTo:LOSE,limit:200,offset:4000,order:'dateCreate',orderDirection:'desc'}],
    ['imopenlines.v2.Session.list',{configId:71,dateCreateFrom:'2026-01-01T00:00:00.000Z',dateCreateTo:LOSE,limit:200,offset:0,order:'dateCreate',orderDirection:'desc'}],
  ])await assert.rejects(reader.request(method,body));
  assert.equal(calls,0);
});

test('после подтверждения чата разрешает только линию, извлечённую из его истории',async()=>{
  const f=fixture();const reader=restrictedReader(f.client,LOSE);
  await reader.request('imopenlines.crm.chat.get',{CRM_ENTITY_TYPE:'deal',CRM_ENTITY:127114,ACTIVE_ONLY:'N'});
  await reader.request('imopenlines.session.history.get',{CHAT_ID:100});
  const page={configId:71,dateCreateFrom:'2026-01-01T00:00:00.000Z',dateCreateTo:LOSE,limit:200,offset:0,order:'dateCreate',orderDirection:'desc'};
  await reader.request('imopenlines.v2.Session.list',page);
  await assert.rejects(reader.request('imopenlines.v2.Session.list',{...page,configId:72}));
  await assert.rejects(reader.request('imopenlines.v2.Session.list',{...page,source:'wazzup'}));
});

test('неполная промежуточная страница не подтверждает завершение',async()=>{
  const client=fixture({pages:[{sessions:[record()],hasNextPage:true}]}).client;
  const result=await inspectSession({client,loseDate:LOSE});
  assert.equal(result.status,'unverified');assert.equal(result.stage,'session_list_invalid');
  assert.equal(result.session_found,true);assert.equal(result.session_crm,'matches');
});

test('пилот не выдаёт данные при неподтверждённом завершении или другом эталоне',async()=>{
  await assert.rejects(runSessionDiagnostic({env:{},readBaselines:async()=>({baselines:[{deal_id:127114,analysis_id:'1'}]}),
    pilotCommand:async({readBaselines})=>readBaselines({},{} )}));
  await assert.rejects(runSessionDiagnostic({env:{},pilotCommand:async()=>({service_closed:false})}));
});

test('пилот пропускает только закреплённый эталон и возвращает категориальный результат после закрытия',async()=>{
  const {client}=fixture();let runnerCalls=0;
  const result=await runSessionDiagnostic({env:{},readBaselines:async()=>({baselines:[{deal_id:127114,analysis_id:'1968',lose_date:LOSE}]}),
    pilotCommand:async({readBaselines,makeRunner,env,startService})=>{
      assert.equal(env.POLZA_API_KEY,'disabled');
      const snapshot=await readBaselines({},{});
      const service=await startService();await service.close();
      const runner=makeRunner({bitrix:client});runnerCalls++;
      const outcome=await runner.run({dealId:127114,baseline:snapshot.baselines[0]});
      assert.equal(outcome.status,'blocked');return {selected:1,attempted:1,statuses:{blocked:1},service_closed:true};
    }});
  assert.equal(runnerCalls,1);assert.equal(result.status,'verified');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_CONTENT|"80"|"100"/);
});

test('настоящий pilot command закрывает БД до чтения чата и завершает ресурсы',async()=>{
  const {client}=fixture();const events=[];
  const result=await runSessionDiagnostic({
    env:{DATABASE_URL:'postgresql://u:p@localhost/test',BITRIX_REST_BASE:'https://example.invalid/rest/'},
    readBaselines:async()=>({baselines:[{deal_id:127114,analysis_id:'1968',lose_date:LOSE}],audio_wait_enabled_at:'2026-01-01T00:00:00Z'}),
    pilotCommand:opts=>runPilotCommand({...opts,
      makePool:async()=>({on(){},async connect(){throw new Error('NO NETWORK');},async end(){events.push('pool_closed');}}),
      readPrompts:async()=>({}),
      makeDependencies:()=>({bitrix:{async request(...args){assert.deepEqual(events,['pool_closed']);return client.request(...args);}},close(){events.push('deps_closed');}}),
      startService:async()=>({address:'http://127.0.0.1:1',key:'disabled',tempRoot:'.',async close(){events.push('service_closed');}}),
    }),
  });
  assert.equal(result.status,'verified');
  assert.deepEqual(events,['pool_closed','deps_closed','service_closed']);
});
