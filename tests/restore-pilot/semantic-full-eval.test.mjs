import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dealReader, compareGold, runSemanticFullEval } from '../../app/src/pilot/semantic-full-eval.mjs';

test('ограничивает методы, сделку и историю только ранее найденными сессиями', async () => {
  const calls=[];
  const reader=dealReader({async request(method, body) { calls.push([method,body]);
    if(method==='imopenlines.crm.chat.get')return {result:[{CHAT_ID:100}]};
    if(method==='crm.activity.list')return {result:[{ASSOCIATED_ENTITY_ID:80}]};
    return {result:{}};
  }});
  await assert.rejects(reader.request('crm.deal.update',{id:127114}),/запрещён/);
  await assert.rejects(reader.request('crm.deal.get',{id:1}),/запрещён/);
  await assert.rejects(reader.request('disk.file.get',{id:7}),/запрещён/);
  await assert.rejects(reader.request('imopenlines.session.history.get',{SESSION_ID:80}),/запрещён/);
  await reader.request('imopenlines.crm.chat.get',{CRM_ENTITY_TYPE:'deal',CRM_ENTITY:127114});
  await reader.request('crm.activity.list',{filter:{OWNER_TYPE_ID:2,OWNER_ID:127114,PROVIDER_ID:'IMOPENLINES_SESSION'}});
  await reader.request('imopenlines.session.history.get',{SESSION_ID:80});
  await reader.request('imopenlines.session.history.get',{CHAT_ID:100});
  await assert.rejects(reader.request('imopenlines.session.history.get',{SESSION_ID:81}),/запрещён/);
  assert.equal(calls.length,4);
});

test('сопоставляет только уникальные факты с совпадающими временем и текстом', () => {
  const evidence=[{session:'session_1',messages:[{id:'m001',ts:'2026-01-01T00:00:00.000Z',predicted_role:'client',effective_role:'client',source:'semantic_inference',impact:'not_applicable',nonmaterial_unknown:false}]}];
  const baseline={ai_facts_json:{facts:[{fact_id:'f001',source:'chat',channel:'WAZZUP: Max',ts:'2026-01-01T00:00:00Z',content:'hello'}]}};
  const outcome={collection:{raw:{sessions:[{history:{message:{1:{date:'2026-01-01T00:00:00Z',text:'hello'}}}}]}}};
  const match=compareGold(evidence,baseline,outcome);
  assert.equal(match.matched,1);assert.equal(match.correct,1);assert.equal(match.unmatched,15);
  outcome.collection.raw.sessions[0].history.message[2]={date:'2026-01-01T00:00:00Z',text:'hello'};
  assert.equal(compareGold(evidence,baseline,outcome).matched,0);
  delete outcome.collection.raw.sessions[0].history.message[2];
  baseline.ai_facts_json.facts.push({...baseline.ai_facts_json.facts[0]});
  assert.equal(compareGold(evidence,baseline,outcome).matched,0);
  assert.doesNotMatch(JSON.stringify(match),/hello/);
});

test('передаёт только закреплённую сделку, отключает медиа и не выводит сырой исход', async () => {
  let processCalls=0, readCalls=0;
  const secret='PRIVATE_USER_TEXT_AND_KEY';
  const baseline={deal_id:127114,analysis_id:'1968',ai_facts_json:{facts:[]}};
  const report=await runSemanticFullEval({env:{},readBaselines:async()=>{readCalls++;return {baselines:[baseline]};},
    async caseRunner(options){
      assert.equal(options.dealId,'127114');assert.equal(options.analysisId,'1968');
      await options.readBaselines({},{});
      const result=await options.processFn({dealId:127114,silent:true,bitrix:{request:async()=>({result:{}})},llm:{complete:async()=>({})}});
      return {deal_id:'127114',analysis_id:'1968',status:result.status,service_closed:true};
    },
    async processFn(args){processCalls++;assert.equal(args.semanticChatRoles,true);assert.equal(args.screenshots,false);assert.equal(args.silent,true);
      await assert.rejects(args.transcribe({}),/отложено/);await assert.rejects(args.downloadFile('https://invalid'),/запрещена/);
      await assert.rejects(args.resolveFile(7),/отложены/);await assert.rejects(args.bitrix.request('crm.deal.update',{}),/запрещён/);
      return {status:'blocked',pipelineGate:{kind:'recognition'},collection:{deal_data:{lose_date:'2026-01-01T00:00:00Z'},raw:{sessions:[]},secret},
        chatRoleInferenceStats:{model_calls:0},chatRoleInferenceEvidence:[]};
    }});
  assert.equal(processCalls,1);assert.equal(readCalls,1);assert.equal(report.status,'blocked');assert.equal(report.gate,'recognition');
  assert.equal(report.audio_attempted,true);assert.equal(report.image_download_attempted,true);assert.equal(report.service_closed,true);
  assert.doesNotMatch(JSON.stringify(report),new RegExp(secret));
});

test('ошибка безопасного допуска и не подтверждённое закрытие не превращаются в результат', async () => {
  const invalid={deal_id:127114,analysis_id:'1968',ai_facts_json:{facts:[]}};
  await assert.rejects(runSemanticFullEval({env:{},readBaselines:async()=>({baselines:[invalid]}),
    async caseRunner(options){await options.readBaselines({},{});await options.processFn({dealId:1,silent:true});return {};},
    async processFn(){throw new Error('unreachable');}}),/границы пилота/i);
  await assert.rejects(runSemanticFullEval({env:{},async caseRunner(){return {deal_id:'127114',analysis_id:'1968',service_closed:false};}}),/завершение/i);
});

test('медиа не может быть скрыто за якобы успешным результатом', async () => {
  await assert.rejects(runSemanticFullEval({env:{},async readBaselines(){return {baselines:[{deal_id:127114,analysis_id:'1968'}]};},
    async caseRunner(options){await options.readBaselines({},{});await options.processFn({dealId:127114,silent:true,bitrix:{request:async()=>({})},llm:{complete:async()=>({})}});},
    async processFn(args){try{await args.transcribe({});}catch{}return {status:'processed'};}}),/медиа препятствует/i);
});

test('опасную ссылку при отсутствии verdict берёт из llm_meta без утечки её текста', async () => {
  const secret='PRIVATE_DONT_SHOW';
  const report=await runSemanticFullEval({env:{},async readBaselines(){return {baselines:[{deal_id:127114,analysis_id:'1968'}]};},
    async caseRunner(options){await options.readBaselines({},{});const result=await options.processFn({dealId:127114,silent:true,
      bitrix:{request:async()=>({})},llm:{complete:async()=>({})}});return {deal_id:'127114',analysis_id:'1968',status:result.status,service_closed:true};},
    async processFn(){return {status:'error',pipelineGate:{kind:'ok'},analysis:{pipeline_error:secret,multi_agent_analysis:null,
      llm_meta:{warnings:[{code:'unknown_nonmaterial_as_statement',severity:'error',issue:secret}]}}};}});
  assert.equal(report.gate,'unsafe_unknown_proof');assert.equal(report.proof_warnings.error,1);
  assert.deepEqual(report.proof_warning_codes,['unknown_nonmaterial_as_statement']);
  assert.doesNotMatch(JSON.stringify(report),new RegExp(secret));
});

test('настоящий адаптер cohort передаёт флаг и сравнивает безопасный blocked без файлов и текста', async () => {
  const content='PRIVATE_CLIENT_REQUEST';
  const baseline={deal_id:127114,analysis_id:'1968',lose_date:'2026-01-02T00:00:00.000Z',pipeline_error:null,
    ai_facts_json:{facts:[{fact_id:'f001',source:'chat',channel:'WAZZUP: Max',ts:'2026-01-01T00:00:00Z',content}]}};
  let modelCalls=0;
  const report=await runSemanticFullEval({env:{},readBaselines:async()=>({baselines:[baseline]}),
    async pilotCommand({readBaselines,makeRunner,startService,deadlineMs}){
      assert.equal(deadlineMs,480000);const fakeService=await startService();await fakeService.close();
      const data=await readBaselines({}, {dealIds:[127114]});
      const deps={bitrix:{request:async()=>({result:{}})},llm:{complete:async()=>{modelCalls++;return {};}},
        transcribe:async()=>{throw new Error('original STT cannot be called');},downloadFile:async()=>{throw new Error('original media cannot be called');},
        judgeSystemPrompt:'PROMPT',writerSystemPrompt:'PROMPT'};
      const result=await makeRunner(deps).run({dealId:127114,baseline:data.baselines[0],screenshots:true});
      return {selected:1,attempted:1,statuses:{[result.status]:1},service_closed:true};
    },
    async processFn(args){assert.equal(args.silent,true);assert.equal(args.semanticChatRoles,true);assert.equal(args.screenshots,false);
      await args.llm.complete({}, {role:'chat-role-inference'});
      return {status:'blocked',pipelineGate:{kind:'author_ambiguous'},chatRoleInferenceStats:{model_calls:1},
        chatRoleInferenceEvidence:[{session:'session_1',messages:[{id:'m001',ts:'2026-01-01T00:00:00.000Z',
          predicted_role:'client',effective_role:'client',source:'semantic_inference',impact:'not_applicable',nonmaterial_unknown:false}]}],
        collection:{deal_data:{lose_date:baseline.lose_date},raw:{calls:[],comments:[],tasks:[],sessions:[{history:{message:{
          1:{date:'2026-01-01T00:00:00Z',text:content},2:{date:'2026-01-03T00:00:00Z',text:'PRIVATE_LATE'}}}}]}}};
    }});
  assert.equal(modelCalls,1);assert.equal(report.status,'blocked');assert.equal(report.role_calls,1);
  assert.equal(report.comparison.matched,1);assert.equal(report.comparison.correct,1);assert.equal(report.comparison.unmatched,15);
  assert.equal(report.temporal.source,'raw_events_may_duplicate');assert.equal(report.temporal.after_lose,1);
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_/);
});

test('обёртка не позволяет больше трёх классификаций и одного судьи/писателя', async () => {
  let invoked=0;
  await runSemanticFullEval({env:{},async readBaselines(){return {baselines:[{deal_id:127114,analysis_id:'1968'}]};},
    async caseRunner(options){await options.readBaselines({},{});const result=await options.processFn({dealId:127114,silent:true,
      bitrix:{request:async()=>({})},llm:{complete:async()=>{invoked++;return {};}}});
      return {deal_id:'127114',analysis_id:'1968',status:result.status,service_closed:true};},
    async processFn(args){
      for(let i=0;i<3;i++)await args.llm.complete({}, {role:'chat-role-inference'});
      await args.llm.complete({}, {role:'judge'});await args.llm.complete({}, {role:'writer'});
      await assert.rejects(args.llm.complete({}, {role:'chat-role-inference'}),/лимит/);
      await assert.rejects(args.llm.complete({}, {role:'judge'}),/лимит/);
      await assert.rejects(args.llm.complete({}, {role:'writer'}),/лимит/);
      await assert.rejects(args.llm.complete({}, {role:'other'}),/запрещён/);
      return {status:'blocked'};
    }});
  assert.equal(invoked,5);
});
