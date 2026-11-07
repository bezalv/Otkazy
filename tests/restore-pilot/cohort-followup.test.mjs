import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { matchRawTargets, runFollowup } from '../../app/src/pilot/cohort-followup.mjs';
import { sealEvidenceReport } from '../../app/src/pilot/evidence-review.mjs';

const times=['2026-10-28T02:32:51.000Z','2026-10-28T02:47:17.000Z','2026-10-28T04:58:53.000Z'];
const msgs=['Мы можем в вашем случае предложить только заменить полностью конструкцию.','Сможем озвучить после замера. Удобно будет принять специалиста?','Не надо менять окно. Варианты у нас есть уже'];
function collection(){return {_status:'pending_normalization',deal_data:{lose_date:'2026-10-28T05:35:03.000Z'},_sources:{openlines:{complete:true}},
  raw:{chats:[{CHAT_ID:45,CONNECTOR_ID:'wz_x'}],sessions:[{session_id:44,history:{chat:{45:{}},users:{'7':{connector:true},'8':{extranet:false}},message:{
    '1':{id:1,date:times[0],senderid:7,text:msgs[0]},'2':{id:2,date:times[1],senderid:8,text:msgs[1]},'3':{id:3,date:times[2],senderid:7,text:msgs[2]}}}}]}};}
test('raw сопоставляет дату и текст, показывает основания роли, но не утверждает историческую идентичность',()=>{
  const x=matchRawTargets(collection());assert.equal(x.complete,true);assert.equal(x.sessions_scanned,1);assert.deepEqual(x.targets.map(t=>t.status),['matched','matched','matched']);
  assert.equal(x.targets[0].candidates[0].assigned_role,'client');assert.equal(x.targets[0].candidates[0].sender_lookup,'matched');
  assert.equal(x.targets[1].candidates[0].assigned_role,'manager');assert.ok(x.limitations.includes('timestamp_and_text_do_not_prove_historical_identity'));
});
test('отсутствие совпадения по тексту/дате и несколько совпадений не становятся подтверждённым автором',()=>{
  const x=collection();x.raw.sessions[0].history.message['1'].text='Иное содержание';x.raw.sessions[0].history.message['2'].date=times[0];
  const r=matchRawTargets(x);assert.equal(r.complete,false);assert.deepEqual(r.targets.map(t=>t.status),['not_found','not_found','matched']);
  const y=collection();y.raw.sessions[0].history.message['4']={id:4,date:times[0],senderid:7,text:msgs[0]};
  assert.equal(matchRawTargets(y).targets[0].status,'ambiguous');
  y._sources.openlines.complete=false;assert.equal(matchRawTargets(y).complete,false);
});
test('raw вызывает только закреплённую сделку, silent и закрывает limiter',async()=>{
  let closed=false;
  const x=await runFollowup({dealId:'127114',analysisId:'raw',env:{BITRIX_REST_BASE:'https://dinalnsk.bitrix24.ru/rest/1/test'},
    makeLimiter:()=>({close(){closed=true;}}),makeClient:()=>({request(){throw new Error('unexpected');}}),
    collect:async args=>{assert.equal(args.dealId,127114);assert.equal(args.silent,true);assert.equal(args.requireCurrentHistory,true);
      assert.throws(()=>args.client.request('crm.timeline.comment.add',{}));return collection();}});
  assert.equal(x.status,'observed');assert.equal(x.service_closed,true);assert.equal(closed,true);assert.equal(x.detail.targets.length,3);
});
const selected=[['126520','1939'],['126936','1949'],['126548','1992'],['126276','1979'],['123941','1976']];
const fact={fact_id:'f001',source:'call_transcript',actor:'client',ts:'2026-10-01T00:00:00Z',content:'Я уже договорилась, всё меня устраивает.'};
const judge={verdict:'правомерен',closure_reason_class:'competitor',exact_reason:'Прямые слова клиента',manager_mistakes:[],key_signals:[],risk_factors:[]};
test('пять закреплённых пар: только silent, нужный эталон, read-only, полный контекст только в ограниченном ответе',async()=>{
  for(const [dealId,analysisId] of selected){
    const packet={facts:[fact],metrics:{cutoff_at:'2026-10-02T00:00:00.000Z'}};
    const baseline={deal_id:Number(dealId),analysis_id:analysisId,pipeline_error:null,lose_date:'2026-10-02T00:00:00.000Z',ai_facts_json:packet,
      ai_judge_json:judge,ai_verdict:'правомерен',ai_reason_class:'competitor',audio_wait_enabled_at:'2020-01-01T00:00:00Z'};
    const readBaselines=async()=>({baselines:[baseline]});
    const processFn=async args=>{assert.equal(args.silent,true);assert.equal(args.dealId,Number(dealId));assert.throws(()=>args.bitrix.request('crm.deal.update',{}));
      return {status:'processed',analysis:{multi_agent_analysis:{...judge,facts_packet:packet}}};};
    const runCommand=async options=>{const b=await options.readBaselines({},{});const runner=options.makeRunner({bitrix:{request:async()=>({result:[]})},
      llm:{},transcribe:()=>{},downloadFile:()=>{},judgeSystemPrompt:'judge',writerSystemPrompt:'writer'});
      const result=await runner.run({dealId:Number(dealId),baseline:b.baselines[0],screenshots:true});
      assert.equal(result.status,'processed');return {selected:1,attempted:1,statuses:{processed:1},service_closed:true};};
    const out=await runFollowup({dealId,analysisId,runCommand,readBaselines,processFn,env:{}});assert.equal(out.status,'processed');assert.equal(out.service_closed,true);
    assert.equal(out.diagnostic.category,'none');assert.equal(out.detail.semantic.current.available,true);
    if(['126520','126936'].includes(dealId))assert.equal(out.detail.targeted.facts[0].content,fact.content);else assert.equal(out.detail.targeted,null);
  }
});
test('blocked выдаёт только whitelist диагностику; неподтверждённый shutdown не выдаёт marker',async()=>{
  const baseline={deal_id:126548,analysis_id:'1992',pipeline_error:null,lose_date:'2026-10-02T00:00:00.000Z'};
  const readBaselines=async()=>({baselines:[baseline]});
  const runCommand=async options=>{const b=await options.readBaselines({},{});const runner=options.makeRunner({bitrix:{request:async()=>({result:[]})}});
    const result=await runner.run({dealId:126548,baseline:b.baselines[0],screenshots:true});assert.equal(result.status,'blocked');
    return {selected:1,attempted:1,statuses:{blocked:1},service_closed:true};};
  const out=await runFollowup({dealId:'126548',analysisId:'1992',readBaselines,runCommand,env:{},processFn:async()=>({status:'blocked',pipelineGate:{kind:'recognition',failures:[{kind:'звонок',error:'SECRET'}]}})});
  assert.equal(out.status,'blocked');assert.equal(out.diagnostic.category,'recognition');assert.equal(out.diagnostic.recognition_failures.calls,1);
  assert.doesNotMatch(JSON.stringify(out),/SECRET/);
  await assert.rejects(()=>runFollowup({dealId:'126548',analysisId:'1992',env:{},runCommand:async()=>({service_closed:false})}));
});
test('неизвестные пары и ключ не проходят до внешних вызовов; данные передаются только sealed',async()=>{
  let used=false;await assert.rejects(()=>runFollowup({dealId:'999',analysisId:'raw',collect:()=>{used=true;}}));assert.equal(used,false);
  const path=fileURLToPath(new URL('../../app/src/pilot/cohort-followup.mjs',import.meta.url));
  const cli=spawnSync(process.execPath,[path,'127114','raw','--sealed','wrong'],{encoding:'utf8'});assert.notEqual(cli.status,0);assert.equal(cli.stdout,'');
  const pair=generateKeyPairSync('rsa',{modulusLength:2048});const pub=Buffer.from(pair.publicKey.export({type:'spki',format:'pem'})).toString('base64');
  const sealed=sealEvidenceReport({status:'observed',detail:matchRawTargets(collection()),service_closed:true},pub);
  assert.doesNotMatch(JSON.stringify(sealed),/заменить полностью конструкцию/);
});
test('увеличенный отчёт целевого случая укладывается в лимит sealed',async()=>{
  const dealId='126520',analysisId='1939';
  const facts=Array.from({length:30},(_,i)=>({fact_id:'f'+String(i+1).padStart(3,'0'),source:i<6?'call_transcript':'crm_comment',actor:i%2?'manager':'client',
    ts:'2026-10-01T00:00:00Z',content:'滿'.repeat(3000)}));
  const huge={...judge,exact_reason:'滿'.repeat(3000),manager_mistakes:Array.from({length:20},()=>({mistake:'滿'.repeat(400),proof_type:'client_statement',proof_fact_ids:['f001','f002','f003','f004']}))};
  const packet={facts,metrics:{cutoff_at:'2026-10-02T00:00:00.000Z'}};
  const baseline={deal_id:Number(dealId),analysis_id:analysisId,pipeline_error:null,lose_date:'2026-10-02T00:00:00.000Z',ai_facts_json:packet,
    ai_judge_json:huge,ai_verdict:'правомерен',ai_reason_class:'competitor',audio_wait_enabled_at:'2020-01-01T00:00:00Z'};
  const readBaselines=async()=>({baselines:[baseline]});
  const runCommand=async options=>{const b=await options.readBaselines({},{});const runner=options.makeRunner({bitrix:{request:async()=>({result:[]})}});
    await runner.run({dealId:Number(dealId),baseline:b.baselines[0],screenshots:true});return {selected:1,attempted:1,statuses:{processed:1},service_closed:true};};
  const out=await runFollowup({dealId,analysisId,readBaselines,runCommand,env:{},processFn:async()=>({status:'processed',analysis:{multi_agent_analysis:{...huge,facts_packet:packet}}})});
  const pair=generateKeyPairSync('rsa',{modulusLength:2048});const pub=Buffer.from(pair.publicKey.export({type:'spki',format:'pem'})).toString('base64');
  const sealed=sealEvidenceReport(out,pub);assert.ok(JSON.stringify(sealed).length<1000000);
});
test('слишком длинный целевой факт явно скрыт и не нарушает ограниченную схему',async()=>{
  const dealId='126520',analysisId='1939',long={...fact,content:'Я'.repeat(500001)};
  const packet={facts:[long],metrics:{cutoff_at:'2026-10-02T00:00:00.000Z'}};
  const baseline={deal_id:Number(dealId),analysis_id:analysisId,pipeline_error:null,lose_date:'2026-10-02T00:00:00.000Z',ai_facts_json:packet,
    ai_judge_json:judge,ai_verdict:'правомерен',ai_reason_class:'competitor'};
  const readBaselines=async()=>({baselines:[baseline]});
  const runCommand=async options=>{const b=await options.readBaselines({},{});const runner=options.makeRunner({bitrix:{request:async()=>({result:[]})}});
    await runner.run({dealId:Number(dealId),baseline:b.baselines[0],screenshots:true});return {selected:1,attempted:1,statuses:{processed:1},service_closed:true};};
  const out=await runFollowup({dealId,analysisId,readBaselines,runCommand,env:{},processFn:async()=>({status:'processed',analysis:{multi_agent_analysis:{...judge,facts_packet:packet}}})});
  const shown=out.detail.targeted.facts[0];assert.equal(shown.content,null);assert.equal(shown.content_length,null);assert.equal(shown.truncated,true);
});
test('расширение текста при NFKC корректно помечает сокращение целевого факта',async()=>{
  const dealId='126520',analysisId='1939',long={...fact,content:'ﬃ '.repeat(600)};
  const packet={facts:[long],metrics:{cutoff_at:'2026-10-02T00:00:00.000Z'}};
  const baseline={deal_id:Number(dealId),analysis_id:analysisId,pipeline_error:null,lose_date:'2026-10-02T00:00:00.000Z',ai_facts_json:packet,
    ai_judge_json:judge,ai_verdict:'правомерен',ai_reason_class:'competitor'};
  const readBaselines=async()=>({baselines:[baseline]});
  const runCommand=async options=>{const b=await options.readBaselines({},{});const runner=options.makeRunner({bitrix:{request:async()=>({result:[]})}});
    await runner.run({dealId:Number(dealId),baseline:b.baselines[0],screenshots:true});return {selected:1,attempted:1,statuses:{processed:1},service_closed:true};};
  const out=await runFollowup({dealId,analysisId,readBaselines,runCommand,env:{},processFn:async()=>({status:'processed',analysis:{multi_agent_analysis:{...judge,facts_packet:packet}}})});
  const shown=out.detail.targeted.facts[0];assert.equal(shown.content_length,2399);assert.equal(shown.content.length,1200);assert.equal(shown.truncated,true);
});
