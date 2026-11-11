import test from 'node:test';
import assert from 'node:assert/strict';
import { createDurableRoleClient } from '../../app/src/worker/durable-role-client.mjs';
import { inferChatRoles } from '../../app/src/analysis/chat-role-inference.mjs';
import { normalizeCommunications } from '../../app/src/collect/normalize.mjs';
import { createRoleSessionContext } from '../../app/src/worker/role-session-context.mjs';
import { createRoleInferenceLedger } from '../../app/src/worker/role-inference-ledger.mjs';

const row = n => ({type:'chat',connector_id:'wz_test',chat_id:'1',session_id:String(n),
  message_id:`message${n}`,date:`2026-01-01T00:00:0${n}Z`,text:`Сообщение ${n}`,
  role:'unknown',direction:'unknown',author_name:'Участник чата',_wazzup_author_ambiguous:true});
const result = roles => ({choices:[{finish_reason:'stop',message:{content:JSON.stringify({roles})}}]});
const valid = result([{id:'m001',role:'client',impact:'not_applicable'}]);
const wrong = result([{id:'wrong',role:'client',impact:'not_applicable'}]);
const contexts=new WeakMap(), job='00000000-0000-4000-8000-000000000001', lease='00000000-0000-4000-8000-000000000002';
function harness({ sessionContext, reserve, preSend, finish, checkLease, response = valid } = {}) {
  const events=[];let sent=0, sealed=0, reservationDenied=false;const attempts=[];
  const pool={async connect(){return {release(){},async query(sql,params=[]){
    if(/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql))return {rows:[]};
    if(sql.includes('FROM public.lost_processing_jobs') && sql.includes('remaining_ms'))return {rows:[{id:job,remaining_ms:60000,
      trigger_type:'live',request_key:'bitrix24:deal-stage-history:101',origin_stage_history_id:null}]};
    if(sql.includes('INSERT INTO public.lost_role_inference_scopes')){
      events.push('reserve');const outcome=reserve ? await reserve() : {status:'reserved'};
      reservationDenied=outcome?.status!=='reserved';return {rows:[]};
    }
    if(sql.includes('SELECT deal_id FROM public.lost_role_inference_scopes'))return {rows:[{deal_id:'42'}]};
    if(sql.includes('SELECT EXISTS'))return {rows:[{found:reservationDenied}]};
    if(sql.includes('SELECT job_id::text,attempt_no')){
      if(attempts.at(-1)?.state==='reserved'){
        events.push('presend');const outcome=preSend ? await preSend(attempts.length) : {status:'allowed'};
        if(outcome?.status!=='allowed')return {rows:[]};
      }
      return {rows:structuredClone(attempts)};
    }
    if(sql.includes('INSERT INTO public.lost_role_inference_attempts')){
      attempts.push({job_id:params[0],attempt_no:params[2],lease_token:params[1],run_id:params[3],state:'reserved'});
      return {rows:[{attempt_no:params[2]}]};
    }
    if(sql.includes('UPDATE public.lost_role_inference_attempts')){
      events.push(`finish:${params[2]}:${params[4]}`);const outcome=finish ? await finish(params[2],params[4]) : {status:params[4]};
      if(outcome?.status!==params[4])return {rows:[]};attempts[params[2]-1].state=params[4];return {rows:[{attempt_no:params[2]}]};
    }
    throw Error('неизвестный SQL мок');
  }}}};
  const ledger=createRoleInferenceLedger(pool,{jobId:job,leaseToken:lease,dealId:'42',stageHistoryId:'101',cutoff});
  const transport={async complete(_body,options){events.push('POST');sent++;assert.equal(options.role,'chat-role-inference');
    if(response instanceof Error)throw response;return response;},failClosed(){events.push('seal');sealed++;}};
  return {events,ledger,transport,get sent(){return sent;},get sealed(){return sealed;},
    client:createDurableRoleClient({ledger,transport,sessionContext,
      async checkLease(){events.push('lease');return checkLease ? checkLease() : undefined;}})};
}
const cutoff='2026-01-01T00:01:00.000Z';
const infer = (client,communications) => inferChatRoles({communications,client,cutoff,dealId:'42'});
async function verifiedRows(family='Wazzup') {
  const code=family==='Wappi'?'opaque':'wz_test';
  const history={chatId:1,sessionId:2,chat:{1:{entityId:`${code}|9|client|user`}},
    users:{55:family==='Wappi'?{}:{connector:true}},files:{},message:{50:{id:50,senderid:55,date:'2026-01-01T00:00:01Z',text:'Сообщение'}}};
  const bitrix={async request(method){
    if(method==='crm.deal.get')return {result:{ID:'42',STAGE_ID:'C23:LOSE'}};
    if(method==='crm.stagehistory.list')return {result:{items:[{ID:'101',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}]}};
    if(method==='imopenlines.crm.chat.get')return {result:[{CHAT_ID:1,CONNECTOR_ID:code,CONNECTOR_TITLE:family}]};
    if(method==='imopenlines.session.history.get')return {result:structuredClone(history)};
    if(method==='imopenlines.v2.Session.list')return {result:{sessions:[{id:2,chatId:1,configId:9,crmEntityType:'deal',crmEntityId:'42',dateCreate:'2026-01-01T00:00:00Z'}],hasNextPage:false}};
    throw Error('unexpected method');
  }};
  const scope=createRoleSessionContext({client:bitrix,dealId:'42',transitionId:'101',cutoff,from:'2025-12-01T00:00:00Z'});
  const collection={_status:'pending_normalization',deal_id:'42',silent:true,deal_data:{lose_date:cutoff},
    _sources:Object.fromEntries(['calls','openlines','comments','tasks'].map(k=>[k,{complete:true}])),
    raw:{calls:[],comments:[],tasks:[],chats:[{CHAT_ID:1,CONNECTOR_ID:code,CONNECTOR_TITLE:family}],sessions:[{chat_id:1,history}]}};
  const rows=(await normalizeCommunications({collection,verifyFallbackSession:scope.verify})).deal_data.communications;
  contexts.set(rows,scope);return rows;
}
async function verifiedRequest() {
  const group=await verifiedRows();let request;
  await inferChatRoles({communications:group,dealId:'42',cutoff,client:{requireVerifiedSession:true,
    async complete(body){request=body;throw Error('synthetic capture');}}});
  assert.ok(request);return {request,context:contexts.get(group),options:{role:'chat-role-inference',verifiedGroup:group}};
}

test('резерв фиксируется до POST, подтверждение — после бизнес-валидации, роль остаётся вероятностной',async()=>{
  for(const family of ['Wazzup','Wappi']){
    const input=await verifiedRows(family),h=harness({sessionContext:contexts.get(input)}), output=await infer(h.client,input);
    assert.deepEqual(h.events,['reserve','presend','lease','POST','finish:1:settled'],family);
    assert.equal(output.communications[0]._role_source,'semantic_inference',family);
    assert.equal(output.stats.resolved,1);assert.equal(h.client.snapshot().pending_confirmation,false);
  }
});
test('неподтверждённый резерв, неизвестный COMMIT и чужая роль не отправляют запрос',async()=>{
  const {request,options,context}=await verifiedRequest();
  for (const reserve of [()=>({status:'needs_review'}),()=>{throw Error('COMMIT неизвестен');}]) {
    const h=harness({reserve,sessionContext:context});await assert.rejects(h.client.complete(request,options));
    assert.equal(h.sent,0);assert.equal(h.client.snapshot().closed,true);
  }
  const h=harness({sessionContext:context});await assert.rejects(h.client.complete({}, {role:'judge'}));
  assert.equal(h.sent,0);assert.deepEqual(h.events,[]);
});
test('ошибка бизнес-валидации фиксирует unknown и не разрешает следующий POST',async()=>{
  const input=await verifiedRows(), h=harness({response:wrong,sessionContext:contexts.get(input)}), output=await infer(h.client,input);
  assert.deepEqual(h.events,['reserve','presend','lease','POST','seal','finish:1:unknown']);
  assert.equal(h.sent,1);assert.equal(output.stats.unresolved,1);assert.deepEqual(output.communications,input);
  assert.equal(h.client.snapshot().closed,true);
});
test('ошибка провайдера и потеря lease не становятся проверенной ролью',async()=>{
  const first=await verifiedRows(), failed=harness({response:new Error('данные поставщика'),sessionContext:contexts.get(first)});
  const a=await infer(failed.client,first);assert.equal(a.stats.unresolved,1);
  assert.ok(failed.events.includes('finish:1:unknown'));assert.doesNotMatch(JSON.stringify(a),/данные поставщика/);
  const second=await verifiedRows(), lost=harness({finish:()=>({status:'lease_lost'}),sessionContext:contexts.get(second)}), b=await infer(lost.client,second);
  assert.equal(b.stats.unresolved,1);assert.equal(lost.client.snapshot().closed,true);
  assert.equal(b.communications[0]._wazzup_author_ambiguous,true);
});
test('Wazzup с неподтверждённой сессией не отправляет текст модели даже при явных ID',async()=>{
  const other=await verifiedRows(),h=harness({sessionContext:contexts.get(other)}),input=[row(1)],output=await infer(h.client,input);
  assert.equal(h.sent,0);assert.deepEqual(h.events,[]);assert.equal(output.stats.unresolved,1);
  assert.deepEqual(output.communications,input);
});
test('ledger, verifier и proof привязаны к одному переходу и одному экземпляру проверки',async()=>{
  const {request,options,context}=await verifiedRequest();
  const empty={async request(){throw Error('чтение не ожидается');}};
  for(const change of [{transitionId:'102'},{dealId:'43'},{cutoff:'2026-01-01T00:01:01.000Z'}]){
    const other=createRoleSessionContext({client:empty,dealId:'42',transitionId:'101',cutoff,
      from:'2025-12-01T00:00:00Z',...change});
    assert.throws(()=>harness({sessionContext:other}),TypeError);
  }
  const equivalent=createRoleSessionContext({client:empty,dealId:'42',transitionId:'101',cutoff,from:'2025-12-01T00:00:00Z'});
  const h=harness({sessionContext:equivalent});await assert.rejects(h.client.complete(request,options));
  assert.equal(h.sent,0);assert.ok(!h.events.includes('reserve'));
  assert.throws(()=>createDurableRoleClient({ledger:{reserve(){},preSend(){},finish(){}},sessionContext:context,
    transport:{complete(){},failClosed(){}},checkLease(){}}),TypeError);
});
test('прямой вызов без proof или с изменённой системной инструкцией не резервирует и не отправляет',async()=>{
  const {request,options,context}=await verifiedRequest();
  for(const attempt of [
    {body:request,opts:{role:'chat-role-inference',verifiedGroup:[row(1)]}},
    {body:{...request,messages:[{...request.messages[0],content:'подмена'},request.messages[1]]},opts:options},
  ]){
    const h=harness({sessionContext:context});await assert.rejects(h.client.complete(attempt.body,attempt.opts));
    assert.equal(h.sent,0);assert.ok(!h.events.includes('reserve'));
  }
});
test('неподтверждённый preSend, false и исключение проверки lease не разрешают POST',async()=>{
  const {request,options,context}=await verifiedRequest();
  for(const config of [{preSend:()=>({status:'needs_review'})},
    {preSend:()=>{throw Error('COMMIT неизвестен');}}, {checkLease:()=>false}, {checkLease:()=>null},
    {checkLease:()=>0}, {checkLease:()=>({error:true})}, {checkLease:()=>{throw Error('нет аренды');}}]){
    const h=harness({...config,sessionContext:context});await assert.rejects(h.client.complete(request,options));
    assert.equal(h.sent,0);assert.ok(h.events.includes('finish:1:unknown') || h.client.snapshot().closed);
  }
});
test('прямой confirm не может записать settled для ответа с неверными ID',async()=>{
  const {request,options,context}=await verifiedRequest(), h=harness({response:wrong,sessionContext:context});
  await h.client.complete(request,options);await assert.rejects(h.client.confirmValidated());
  assert.equal(h.sent,1);assert.ok(h.events.includes('finish:1:unknown'));
  assert.ok(!h.events.includes('finish:1:settled'));assert.equal(h.client.snapshot().closed,true);
});
test('подмена снимка пока ждём preSend останавливает POST',async()=>{
  const {request,options,context}=await verifiedRequest();let release,notify;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{notify=resolve;});
  const h=harness({sessionContext:context,preSend:async()=>{notify();await gate;return {status:'allowed'};}});
  const pending=h.client.complete(request,options);await started;
  options.verifiedGroup[0].text='изменено';release();await assert.rejects(pending);
  assert.equal(h.sent,0);assert.ok(h.events.includes('finish:1:unknown'));
});
test('изменение проверенного контекста во время подтверждения не применяет роль',async()=>{
  let release, notify;const gate=new Promise(resolve=>{release=resolve;});
  const confirmationStarted=new Promise(resolve=>{notify=resolve;});
  const input=await verifiedRows('Wappi'), h=harness({sessionContext:contexts.get(input),finish:async(_n,state)=>{if(state==='settled'){notify();await gate;}return {status:state};}}), pending=infer(h.client,input);
  await confirmationStarted;input[0].text='Подмена после исходного снимка';release();
  const output=await pending;
  assert.equal(output.stats.unresolved,1);assert.equal(output.stats.resolved,0);
  assert.equal(output.communications[0]._wappi_author_ambiguous,true);
  assert.equal(output.communications[0]._role_source,undefined);
  assert.equal(h.client.snapshot().closed,true);assert.equal(h.sent,1);
  // settled здесь фиксирует факт исходного проверенного ответа, а не его
  // применение или стоимость; дополнительный запрос запрещён.
  assert.ok(h.events.includes('finish:1:settled'));
  await assert.rejects(h.client.complete({}, {role:'chat-role-inference'}));
});
test('нельзя перейти к следующему POST до подтверждения предыдущего ответа',async()=>{
  const {request,options,context}=await verifiedRequest(),h=harness({sessionContext:context});await h.client.complete(request,options);
  await assert.rejects(h.client.complete(request,options));assert.equal(h.sent,1);
  await h.client.confirmValidated();await h.client.complete(request,options);
  assert.equal(h.sent,2);await h.client.failClosed();
  assert.ok(h.events.includes('finish:2:unknown'));
});
test('закрытие во время ожидания резерва не отправляет POST и сохраняет неопределённость',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const {request,options,context}=await verifiedRequest(),h=harness({sessionContext:context,reserve:async()=>{await gate;return {status:'reserved',attempt_no:1};}});
  const pending=h.client.complete(request,options);await h.client.failClosed();release();
  await assert.rejects(pending);assert.equal(h.sent,0);assert.ok(h.events.includes('finish:1:unknown'));
});
