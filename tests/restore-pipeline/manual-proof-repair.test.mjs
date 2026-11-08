import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgents } from '../../app/src/agents/index.mjs';
import { processDeal } from '../../app/src/process-deal.mjs';
import { createManualModelLimiter, runManualSessionPilot } from '../../app/src/pilot/manual-session-adapter.mjs';

const usage=(n)=>({prompt_tokens:n,completion_tokens:n+1,total_tokens:n*2+1});
const verdict=ref=>({verdict:'неправомерен',verdict_reason_short:'Нужна проверка',recoverable_level:'средний',
  closure_reason_class:'other',misplaced:false,correct_stage:null,exact_reason:'Причина требует проверки.',
  manager_mistakes:[],key_signals:[{signal:'Подтверждённый сигнал',proof_type:'client_statement',proof_fact_ids:[ref]}],
  risk_factors:[],questions_for_manager:[]});
const response=(body,u=usage(2))=>({model:'test-model',...(u===null?{}:{usage:u}),choices:[{finish_reason:'stop',message:{content:JSON.stringify(body)}}]});
function prepared() {
  return {deal_id:42,_data_enough:true,facts_packet:{deal_card:{},metrics:{},facts:[
    {fact_id:'f001',actor:'manager',source:'chat',content:'Менеджер предложил'},
    {fact_id:'f002',actor:'client',source:'chat',content:'Клиент отказался'}]},
    judge_request_body:{model:'test',messages:[{role:'system',content:'система'},{role:'user',content:'исходные факты'}],temperature:0},
    communications:[],journal_text:'',analytics_text:''};
}
function harness(responses) {
  const seen=[];const client={async complete(body,options){seen.push({body,role:options.role});
    if(options.role==='writer')return {model:'writer',usage:usage(5),choices:[{message:{content:'Тестовый разбор'}}]};
    const value=responses.shift();if(value instanceof Error)throw value;return value;
  }};
  return {seen,client,options:{prepared:prepared(),pipelineGate:{block:false},analytics:{full_prompt_text:''},
    writerSystemPrompt:'Писатель',client,now:Date.parse('2026-11-05T00:00:00Z'),
    repairProofErrors:true,silent:true,semanticChatRoles:true}};
}

test('без ошибок ручной опыт вызывает судью один раз',async()=>{
  const h=harness([response(verdict('f002'))]);const result=await runAgents(h.options);
  assert.equal(result.pipeline_error,undefined);assert.deepEqual(h.seen.map(x=>x.role),['judge','writer']);
  assert.equal(result.multi_agent_analysis.proof_errors_count,0);
});

test('коррекция получает прежние факты и JSON ответа; правильная ссылка повторно проверяется до писателя',async()=>{
  const h=harness([response(verdict('f001'),usage(2)),response(verdict('f002'),usage(4))]);
  const original=JSON.stringify(h.options.prepared.judge_request_body);const result=await runAgents(h.options);
  assert.deepEqual(h.seen.map(x=>x.role),['judge','judge','writer']);
  assert.equal(JSON.stringify(h.options.prepared.judge_request_body),original);
  assert.deepEqual(h.seen[1].body.messages.slice(0,2),h.seen[0].body.messages);
  assert.deepEqual(JSON.parse(h.seen[1].body.messages[2].content),verdict('f001'));
  assert.match(h.seen[1].body.messages[3].content,/Не меняй факты/);
  assert.equal(result.multi_agent_analysis.proof_errors_count,0);
  assert.equal(result.multi_agent_analysis.proof_repair.status,'corrected');
  assert.equal(result.multi_agent_analysis.proof_repair.initial_errors,1);
  assert.equal(result.multi_agent_analysis.proof_repair.initial_warnings.length,1);
  assert.deepEqual(result.multi_agent_analysis.judge_usage,{prompt_tokens:6,completion_tokens:8,total_tokens:14});
  assert.deepEqual([result.llm_meta.prompt_tokens,result.llm_meta.completion_tokens,result.llm_meta.total_tokens],[11,14,25]);
  assert.equal(result.llm_meta.usage_complete,true);
});

test('неисправленный или повреждённый ответ и ошибка вызова не запускают писателя',async()=>{
  for(const second of [response(verdict('f001')), {choices:[{message:{content:'не JSON'}}],usage:usage(3)},
    {choices:[{finish_reason:'stop',message:{content:`Пояснение ${JSON.stringify(verdict('f002'))}`}}],usage:usage(3)},
    {choices:[{finish_reason:'length',message:{content:JSON.stringify(verdict('f002'))}}],usage:usage(3)}, new Error('network')]){
    const h=harness([response(verdict('f001')),second]);const result=await runAgents(h.options);
    assert.match(result.pipeline_error,/Сбой анализа/);assert.deepEqual(h.seen.map(x=>x.role),['judge','judge']);
    assert.equal(result.classification,null);assert.equal(result.multi_agent_analysis,null);
    assert.equal(result.llm_meta.proof_repair.status,'failed');assert.equal(result.llm_meta.proof_repair.initial_errors,1);
    if(second instanceof Error){assert.equal(result.llm_meta.judge_usage_complete,false);assert.equal(result.llm_meta.total_tokens,null);
      assert.equal(result.llm_meta.judge_usage,null);assert.deepEqual(result.llm_meta.judge_usage_known,usage(2));}
  }
});

test('ручная проверка требует соответствие типа ссылки, запрещает null-метрику, но разрешает смешанные пруфы отсутствия',async()=>{
  for(const invalid of [
    {proof_type:'client_statement',proof_fact_ids:['metric:count']},
    {proof_type:'manager_statement',proof_fact_ids:['metric:count']},
    {proof_type:'crm_comment',proof_fact_ids:['metric:count']},
    {proof_type:'metric',proof_fact_ids:['f002']},
    {proof_type:'metric',proof_fact_ids:['metric:unknown']},
    {proof_type:'metric',proof_fact_ids:['metric:toString']},
    {proof_type:'metric',proof_fact_ids:['metric:constructor']},
    {proof_type:'client_statement',proof_fact_ids:[]},
    {proof_type:'client_statement',proof_fact_ids:['f003']},
  ]) {
    const first=verdict('f002');Object.assign(first.key_signals[0],invalid);
    const fixed=verdict('f002');const h=harness([response(first),response(fixed)]);
    h.options.prepared.facts_packet.metrics={count:1,unknown:null};
    h.options.prepared.facts_packet.facts.push({fact_id:'f003',actor:'unknown',source:'call_transcript'});
    const result=await runAgents(h.options);
    assert.deepEqual(h.seen.map(x=>x.role),['judge','judge','writer']);
    assert.equal(result.multi_agent_analysis.proof_repair.status,'corrected');
  }
  const first=verdict('f002');first.key_signals[0].proof_type='absence';first.key_signals[0].proof_fact_ids=['f002','metric:count'];
  const h=harness([response(first)]);h.options.prepared.facts_packet.metrics={count:1};
  const result=await runAgents(h.options);assert.deepEqual(h.seen.map(x=>x.role),['judge','writer']);
  assert.equal(result.multi_agent_analysis.proof_errors_count,0);
});

test('лимит ручного адаптера блокирует лишние логические вызовы до клиента',async()=>{
  const actual=[];const client=createManualModelLimiter({async complete(body,options){actual.push(options.role);return {}; }},{repairProofErrors:true});
  for(let i=0;i<3;i++)await client.complete({},{role:'chat-role-inference'});
  await assert.rejects(client.complete({},{role:'chat-role-inference'}),/запрещён/);
  for(let i=0;i<2;i++)await client.complete({},{role:'judge'});
  await assert.rejects(client.complete({},{role:'judge'}),/запрещён/);
  await client.complete({},{role:'writer'});await assert.rejects(client.complete({},{role:'writer'}),/запрещён/);
  await assert.rejects(client.complete({},{role:'other'}),/запрещён/);
  assert.deepEqual(actual,['chat-role-inference','chat-role-inference','chat-role-inference','judge','judge','writer']);
  let calls=0;const ordinary=createManualModelLimiter({async complete(){calls++;return {};}});
  await ordinary.complete({},{role:'judge'});await assert.rejects(ordinary.complete({},{role:'judge'}),/запрещён/);
  assert.equal(calls,1);
});

test('неполная статистика модели не превращается в нулевые токены',async()=>{
  for(const responses of [[response(verdict('f001'),null),response(verdict('f002'),usage(4))],
    [response(verdict('f001'),usage(3)),response(verdict('f002'),null)]]) {
    const known = responses.find(item => item.usage)?.usage;
    const h=harness(responses);const result=await runAgents(h.options);
    assert.equal(result.multi_agent_analysis.proof_repair.status,'corrected');
    assert.equal(result.llm_meta.judge_usage_complete,false);assert.equal(result.llm_meta.usage_complete,false);
    assert.equal(result.llm_meta.total_tokens,null);assert.equal(result.multi_agent_analysis.judge_usage,null);
    assert.deepEqual(result.multi_agent_analysis.judge_usage_known,known);
    assert.equal(result.multi_agent_analysis.judge_usage_complete,false);
  }
});

test('после успешной коррекции отсутствие статистики писателя не становится нулевыми затратами',async()=>{
  const h=harness([response(verdict('f001')),response(verdict('f002'))]);let writerCalls=0;
  const original=h.options.client;
  h.options.client={async complete(body,options){
    if(options.role==='writer'){writerCalls++;return {choices:[{message:{content:'Текст без usage'}}]};}
    return original.complete(body,options);
  }};
  const result=await runAgents(h.options);
  assert.equal(writerCalls,1);assert.equal(result.llm_meta.judge_usage_complete,true);
  assert.equal(result.llm_meta.usage_complete,false);assert.equal(result.llm_meta.total_tokens,null);
  assert.equal(result.multi_agent_analysis.proof_repair.initial_errors,1);
});

test('сбой писателя после исправления не теряет отметку и не скрывает неопределённый расход',async()=>{
  const h=harness([response(verdict('f001')),response(verdict('f002'))]);const original=h.options.client;
  h.options.client={async complete(body,options){if(options.role==='writer')throw Error('failure');return original.complete(body,options);}};
  const result=await runAgents(h.options);
  assert.match(result.pipeline_error,/писателя/);assert.equal(result.llm_meta.proof_repair.status,'corrected');
  assert.equal(result.llm_meta.usage_complete,false);assert.equal(result.llm_meta.total_tokens,null);
  assert.deepEqual(result.llm_meta.judge_usage,{prompt_tokens:4,completion_tokens:6,total_tokens:10});
  assert.deepEqual(result.llm_meta.judge_usage_known,result.llm_meta.judge_usage);
});

test('при неполной статистике повторной проверки известная часть не выдаётся за полную сумму судьи',async()=>{
  const h=harness([response(verdict('f001'),usage(3)),response(verdict('f002'),null)]);const original=h.options.client;
  h.options.client={async complete(body,options){if(options.role==='writer')throw Error('failure');return original.complete(body,options);}};
  const result=await runAgents(h.options);
  assert.equal(result.llm_meta.judge_usage_complete,false);
  assert.equal(result.llm_meta.judge_usage,null);
  assert.deepEqual(result.llm_meta.judge_usage_known,usage(3));
  assert.equal(result.llm_meta.total_tokens,null);
});

test('обычный режим один раз исправляет формальную ошибку и повторно проверяет результат до писателя',async()=>{
  const h=harness([response(verdict('f001')),response(verdict('f002'))]);
  const result=await runAgents({...h.options,repairProofErrors:false,silent:false,semanticChatRoles:false});
  assert.deepEqual(h.seen.map(x=>x.role),['judge','judge','writer']);
  assert.equal(result.multi_agent_analysis.proof_errors_count,0);
  assert.equal(result.multi_agent_analysis.proof_repair.status,'corrected');
});

test('обычный режим не выдаёт вердикт при неисправленных доказательствах',async()=>{
  for (const second of [response(verdict('f001')),new Error('failure')]) {
    const h=harness([response(verdict('f001')),second]);
    const result=await runAgents({...h.options,repairProofErrors:false,silent:false,semanticChatRoles:false});
    assert.deepEqual(h.seen.map(x=>x.role),['judge','judge']);
    assert.match(result.pipeline_error,/Сбой анализа/);
    assert.equal(result.classification,null);assert.equal(result.multi_agent_analysis,null);
  }
});

test('строгие проверки действуют в обычном режиме без лишнего вызова при корректных ссылках',async()=>{
  for(const invalid of [
    {proof_type:'client_statement',proof_fact_ids:['missing']},
    {proof_type:'client_statement',proof_fact_ids:['f001']},
    {proof_type:'client_statement',proof_fact_ids:['metric:count']},
    {proof_type:'metric',proof_fact_ids:['f002']},
    {proof_type:'metric',proof_fact_ids:['metric:unknown']},
    {proof_type:'metric',proof_fact_ids:['metric:constructor']},
    {proof_type:'client_statement',proof_fact_ids:['f003']},
    {proof_type:'client_statement',proof_fact_ids:[]},
  ]) {
    const first=verdict('f002');Object.assign(first.key_signals[0],invalid);
    const h=harness([response(first),response(verdict('f002'))]);
    h.options.prepared.facts_packet.metrics={count:1,unknown:null};
    h.options.prepared.facts_packet.facts.push({fact_id:'f003',actor:'unknown',source:'chat'});
    const result=await runAgents({...h.options,repairProofErrors:false,silent:false,semanticChatRoles:false});
    assert.deepEqual(h.seen.map(x=>x.role),['judge','judge','writer']);
    assert.equal(result.multi_agent_analysis.proof_repair.status,'corrected');
  }
  for (const refs of [[],['f002','metric:count']]) {
    const v=verdict('f002');Object.assign(v.key_signals[0],{proof_type:'absence',proof_fact_ids:refs});
    const h=harness([response(v)]);h.options.prepared.facts_packet.metrics={count:1};
    const result=await runAgents({...h.options,repairProofErrors:false,silent:false,semanticChatRoles:false});
    assert.deepEqual(h.seen.map(x=>x.role),['judge','writer']);assert.equal(result.multi_agent_analysis.proof_errors_count,0);
  }
});

test('ручной опыт без включённой коррекции не превышает лимит судьи',async()=>{
  const h=harness([response(verdict('f001'))]);
  const result=await runAgents({...h.options,repairProofErrors:false});
  assert.deepEqual(h.seen.map(x=>x.role),['judge']);
  assert.match(result.pipeline_error,/ссылки судьи не прошли/);
  assert.equal(result.multi_agent_analysis,null);
});

test('недостаток данных не вызывает судью и писателя',async()=>{
  const h=harness([]);h.options.prepared._data_enough=false;
  h.options.prepared.judge={...verdict('f002'),verdict:'недостаточно_данных',key_signals:[]};
  const result=await runAgents({...h.options,repairProofErrors:false,silent:false,semanticChatRoles:false});
  assert.equal(result.pipeline_error,undefined);assert.deepEqual(h.seen,[]);
});

test('нельзя включить исправление вне тихого семантического режима',async()=>{
  const h=harness([]);
  await assert.rejects(runAgents({...h.options,silent:false}),/тихом/);
  await assert.rejects(runAgents({...h.options,semanticChatRoles:false}),/тихом/);
  for(const options of [{silent:false,semanticChatRoles:true},{silent:true,semanticChatRoles:false}]){
    let calls=0;await assert.rejects(processDeal({dealId:42,repairProofErrors:true,...options,bitrix:{async request(){calls++;}}}),/тихом/);
    assert.equal(calls,0);
  }
});

test('ручной адаптер передаёт флаг и допускает только два вызова судьи',async()=>{
  const cutoff='2026-11-04T12:00:00.000Z';let judges=0,writers=0,network=0;
  const bitrix={async request(method,body){network++;
    if(method==='crm.deal.userfield.list')return {result:[{LIST:[{ID:'1',VALUE:'Другая'}]}]};
    if(method==='crm.deal.get')return {result:{ID:'42',STAGE_ID:'C23:LOSE',UF_CRM_1584703948317:'1'}};
    if(method==='crm.stagehistory.list')return {result:{items:[{ID:'101',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}]},total:1};
    if(method==='crm.activity.list'||method==='imopenlines.crm.chat.get')return {result:[]};
    if(method==='crm.timeline.comment.list')return {result:[{ID:'10',CREATED:'2026-11-04T11:00:00Z',COMMENT:'Длинная содержательная запись менеджера в CRM'}]};
    if(method==='tasks.task.list')return {result:{tasks:[]}};throw Error('forbidden');
  }};
  const llm={async complete(body,options){
    if(options.role==='judge') { judges++;const j=verdict('f001');j.key_signals[0].proof_type=judges===1?'client_statement':'crm_comment';return response(j); }
    if(options.role==='writer'){writers++;return {usage:usage(1),choices:[{message:{content:'Комментарий'}}]};}throw Error('unexpected');
  }};
  const result=await runManualSessionPilot({dealId:42,expectedHistoryId:'101',expectedLoseDate:cutoff,from:'2026-01-01T00:00:00Z',
    silent:true,semanticChatRoles:true,repairProofErrors:true,bitrix,llm,judgeSystemPrompt:'Судья',writerSystemPrompt:'Писатель',
    audioWaitEnabledAt:'2026-01-01T00:00:00Z',nowMs:Date.parse('2026-11-05T00:00:00Z'),wait:async()=>{}});
  assert.ok(network>0);assert.equal(judges,2);assert.equal(writers,1);assert.equal(result.preliminary.status,'processed');
  assert.equal(result.status,'unverified');assert.equal(result.delivery_permitted,false);
  assert.equal(result.preliminary.analysis.multi_agent_analysis.proof_repair.status,'corrected');
});
