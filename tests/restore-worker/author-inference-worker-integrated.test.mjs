import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createWorkerDependencies} from '../../app/src/worker/dependencies.mjs';
import {runJob} from '../../app/src/worker/run-job.mjs';
import {savePrejudgeArtifact} from '../../app/src/persistence/prejudge.mjs';
import {processDeal} from '../../app/src/process-deal.mjs';

const pglite=resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const jobId='00000000-0000-4000-8000-000000000401', lease='00000000-0000-4000-8000-000000000402';
const cutoff='2026-11-04T11:00:00.000Z';

function serialPool(db){let tail=Promise.resolve();return {async query(q,v){return typeof q==='string'?db.query(q,v):db.query(q.text,q.values);},async connect(){
  const previous=tail;let release;tail=new Promise(r=>{release=r;});await previous;
  return {query(q,v){return typeof q==='string'?db.query(q,v):db.query(q.text,q.values);},release(){release();}};
}};}

async function setup(t,{family='Wappi',trigger='manual',silent=true,mode='ok'}={}){
  const {PGlite}=await import(pathToFileURL(pglite).href),db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.lost_processing_jobs (id uuid PRIMARY KEY,deal_id bigint NOT NULL,lose_date timestamptz NOT NULL,
      request_key text NOT NULL,trigger_type text NOT NULL,status text NOT NULL,lease_token uuid,lease_until timestamptz,
      origin_stage_history_id text,silent boolean NOT NULL,screenshots boolean NOT NULL);
    CREATE TABLE public.lost_audio_wait (deal_id bigint,lose_date timestamptz,origin_stage_history_id text,state text,next_check_at timestamptz);`);
  await db.exec(readFileSync('db/proposals/20261109_prejudge_artifacts.sql','utf8'));
  await db.exec(readFileSync('db/proposals/worker-migration-fixtures/20261111094500_lost_role_inference_ledger.sql','utf8'));
  const requestKey=trigger==='live'?'bitrix24:deal-stage-history:101':`${trigger}:42`;
  await db.query("INSERT INTO public.lost_processing_jobs VALUES ($1,42,$3,$4,$5,'processing',$2,clock_timestamp()+interval '1 hour',NULL,$6,false)",
    [jobId,lease,cutoff,requestKey,trigger,silent]);
  const code=family==='Wappi'?'opaque':'wz_test';
  const chat={CHAT_ID:1,CONNECTOR_ID:code,CONNECTOR_TITLE:family};
  const history={chatId:1,sessionId:2,chat:{1:{entityId:`${code}|9|client|user`}},users:{55:{}},files:{},
    message:{50:{id:50,senderid:55,date:'2026-11-04T10:00:00.000Z',
      text:'Здравствуйте, я купил окна в другом месте и больше не планирую заказ.'}}};
  const events=[];
  const judge={verdict:'правомерен',verdict_reason_short:'Клиент отказался',recoverable_level:null,
    closure_reason_class:'competitor',misplaced:false,correct_stage:null,exact_reason:'Клиент купил в другом месте',
    manager_mistakes:[],key_signals:[],risk_factors:[],questions_for_manager:[]};
  const fetchImpl=async(url,opts)=>{
    const target=new URL(url),body=JSON.parse(opts.body||'{}');
    if(target.hostname==='api.polza.ai'){
      if(body?.response_format?.json_schema?.name==='chat_roles'){
        events.push('roles');const row=await db.query("SELECT state FROM public.lost_role_inference_attempts");
        assert.equal(row.rows.length,1);assert.equal(row.rows[0].state,'reserved');
        assert.equal((await db.query("SELECT count(*)::int AS n FROM public.lost_prejudge_artifacts WHERE artifact_type='communications'")).rows[0].n,1);
        if(mode==='unknown')throw Error('неизвестный исход');
        const messages=JSON.parse(body.messages[1].content).messages;
        return new Response(JSON.stringify({model:'openai/gpt-6-sol',usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5},
          choices:[{finish_reason:'stop',message:{content:JSON.stringify({roles:messages.map(x=>({id:x.id,role:'client',impact:'not_applicable'}))})}}]}),{status:200});
      }
      events.push('judge');assert.equal((await db.query("SELECT count(*)::int AS n FROM public.lost_prejudge_artifacts WHERE artifact_type='judge_input'")).rows[0].n,1);
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(judge)}}]}),{status:200});
    }
    const method=target.pathname.split('/').pop().replace(/\.json$/,'');let result;
    if(method==='crm.deal.userfield.list')result=[{LIST:[{ID:'1',VALUE:'Другая'}]}];
    else if(method==='crm.deal.get')result={ID:'42',STAGE_ID:'C23:LOSE',ASSIGNED_BY_ID:'65',UF_CRM_1584703948317:'1'};
    else if(method==='crm.stagehistory.list')result={items:[{ID:'101',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}]};
    else if(method==='imopenlines.crm.chat.get')result=mode==='no-chat'?[]:[structuredClone(chat)];
    else if(method==='crm.activity.list' && body.filter?.PROVIDER_ID==='IMOPENLINES_SESSION')result=mode==='no-chat'?[]:[{ASSOCIATED_ENTITY_ID:'2'}];
    else if(method==='crm.activity.list')result=[];
    else if(method==='imopenlines.session.history.get')result=structuredClone(history);
    else if(method==='imopenlines.v2.Session.list')result={sessions:[{id:2,chatId:1,configId:9,crmEntityType:'deal',
      crmEntityId:'42',dateCreate:'2026-11-01T00:00:00.000Z'}],hasNextPage:false};
    else if(method==='crm.timeline.comment.list')result=[];
    else if(method==='tasks.task.list')result={tasks:[]};
    else throw Error('Запрещённый метод');
    return new Response(JSON.stringify({result}),{status:200});
  };
  const pool=serialPool(db);let captured;
  createWorkerDependencies({pool,bitrixBaseUrl:'https://example.invalid/rest/1/fixture/',polzaKey:'fixture',
    sttUrl:'http://127.0.0.1:8790',sttKey:'fixture',tempRoot:resolve('tmp'),judgePrompt:'Судья',writerPrompt:'Писатель',
    fetchImpl,makePump:args=>{captured=args;return {};}});
  let saved;
  const queue={async renew(){return true;},async finishObsoleteNightly(){return false;},async bindRetryTransition(input){
    const row=await db.query("UPDATE public.lost_processing_jobs SET origin_stage_history_id=$2 WHERE id=$1 AND (origin_stage_history_id IS NULL OR origin_stage_history_id=$2) RETURNING id",[jobId,input.stageHistoryId]);return row.rowCount===1;}};
  const store={async loadResumableResult(){return null;},async hasUnsafePrejudgeResume(){return false;},
    async savePrejudgeArtifact(args){return savePrejudgeArtifact(pool,args);},async hasPrejudgeArtifacts(){return false;},
    async markPrejudgeNeedsReview(){return true;},async claimSttAttempt(){throw Error('unexpected STT');},
    async completeSttAttempt(){throw Error('unexpected STT');},async persistResult(result){saved=result;return {status:result._status,needsExternalActions:false};}};
  const job={id:jobId,lease_token:lease,deal_id:42,lose_date:mode==='pg-timestamp' ? cutoff.replace('.000Z','.000000Z') : cutoff,
    request_key:requestKey,trigger_type:trigger,silent,screenshots:false};
  const run=()=>runJob({job,queue,store,loadAudioWait:async()=>null,createRoleInference:captured.createRoleInference,
    ...(mode==='missing-metadata' ? {process:async options=>({...await processDeal(options),chatRoleInferenceMetadata:undefined,
      chatRoleInferenceUnaccounted:true})} : {}),
    processOptions:{...captured.processOptions,audioWaitEnabledAt:'2026-11-01T00:00:00.000Z',nowMs:Date.parse('2026-11-05T00:00:00Z'),wait:async()=>{}},
    delivery:()=>{throw Error('delivery must not be called');}});
  return {db,run,events,get saved(){return saved;}};
}

for(const [family,trigger] of [['Wappi','manual'],['Wazzup','live']])test(`штатная тихая связка ${family}/${trigger}: staging → ledger → роли → судья`,{skip:!existsSync(pglite)},async t=>{
 const h=await setup(t,{family,trigger}),result=await h.run();
 assert.equal(result.status,'processed');assert.deepEqual(h.events,['roles','judge']);
 assert.equal((await h.db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'settled');
 assert.equal(h.saved.multi_agent_analysis.role_inference.model_calls,1);
 assert.equal(h.saved.role_origin_stage_history_id,'101');
 assert.ok(h.saved.multi_agent_analysis.facts_packet.facts.some(f=>f.role_source==='semantic_inference'));
});

for(const family of ['Wappi','Wazzup']) test(`обычное задание ${family} сохраняет проверенное авторство без реальной доставки`,{skip:!existsSync(pglite)},async t=>{
 const h=await setup(t,{family,trigger:'live',silent:false}),result=await h.run();
 assert.equal(result.status,'processed');assert.deepEqual(h.events,['roles','judge']);
 assert.equal((await h.db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'settled');
 assert.equal(h.saved.multi_agent_analysis.role_inference.model_calls,1);
 assert.ok(h.saved.multi_agent_analysis.facts_packet.facts.some(f=>f.role_source==='semantic_inference'));
});
test('обычное задание принимает точную дату PostgreSQL с шестью знаками',{skip:!existsSync(pglite)},async t=>{
 const h=await setup(t,{family:'Wazzup',trigger:'live',silent:false,mode:'pg-timestamp'}),result=await h.run();
 assert.equal(result.status,'processed');assert.deepEqual(h.events,['roles','judge']);
});

test('неизвестный исход роли не вызывает повтор и не выдаёт вердикт',{skip:!existsSync(pglite)},async t=>{
 const h=await setup(t,{mode:'unknown'}),result=await h.run();
 assert.equal(result.status,'error');assert.deepEqual(h.events,['roles']);
 assert.equal((await h.db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'unknown');
});

test('неподтверждённое происхождение роли не сохраняется как успешный вердикт',{skip:!existsSync(pglite)},async t=>{
 const h=await setup(t,{mode:'missing-metadata'}),result=await h.run();
 assert.equal(result.status,'error');assert.deepEqual(h.events,['roles','judge']);
 assert.equal(h.saved._status,'error');assert.equal(h.saved.role_inference_unaccounted,true);
 assert.equal(Object.hasOwn(h.saved,'classification'),false);
});

test('при отсутствии переписки связка не вызывает определение автора и обрабатывает обычную сделку',{skip:!existsSync(pglite)},async t=>{
 const h=await setup(t,{mode:'no-chat'}),result=await h.run();
 assert.equal(result.status,'processed');assert.deepEqual(h.events,[]);
 assert.equal((await h.db.query('SELECT count(*)::int AS n FROM public.lost_role_inference_attempts')).rows[0].n,0);
});
