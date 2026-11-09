import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runJob } from '../../app/src/worker/run-job.mjs';
import { processDeal } from '../../app/src/process-deal.mjs';
import { createRoleSessionContext } from '../../app/src/worker/role-session-context.mjs';
import { createRoleInferenceLedger } from '../../app/src/worker/role-inference-ledger.mjs';
import { createDurableRoleClient } from '../../app/src/worker/durable-role-client.mjs';
import { createPolzaRoleInferenceClient } from '../../app/src/polza-client.mjs';
import { sanitizeRoleInferenceMetadata } from '../../app/src/worker/role-inference-metadata.mjs';

// Изолированная композиция через тестовую инъекцию process. Рабочий runJob
// не подключает эту возможность и запрещает semanticChatRoles в processOptions.
// Fake Bitrix и fake fetch не имеют доступа к сети или настоящим ключам.
const pglite = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const enabled = { skip: !existsSync(pglite) };
const cutoff = '2026-11-04T12:00:00.000Z';
const jobId = '00000000-0000-4000-8000-000000000001';
const secondJobId = '00000000-0000-4000-8000-000000000004';
const leaseToken = '00000000-0000-4000-8000-000000000002';

function serialPool(db, events, options) {
  let tail = Promise.resolve(), commits = 0;
  return { async connect() {
    const previous = tail; let unlock;
    tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    return { async query(sql, args) {
      if (/^COMMIT\b/i.test(sql) && options.lostCommit && ++commits === 1) {
        await db.query(sql, args); events.push('commit-unknown'); throw Error('synthetic lost commit');
      }
      const result = await db.query(sql, args);
      if (sql.includes('INSERT INTO public.lost_role_inference_attempts') && result.rows.length) events.push('reserve');
      if (sql.includes('UPDATE public.lost_role_inference_attempts') && result.rows.length) events.push(`finish:${args[4]}`);
      return result;
    }, release() { unlock(); } };
  } };
}

async function harness(t, { family = 'Wazzup', mode = 'ok' } = {}) {
  const { PGlite } = await import(pathToFileURL(pglite).href);
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE public.lost_processing_jobs (
    id uuid PRIMARY KEY, deal_id bigint NOT NULL, lose_date timestamptz NOT NULL,
    request_key text NOT NULL, trigger_type text NOT NULL, status text NOT NULL,
    lease_token uuid, lease_until timestamptz);
    CREATE TABLE public.lost_role_inference_scopes (
      deal_id bigint NOT NULL, stage_history_id text NOT NULL CHECK(stage_history_id ~ '^[1-9][0-9]{0,29}$'),
      PRIMARY KEY(deal_id,stage_history_id));
    CREATE TABLE public.lost_role_inference_attempts (
      job_id uuid NOT NULL REFERENCES public.lost_processing_jobs(id),
      attempt_no smallint NOT NULL CHECK(attempt_no BETWEEN 1 AND 3),
      deal_id bigint NOT NULL, stage_history_id text NOT NULL, lease_token uuid NOT NULL,
      run_id uuid NOT NULL, state text NOT NULL CHECK(state IN ('reserved','settled','unknown')),
      created_at timestamptz NOT NULL, finished_at timestamptz,
      CHECK((state='reserved' AND finished_at IS NULL) OR (state IN ('settled','unknown') AND finished_at IS NOT NULL)),
      PRIMARY KEY(job_id,attempt_no), FOREIGN KEY(deal_id,stage_history_id)
        REFERENCES public.lost_role_inference_scopes(deal_id,stage_history_id));`);
  const events = [], saved = [], outcomes = []; let sent = 0, judgeCalls = 0, deliveries = 0;
  const requestKey = 'bitrix24:deal-stage-history:101';
  await db.query(`INSERT INTO public.lost_processing_jobs VALUES
    ($1,42,$3,$4,'live','processing',$2,clock_timestamp()+interval '1 hour'),
    ($5,42,$3,$4,'live','processing',$2,clock_timestamp()+interval '1 hour')`,
  [jobId,leaseToken,cutoff,requestKey,secondJobId]);
  const pool = serialPool(db,events,{lostCommit:mode==='lost-commit'});
  const code = family === 'Wappi' ? 'opaque' : 'wz_test';
  const chat = {CHAT_ID:1,CONNECTOR_ID:code,CONNECTOR_TITLE:family};
  const history = {chatId:1,sessionId:2,chat:{1:{entityId:`${code}|9|client|user`}},
    users:{55:family === 'Wappi' ? {} : {connector:true}}, files:{},
    message:{50:{id:50,senderid:55,date:'2026-11-04T10:00:00Z',text:'Здравствуйте, стоимость предложения слишком высокая, я уже заказал в другом месте.'}}};
  if (mode === 'anchor-conflict') {
    history.message = {
      49:{id:49,senderid:55,date:'2026-11-04T09:59:00Z',text:'=== Исходящее сообщение ===\nМожем предложить замену окна.'},
      ...history.message,
    };
  }
  const bitrix = {async request(method, body = {}) {
    if (method === 'crm.deal.userfield.list') return {result:[{LIST:[{ID:'1',VALUE:'Другая'}]}]};
    if (method === 'crm.deal.get') return {result:{ID:'42',STAGE_ID:'C23:LOSE',ASSIGNED_BY_ID:'65',UF_CRM_1584703948317:'1'}};
    if (method === 'crm.stagehistory.list') return {result:{items:[{ID:mode==='bad-stage'?'102':'101',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}]}};
    if (method === 'imopenlines.crm.chat.get') return {result:[structuredClone(chat)]};
    if (method === 'crm.activity.list' && body.filter?.PROVIDER_ID === 'IMOPENLINES_SESSION') return {result:[{ASSOCIATED_ENTITY_ID:'2'}]};
    if (method === 'crm.activity.list') return {result:[]};
    if (method === 'imopenlines.session.history.get') return {result:structuredClone(history)};
    if (method === 'imopenlines.v2.Session.list') return {result:{sessions:[{id:2,chatId:1,configId:9,crmEntityType:'deal',
      crmEntityId:mode==='wrong-session'?'43':'42',dateCreate:'2026-11-01T00:00:00.000Z'}],hasNextPage:false}};
    if (method === 'crm.timeline.comment.list') return {result:[]};
    if (method === 'tasks.task.list') return {result:{tasks:[]}};
    throw Error(`Unexpected mock Bitrix method: ${method}`);
  }};
  const fakeFetch = async (_url, opts) => {
    const recorded=await db.query('SELECT state FROM public.lost_role_inference_attempts');
    assert.equal(recorded.rows.length,1);assert.equal(recorded.rows[0].state,'reserved');
    sent++; events.push('POST');
    if (mode === 'timeout') throw Error('synthetic timeout');
    const input = JSON.parse(JSON.parse(opts.body).messages[1].content).messages;
    const roles = input.map(x=>({id: mode==='malformed'?'bad-id':x.id,role:'client',impact:'not_applicable'}));
    return new Response(JSON.stringify({model:'openai/gpt-6-sol',usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5},
      choices:[{finish_reason:'stop',message:{content:JSON.stringify({roles})}}]}),{status:200,headers:{'content-type':'application/json'}});
  };
  const transport = createPolzaRoleInferenceClient({apiKey:'test-only',fetchImpl:fakeFetch});
  const judge = {verdict:'правомерен',verdict_reason_short:'Клиент отказался',recoverable_level:null,
    closure_reason_class:'competitor',misplaced:false,correct_stage:null,exact_reason:'Клиент отказался от предложения.',
    manager_mistakes:[],key_signals:[],risk_factors:[],questions_for_manager:[]};
  const queue = {async finishObsoleteNightly(){return false;}, async renew(id,lease) {
    if(mode==='lease-lost')return false;
    return (await db.query("SELECT EXISTS (SELECT 1 FROM public.lost_processing_jobs WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()) AS ok",[id,lease])).rows[0].ok;
  }};
  const store = {async loadResumableResult(){return null;},async persistResult(value){
    events.push('save'); saved.push(value); return {status:value._status,needsExternalActions:false};
  }};
  const delivery = async()=>{deliveries++;throw Error('delivery is prohibited in this test');};
  async function run(id = jobId) {
    const trigger=mode==='manual-no-id'?'manual':mode==='nightly-no-id'?'nightly':'live';
    const job={id,lease_token:leaseToken,deal_id:42,lose_date:cutoff,trigger_type:trigger,
      request_key:trigger==='live'?requestKey:`${trigger}:42`,silent:true,screenshots:false};
    const sessionContext=createRoleSessionContext({client:bitrix,dealId:'42',transitionId:'101',cutoff,from:'2026-10-01T00:00:00.000Z'});
    const ledger=createRoleInferenceLedger(pool,{jobId:id,leaseToken,dealId:'42',stageHistoryId:'101',cutoff});
    const roleTransport=mode==='snapshot-throws'
      ? {complete:(...args)=>transport.complete(...args),failClosed:()=>transport.failClosed(),snapshot(){throw Error('SECRET_SNAPSHOT');}}
      : transport;
    const roleClient=createDurableRoleClient({ledger,sessionContext,transport:roleTransport,checkLease:async()=>{
      if(mode==='lease-on-send')await db.query("UPDATE public.lost_processing_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
      const r=await db.query("SELECT EXISTS (SELECT 1 FROM public.lost_processing_jobs WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()) AS ok",[id,leaseToken]);
      if(!r.rows[0].ok) throw Error('lease lost');
    }});
    const llm={requireVerifiedSession:true,complete:async(body,opts)=>{
      if(opts.role==='chat-role-inference')return roleClient.complete(body,opts);
      if(opts.role==='judge'){judgeCalls++;events.push('judge');if(mode==='judge-throws')throw Error('SECRET_JUDGE');return {choices:[{message:{content:JSON.stringify(judge)}}]};}
      if(opts.role==='writer'){events.push('writer');return {choices:[{message:{content:'Тестовый разбор.'}}]};}
      throw Error('Unexpected mock model');
    },confirmValidated:()=>roleClient.confirmValidated(),failClosed:()=>roleClient.failClosed()};
    // Внедрение только в тесте: рабочий runJob не принимает эти настройки.
    const process = async opts=>{
      const outcome=await processDeal({...opts,bitrix,llm,semanticChatRoles:true,verifyFallbackSession:sessionContext.verify,
        ...(mode==='no-snapshot'?{}:{roleInferenceClient:roleClient}),
        nowMs:Date.parse('2026-11-05T00:00:00Z'),wait:async()=>{},judgeSystemPrompt:'Тестовый судья',writerSystemPrompt:'Тестовый писатель',
        audioWaitEnabledAt:'2026-11-01T00:00:00.000Z'});
      if(mode==='tamper-meta' && outcome.chatRoleInferenceMetadata)outcome.chatRoleInferenceMetadata.private='SECRET_META';
      if(mode==='tamper-analysis')outcome.analysis.multi_agent_analysis.role_inference={private:'SECRET_META'};
      if(mode==='cross-job-meta'){
        const other=createRoleInferenceLedger(pool,{jobId:secondJobId,leaseToken,dealId:'42',stageHistoryId:'101',cutoff});
        outcome.chatRoleInferenceMetadata=sanitizeRoleInferenceMetadata(outcome.chatRoleInferenceStats,transport.snapshot(),outcome.chatRoleInferenceEvidence,{ledger:other});
      }
      outcomes.push(outcome);return outcome;
    };
    const result=await runJob({job,queue,store,loadAudioWait:async()=>null,delivery,process});
    return {result,roleClient};
  }
  return {run,db,events,saved,outcomes,transport,get sent(){return sent;},get judgeCalls(){return judgeCalls;},get deliveries(){return deliveries;}};
}

test('изолированная связка Wazzup/Wappi: резерв → POST → проверка → сохранение без доставки',enabled,async t=>{
  for(const family of ['Wazzup','Wappi']) {
    const h=await harness(t,{family}), {result}=await h.run();
    assert.equal(result.status,'processed',family);assert.equal(h.sent,1);assert.equal(h.judgeCalls,1);assert.equal(h.deliveries,0);
    assert.ok(h.events.indexOf('reserve') < h.events.indexOf('POST'));
    assert.ok(h.events.indexOf('POST') < h.events.indexOf('finish:settled'));
    assert.ok(h.events.indexOf('finish:settled') < h.events.indexOf('judge'));
    assert.ok(h.events.indexOf('judge') < h.events.indexOf('save'));
    assert.equal((await h.db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'settled');
    const outcome=h.outcomes[0], evidence=outcome.chatRoleInferenceEvidence;
    assert.equal(outcome.chatRoleInferenceStats.resolved,1);
    assert.ok(outcome.analysis.multi_agent_analysis.facts_packet.facts.some(f=>f.role_source==='semantic_inference'));
    const safe=sanitizeRoleInferenceMetadata(outcome.chatRoleInferenceStats,h.transport.snapshot(),evidence);
    assert.ok(safe);assert.doesNotMatch(JSON.stringify(safe),/стоимость предложения|test-only/);
    const persisted=h.saved[0].multi_agent_analysis.role_inference;
    assert.equal(persisted.physical_requests_started,1);assert.equal(persisted.cost_rub,null);
    assert.equal(persisted.evidence_for_model_calls_complete,true);
    assert.equal(h.saved[0].llm_meta.total_tokens,null);assert.equal(h.saved[0].llm_meta.usage_complete,false);
    assert.doesNotMatch(JSON.stringify(persisted),/стоимость предложения|test-only/);
    assert.equal(Object.hasOwn(h.saved[0],'chatRoleInferenceStats'),false);
    assert.equal(Object.hasOwn(h.saved[0],'chatRoleInferenceEvidence'),false);
  }
});

test('неподтверждённая сессия и чужой переход не вызывают модель',enabled,async t=>{
  for(const mode of ['wrong-session','bad-stage']) {
    const h=await harness(t,{mode});await h.run();
    assert.equal(h.sent,0,mode);assert.equal(h.judgeCalls,0,mode);assert.equal(h.deliveries,0,mode);
  }
});

test('таймаут, неверная схема и конфликт якоря не запускают судью или повтор другого задания',enabled,async t=>{
  for(const mode of ['timeout','malformed','anchor-conflict']) {
    const h=await harness(t,{mode});await h.run();
    assert.equal(h.sent,1,mode);assert.equal(h.judgeCalls,0,mode);assert.equal(h.deliveries,0,mode);
    assert.equal((await h.db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'unknown',mode);
    const metadata=h.saved[0].role_inference_metadata;
    assert.ok(metadata);assert.equal(metadata.cost_rub,null);assert.equal(metadata.usage,null);
    assert.equal(metadata.evidence_for_model_calls_complete,false);
    await h.run(secondJobId);assert.equal(h.sent,1,mode);assert.equal(h.judgeCalls,0,mode);
  }
});

test('ошибка судьи сохраняет безопасную статистику ролей без вердикта и текста',enabled,async t=>{
  const h=await harness(t,{mode:'judge-throws'});const {result}=await h.run();
  assert.equal(result.status,'error');assert.equal(h.sent,1);assert.equal(h.judgeCalls,1);assert.equal(h.deliveries,0);
  const saved=h.saved[0];assert.equal(saved.role_inference_metadata.physical_requests_started,1);
  assert.equal(saved.role_inference_metadata.cost_rub,null);
  assert.equal(Object.hasOwn(saved,'classification'),false);
  assert.doesNotMatch(JSON.stringify(saved),/SECRET_JUDGE|стоимость предложения|test-only/);
});

test('подменённая метаинформация исключается из сохранения',enabled,async t=>{
  for (const mode of ['tamper-meta','tamper-analysis','cross-job-meta']) {
    const h=await harness(t,{mode});await h.run();
    assert.equal(h.sent,1);assert.equal(h.judgeCalls,1);assert.equal(h.deliveries,0);
    if(mode!=='tamper-analysis')assert.equal(h.saved[0].multi_agent_analysis.role_inference,undefined);
    assert.doesNotMatch(JSON.stringify(h.saved),/SECRET_META/);
  }
});

test('вызов ролей без доверенного снимка не выдаёт сумму за известную',enabled,async t=>{
  for(const mode of ['no-snapshot','snapshot-throws']) {
    const h=await harness(t,{mode});const {result}=await h.run();
    assert.equal(result.status,'processed');assert.equal(h.sent,1);assert.equal(h.judgeCalls,1);
    assert.equal(h.saved[0].role_inference_unaccounted,true);
    assert.equal(h.saved[0].multi_agent_analysis.role_inference_unaccounted,true);
    assert.equal(h.saved[0].llm_meta.usage_complete,false);assert.equal(h.saved[0].llm_meta.total_tokens,null);
    assert.equal(h.saved[0].llm_meta.judge_usage_complete,false);
    assert.equal(h.saved[0].multi_agent_analysis.role_inference,undefined);
    assert.doesNotMatch(JSON.stringify(h.saved),/SECRET_SNAPSHOT/);
  }
});

test('потеря аренды непосредственно перед POST не отправляет модель и не сохраняет результат',enabled,async t=>{
  const h=await harness(t,{mode:'lease-on-send'});
  await assert.rejects(h.run(),/Аренда задания потеряна/);
  assert.equal(h.sent,0);assert.equal(h.judgeCalls,0);assert.equal(h.saved.length,0);assert.equal(h.deliveries,0);
  assert.equal((await h.db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'reserved');
});

test('неизвестный COMMIT резерва не отправляет данные и сохраняет блокировку для другого задания',enabled,async t=>{
  const h=await harness(t,{mode:'lost-commit'});await h.run();
  assert.equal(h.sent,0);assert.equal(h.judgeCalls,0);
  assert.equal((await h.db.query('SELECT state FROM public.lost_role_inference_attempts')).rows[0].state,'reserved');
  await h.run(secondJobId);assert.equal(h.sent,0);assert.equal(h.deliveries,0);
});

test('потерянная аренда останавливает задание до сбора и модели',enabled,async t=>{
  const h=await harness(t,{mode:'lease-lost'});
  await assert.rejects(h.run(),/Аренда задания потеряна/);
  assert.equal(h.sent,0);assert.equal(h.judgeCalls,0);assert.equal(h.saved.length,0);assert.equal(h.deliveries,0);
});

test('manual/nightly без подтверждённого ID перехода не обращается к модели',enabled,async t=>{
  for(const mode of ['manual-no-id','nightly-no-id']) {
    const h=await harness(t,{mode});const {result}=await h.run();
    assert.equal(result.status,'error');assert.equal(h.sent,0);assert.equal(h.judgeCalls,0);
    assert.equal(h.deliveries,0);assert.equal((await h.db.query('SELECT count(*)::int AS n FROM public.lost_role_inference_attempts')).rows[0].n,0);
  }
});
