import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runManualPrejudge } from '../../app/src/pilot/manual-prejudge.mjs';
import { processDeal } from '../../app/src/process-deal.mjs';
import { createPilotDependencies } from '../../app/src/pilot/dependencies.mjs';

const pglite=resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const cutoff='2026-11-04T11:00:00.000Z', from='2026-10-01T00:00:00.000Z';
const runId='00000000-0000-4000-8000-000000000201';

async function fixture(family='Wappi', badSession=false) {
  const {PGlite}=await import(pathToFileURL(pglite).href), db=new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated');
  await db.exec(readFileSync('db/proposals/20261109_prejudge_artifacts.sql','utf8'));
  await db.exec(readFileSync('db/proposals/20261109_prejudge_manual_jobs.sql','utf8'));
  const pool={query(q){return typeof q==='string'?db.query(q):db.query(q.text,q.values);},
    async connect(){return {query(q){return typeof q==='string'?db.query(q):db.query(q.text,q.values);},release(){}};}};
  const code=family==='Wappi'?'opaque':'wz_test';
  const chat={CHAT_ID:1,CONNECTOR_ID:code,CONNECTOR_TITLE:family};
  const history={chatId:1,sessionId:2,chat:{1:{entityId:`${code}|9|client|user`}},users:{55:{}},files:{},
    message:{50:{id:50,senderid:55,date:'2026-11-04T10:00:00.000Z',
      text:'Здравствуйте, я купил окна в другом месте и больше не планирую заказ.'}}};
  const bitrix={async request(method,body={}) {
    if(method==='crm.deal.userfield.list')return {result:[{LIST:[{ID:'1',VALUE:'Другая'}]}]};
    if(method==='crm.deal.get')return {result:{ID:'42',STAGE_ID:'C23:LOSE',ASSIGNED_BY_ID:'65',UF_CRM_1584703948317:'1'}};
    if(method==='crm.stagehistory.list')return {result:{items:[{ID:'101',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}]}};
    if(method==='imopenlines.crm.chat.get')return {result:[structuredClone(chat)]};
    if(method==='crm.activity.list' && body.filter?.PROVIDER_ID==='IMOPENLINES_SESSION')return {result:[{ASSOCIATED_ENTITY_ID:'2'}]};
    if(method==='crm.activity.list')return {result:[]};
    if(method==='imopenlines.session.history.get')return {result:structuredClone(history)};
    if(method==='imopenlines.v2.Session.list')return {result:{sessions:[{id:2,chatId:1,configId:9,crmEntityType:'deal',
      crmEntityId:badSession?'43':'42',dateCreate:'2026-11-01T00:00:00.000Z'}],hasNextPage:false}};
    if(method==='crm.timeline.comment.list')return {result:[]};
    if(method==='tasks.task.list')return {result:{tasks:[]}};
    throw new Error(`Неожиданный метод ${method}`);
  }};
  const events=[];
  const judge={verdict:'правомерен',verdict_reason_short:'Клиент отказался',recoverable_level:null,
    closure_reason_class:'competitor',misplaced:false,correct_stage:null,exact_reason:'Клиент купил в другом месте',
    manager_mistakes:[],key_signals:[],risk_factors:[],questions_for_manager:[]};
  const llm={async complete(body,{role}={}) {
    events.push(role);
    if(role==='chat-role-inference') {
      const stage=await db.query("SELECT artifact_type FROM public.lost_prejudge_artifacts WHERE job_id=$1",[runId]);
      assert.ok(stage.rows.some(row=>row.artifact_type==='communications'));
      const entries=JSON.parse(body.messages[1].content).messages;
      return {model:'openai/gpt-6-sol',usage:{prompt_tokens:2,completion_tokens:2,total_tokens:4},
        choices:[{finish_reason:'stop',message:{content:JSON.stringify({roles:entries.map(e=>
          ({id:e.id,role:'client',impact:'not_applicable'}))})}}]};
    }
    if(role==='judge')return {choices:[{message:{content:JSON.stringify(judge)}}]};
    if(role==='writer')return {choices:[{message:{content:'Итог'}}]};
    throw new Error('Неожиданная модель');
  }};
  return {db,pool,events,options:{bitrix,llm,nowMs:Date.parse('2026-11-05T00:00:00Z'),wait:async()=>{},
    audioWaitEnabledAt:'2026-11-01T00:00:00Z',judgeSystemPrompt:'Промпт',writerSystemPrompt:'Писатель',screenshots:false}};
}

for(const family of ['Wappi','Wazzup']) test(`${family}: тихой ручной разбор сохраняет материалы до оценки роли и судьи`,{skip:!existsSync(pglite)},async()=>{
  const f=await fixture(family);
  try {
    const out=await runManualPrejudge({pool:f.pool,dealId:42,stageHistoryId:'101',loseDate:cutoff,options:f.options,
      semanticRolesFrom:from,uuid:()=>runId});
    assert.equal(out.result.status,'processed');
    assert.deepEqual(f.events,['chat-role-inference','judge']);
    const row=(await f.db.query("SELECT payload FROM public.lost_prejudge_artifacts WHERE job_id=$1 AND artifact_type='judge_input'",[runId])).rows[0];
    assert.ok(row.payload.facts_packet.facts.some(x=>x.source==='chat' && x.actor==='client' && x.role_source==='semantic_inference'));
    assert.equal((await f.db.query('SELECT status FROM public.lost_prejudge_manual_jobs WHERE id=$1',[runId])).rows[0].status,'completed');
  } finally {await f.db.close();}
});

for (const family of ['Wappi','Wazzup']) test(`${family}: чужая сессия не отправляется модели и не выдаёт вердикт`,{skip:!existsSync(pglite)},async()=>{
  const f=await fixture(family,true);
  try {
    const out=await runManualPrejudge({pool:f.pool,dealId:42,stageHistoryId:'101',loseDate:cutoff,options:f.options,
      semanticRolesFrom:from,uuid:()=>runId});
    assert.notEqual(out.result.status,'processed');assert.deepEqual(f.events,[]);
  } finally {await f.db.close();}
});

test('Wazzup: ошибка проверки сессии не отправляет её модели и не выдаёт вердикт',{skip:!existsSync(pglite)},async()=>{
  const f=await fixture('Wazzup');
  try {
    const original=f.options.bitrix.request;
    f.options.bitrix.request=async(method,body)=>{
      if(method==='imopenlines.v2.Session.list') throw Error('timeout');
      return original(method,body);
    };
    const out=await runManualPrejudge({pool:f.pool,dealId:42,stageHistoryId:'101',loseDate:cutoff,options:f.options,
      semanticRolesFrom:from,uuid:()=>runId});
    assert.notEqual(out.result.status,'processed');assert.deepEqual(f.events,[]);
  } finally {await f.db.close();}
});

test('отсутствие opt-in сохраняет блокировку неподтверждённого авторства',{skip:!existsSync(pglite)},async()=>{
  const f=await fixture();
  try {
    const out=await runManualPrejudge({pool:f.pool,dealId:42,stageHistoryId:'101',loseDate:cutoff,options:f.options,uuid:()=>runId});
    assert.notEqual(out.result.status,'processed');assert.deepEqual(f.events,[]);
  } finally {await f.db.close();}
});

for (const silent of [true,false]) test(`поддельный контекст не допускает отправку модели при silent=${silent}`,async()=>{
  let touched=false; const fake=async()=>{touched=true;};
  await assert.rejects(processDeal({dealId:42,bitrix:{request:fake},llm:{complete:fake},silent,
    expectedHistoryId:'101',expectedLoseDate:cutoff,semanticChatRoles:true,
    roleSessionContext:{verify:fake},verifyFallbackSession:fake,verifyLatestSession:fake,
    prejudgeCheckpoint:fake,prejudgeCheckLease:fake}),/проверенная сессия/);
  assert.equal(touched,false);
});

test('исправление ссылок требует явной проверки авторов до обращения к базе',async()=>{
  let touched=false; const fake=async()=>{touched=true;};
  await assert.rejects(runManualPrejudge({pool:{query:fake,connect:fake},dealId:42,stageHistoryId:'101',
    loseDate:cutoff,options:{},repairProofErrors:true}),/только при ручной проверке авторов/);
  assert.equal(touched,false);
});

test('ошибка определения автора оставляет сделку без вердикта',{skip:!existsSync(pglite)},async()=>{
  const f=await fixture();
  try {
    f.options.llm={async complete(_body,{role}={}){f.events.push(role);throw Error('model unavailable');}};
    const out=await runManualPrejudge({pool:f.pool,dealId:42,stageHistoryId:'101',loseDate:cutoff,options:f.options,
      semanticRolesFrom:from,uuid:()=>runId});
    assert.equal(out.resultSaved,false);assert.notEqual(out.result.status,'processed');
    assert.deepEqual(f.events,['chat-role-inference']);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM public.lost_prejudge_artifacts WHERE artifact_type='judge_result'")).rows[0].n,0);
  } finally {await f.db.close();}
});

test('полная сборка ручного пилота пропускает чтение сессии, но не запись в CRM',{skip:!existsSync(pglite)},async()=>{
  const f=await fixture(),mock=f.options.bitrix,methods=[];
  const fetchImpl=async(url,options)=>{
    const method=new URL(url).pathname.split('/').pop().replace(/\.json$/,'');
    methods.push(method);
    return new Response(JSON.stringify(await mock.request(method,JSON.parse(options.body))),{status:200});
  };
  const deps=createPilotDependencies({bitrixBaseUrl:'https://example.invalid/rest/1/test/',polzaKey:'fixture',
    sttUrl:'http://127.0.0.1:8790',sttKey:'fixture',tempRoot:resolve('tmp'),fetchImpl});
  try {
    assert.throws(()=>deps.bitrix.request('crm.deal.update',{id:42}),/запрещён/);
    const out=await runManualPrejudge({pool:f.pool,dealId:42,stageHistoryId:'101',loseDate:cutoff,
      options:{...f.options,bitrix:deps.bitrix},semanticRolesFrom:from,uuid:()=>runId});
    assert.equal(out.result.status,'processed');
    assert.ok(methods.includes('imopenlines.v2.Session.list'));
    assert.ok(!methods.includes('crm.deal.update'));
    assert.deepEqual(f.events,['chat-role-inference','judge']);
  } finally {deps.close();await f.db.close();}
});
