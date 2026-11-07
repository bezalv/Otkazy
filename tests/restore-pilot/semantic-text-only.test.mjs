import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareTextOnly, buildReport, runTextOnly, strictPolzaFetch } from '../../app/src/pilot/semantic-text-only.mjs';
import { inferChatRoles } from '../../app/src/analysis/chat-role-inference.mjs';

const ids=['f001','f002','f003','f004','f005','f006','f007','f008','f009','f010','f011','f012','f013','f014','f015','f016','f017','f019','f020'];
const facts=()=>ids.map((fact_id,i)=>({fact_id,ts:new Date(Date.parse('2026-10-28T01:00:00Z')+i*60000).toISOString(),
  content:i===1||i===2?'👍':`Сообщение номер ${i+1} содержит тестовый текст`,actor:'SECRET_ACTOR',comment:'SECRET_COMMENT'}));
const cutoff='2026-10-29T00:00:00Z';
const output=(body, roles)=>({model:'openai/gpt-6-sol',usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14},
  choices:[{finish_reason:'stop',message:{content:JSON.stringify({roles:JSON.parse(body.messages[1].content).messages.map((m,i)=>({
    id:m.id,role:roles?.[i]||'client',impact:roles?.[i]==='unknown'?'not_material':'not_applicable'}))})}}]});

test('только текст и время, без прежней роли и иных полей', () => {
  const prepared=prepareTextOnly(facts(),cutoff);
  const serialized=JSON.stringify(prepared.communications);
  assert.equal(prepared.communications.length,19);
  assert.doesNotMatch(serialized,/SECRET_ACTOR|SECRET_COMMENT/);
  assert.ok(prepared.communications.every(x=>x.role==='unknown'&&x.direction==='unknown'&&x._wazzup_author_ambiguous));
});

test('недостоверная дата, порядок, дубли и пропущенные факты отклоняются', () => {
  assert.throws(()=>prepareTextOnly(facts().slice(1),cutoff));
  const duplicate=facts();duplicate[1].fact_id=duplicate[0].fact_id;assert.throws(()=>prepareTextOnly(duplicate,cutoff));
  const late=facts();late[0].ts='2026-10-30T00:00:00Z';assert.throws(()=>prepareTextOnly(late,cutoff));
  const tied=facts();tied[0].ts=tied[1].ts;assert.throws(()=>prepareTextOnly(tied,cutoff));
});

test('классификатор получает только {id,text}, а отчёт не содержит реплик и секретов', async () => {
  const prepared=prepareTextOnly(facts(),cutoff);let calls=0;
  const classified=await inferChatRoles({communications:prepared.communications,cutoff:prepared.cutoff,client:{async complete(body){
    calls++;const payload=JSON.parse(body.messages[1].content);
    assert.ok(payload.messages.every(x=>Object.keys(x).sort().join(',')==='id,text'));
    assert.doesNotMatch(JSON.stringify(body),/SECRET_ACTOR|SECRET_COMMENT/);
    return output(body,prepared.factIds.map(id=>id==='f002'||id==='f003'?'unknown':'client'));
  }}});
  const report=buildReport(prepared,classified);
  assert.equal(calls,1);assert.equal(report.status,'evaluated');assert.equal(report.messages,19);assert.equal(report.evaluated,16);
  assert.equal(report.roles.find(x=>x.fact_id==='f002').predicted,'unknown');
  assert.doesNotMatch(JSON.stringify(report),/Сообщение номер|SECRET_|👍/);
});

test('невалидный ответ и исключение клиента дают unverified без скрытых повторов', async () => {
  const prepared=prepareTextOnly(facts(),cutoff);let calls=0;
  const r=await inferChatRoles({communications:prepared.communications,cutoff:prepared.cutoff,client:{async complete(){calls++;throw new Error('SECRET');}}});
  const report=buildReport(prepared,r);assert.equal(report.status,'unverified');assert.equal(calls,1);
  assert.doesNotMatch(JSON.stringify(report),/SECRET/);
});

test('изолированный полный вызов закрывает пул и делает один запрос модели', async () => {
  const prepared=prepareTextOnly(facts(),cutoff);let closed=false,calls=0;
  const pool={on(){},async connect(){throw new Error('Не используется');},async end(){closed=true;}};
  const result=await runTextOnly({env:{DATABASE_URL:'postgresql://u:p@localhost/test',POLZA_API_KEY:'LOCAL_SECRET'},
    makePool:async()=>pool,load:async()=>prepared,makeClient:()=>({async complete(body){calls++;return output(body);}})});
  assert.equal(result.status,'evaluated');assert.equal(calls,1);assert.equal(closed,true);
  assert.equal(result.resources_closed,true);assert.doesNotMatch(JSON.stringify(result),/LOCAL_SECRET|Сообщение номер/);
});

test('сетевой адаптер разрешает только Polza и запрещает redirects', async () => {
  const old=globalThis.fetch; let called=0;
  globalThis.fetch=async (url,options)=>{called++;assert.equal(url,'https://api.polza.ai/api/v1/chat/completions');assert.equal(options.redirect,'error');return {ok:true};};
  try {
    assert.throws(()=>strictPolzaFetch('https://example.invalid/',{method:'POST'}),/запрещён/);
    assert.throws(()=>strictPolzaFetch('https://api.polza.ai/api/v1/chat/completions',{method:'GET'}),/запрещён/);
    await strictPolzaFetch('https://api.polza.ai/api/v1/chat/completions',{method:'POST',redirect:'follow'});
    assert.equal(called,1);
  } finally { globalThis.fetch=old; }
});

test('SQL получает только выбранные текстовые поля в подтверждённой read-only транзакции', async () => {
  const statements=[]; let closed=false, released=false, modelCalls=0;
  const connection={on(){},removeListener(){},release(){released=true;},async query(sql){
    statements.push(sql);
    if(sql.includes("current_setting('statement_timeout')"))return {rows:[{statement_timeout:'30s',lock_timeout:'10s',idle_in_transaction_session_timeout:'2min'}]};
    if(sql.includes("current_setting('transaction_read_only')"))return {rows:[{read_only:'on'}]};
    if(sql.includes('jsonb_agg'))return {rows:[{lose_date:cutoff,facts:facts()}]};
    return {rows:[]};
  }};
  const pool={on(){},async connect(){return connection;},async end(){closed=true;}};
  const result=await runTextOnly({env:{DATABASE_URL:'postgresql://u:p@localhost/test',POLZA_API_KEY:'LOCAL_SECRET'},
    makePool:async()=>pool,makeClient:()=>({async complete(body){modelCalls++;return output(body);}})});
  assert.equal(result.status,'evaluated');assert.equal(modelCalls,1);assert.equal(closed,true);assert.equal(released,true);
  assert.ok(statements.some(x=>x==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  const query=statements.find(x=>x.includes('jsonb_agg'));
  assert.match(query,/a\.deal_id=127114 AND a\.id=1968/);
  assert.match(query,/f->>'source'='chat'/);assert.match(query,/f->>'channel'='WAZZUP: Max'/);
  assert.doesNotMatch(query,/SELECT \*|crm_comment|crm_task/);
});
