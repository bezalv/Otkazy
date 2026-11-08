import test from 'node:test';
import assert from 'node:assert/strict';
import { processDeal } from '../../app/src/process-deal.mjs';

const LOSE='2026-11-04T12:00:00Z';
function fixture() {
  const counts={bitrix:0,roles:0,judge:0,media:0,verifier:0};
  const bitrix={async request(method,body){
    counts.bitrix++;
    if(method==='crm.deal.userfield.list')return {result:[{LIST:[{ID:'1',VALUE:'Другая'}]}]};
    if(method==='crm.deal.get')return {result:{ID:'42',STAGE_ID:'C23:LOSE',ASSIGNED_BY_ID:'65',UF_CRM_1584703948317:'1'}};
    if(method==='crm.stagehistory.list')return {result:{items:[{ID:'101',STAGE_ID:'C23:LOSE',CREATED_TIME:LOSE}]}};
    if(method==='crm.activity.list'&&body.filter.PROVIDER_ID==='IMOPENLINES_SESSION')return {result:[]};
    if(method==='imopenlines.crm.chat.get')return {result:[{CHAT_ID:100,CONNECTOR_ID:'wazzup',CONNECTOR_TITLE:'wazzup'}]};
    if(method==='imopenlines.session.history.get')return {result:{chatId:100,sessionId:80,
      chat:{100:{entityId:'wazzup|71|client|external'}},users:{55:{connector:true}},files:{},message:{
        1:{id:1,senderid:55,date:'2026-11-04T10:00:00Z',text:'=== Исходящее сообщение ===\nМожем предложить вам замену окна.'},
        2:{id:2,senderid:55,date:'2026-11-04T10:01:00Z',text:'Нет, спасибо, мы уже заказали окна в другом месте.'}}}};
    if(method==='crm.activity.list'||method==='crm.timeline.comment.list')return {result:[]};
    if(method==='tasks.task.list')return {result:{tasks:[]}};
    throw new Error('unexpected');
  }};
  const llm={async complete(body,options={}){
    if(options.role==='chat-role-inference'){
      counts.roles++;
      const entries=JSON.parse(body.messages[1].content).messages;
      return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({roles:entries.map((entry,i)=>({
        id:entry.id,role:i===0?'manager':'client',impact:'not_applicable'}))})}}]};
    }
    if(options.role==='judge'){
      counts.judge++;
      const judge={verdict:'правомерен',verdict_reason_short:'Клиент отказался',recoverable_level:null,
        closure_reason_class:'competitor',misplaced:false,correct_stage:null,exact_reason:'Клиент уже заказал окна.',
        manager_mistakes:[],key_signals:[],risk_factors:[],questions_for_manager:[]};
      return {choices:[{message:{content:JSON.stringify(judge)}}]};
    }
    throw new Error('unexpected model');
  }};
  const args={dealId:42,bitrix,llm,semanticChatRoles:true,silent:true,nowMs:Date.parse('2026-11-05T00:00:00Z'),
    wait:async()=>{},audioWaitEnabledAt:'2026-11-01T00:00:00Z',screenshots:false,
    judgeSystemPrompt:'Тестовый промпт',writerSystemPrompt:'Тест писателя',
    resolveFile:async()=>{counts.media++;throw new Error('unexpected media');},
    transcribe:async()=>{counts.media++;throw new Error('unexpected media');}};
  function verifier(request,changes={}){
    counts.verifier++;
    return {kind:'verified_fallback_session_v1',...request,history:undefined,session_created_at:'2026-11-01T00:00:00Z',
      checks:{chat_bound_to_deal:true,session_matches_chat:true,session_matches_line:true,session_crm_matches_deal:true,
        direct_session_history_matches:true,current_chat_history_matches:true},...changes};
  }
  return {args,counts,verifier};
}

test('тихий прямой вызов передаёт подтверждение сессии классификатору, сохраняя прежние ID',async()=>{
  const {args,counts,verifier}=fixture();let input;
  args.verifyFallbackSession=async request=>{input=request;return verifier(request);};
  const result=await processDeal(args);
  assert.equal(counts.verifier,1);assert.equal(counts.roles,1);assert.equal(counts.judge,1);assert.equal(counts.media,0);
  assert.equal(input.deal_id,'42');assert.equal(input.chat_id,'100');assert.equal(input.session_id,'80');
  assert.equal(input.cutoff,'2026-11-04T12:00:00.000Z');assert.match(input.history_sha256,/^[a-f0-9]{64}$/);
  assert.equal(result.status,'processed');
  const messages=result.dealData.communications.filter(x=>x.type==='chat');
  assert.equal(messages[0].session_id,'chat_100');assert.equal(messages[0].message_id,'chat_100_1');
  assert.equal(messages[1].session_id,'chat_100');assert.equal(messages[1].message_id,'chat_100_2');
  assert.equal(result.chatRoleInferenceEvidence[0].messages[1].predicted_role,'client');
});

test('без подтверждения и при неверном подтверждении модель не получает переписку',async()=>{
  for(const mode of ['absent','wrong_deal','throw']){
    const {args,counts,verifier}=fixture();
    if(mode==='wrong_deal')args.verifyFallbackSession=async request=>verifier(request,{deal_id:'43'});
    if(mode==='throw')args.verifyFallbackSession=async()=>{counts.verifier++;throw new Error('unavailable');};
    const result=await processDeal(args);
    assert.equal(result.status,'blocked',mode);assert.equal(result.pipelineGate.kind,'author_ambiguous',mode);
    assert.equal(counts.roles,0,mode);assert.equal(counts.judge,0,mode);assert.equal(counts.media,0,mode);
  }
});

test('проверяющий отвергается до сбора, если эксперимент выключен или режим не тихий',async()=>{
  for(const change of [{semanticChatRoles:false},{semanticChatRoles:'true'},{silent:false},{silent:'true'}]){
    const {args,counts}=fixture();Object.assign(args,change,{verifyFallbackSession:async()=>true});
    await assert.rejects(processDeal(args),/только в тихом ручном эксперименте/);
    assert.equal(counts.bitrix,0);assert.equal(counts.roles,0);assert.equal(counts.media,0);
  }
  for(const invalid of [null,true,{},'callback']){
    const {args,counts}=fixture();args.verifyFallbackSession=invalid;
    await assert.rejects(processDeal(args),/должна быть функцией/);
    assert.equal(counts.bitrix,0);
  }
});
