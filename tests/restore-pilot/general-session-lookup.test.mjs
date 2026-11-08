import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLookup, lookupSession } from '../../app/src/pilot/general-session-lookup.mjs';

const from='2026-01-01T00:00:00.000Z', cutoff='2026-10-28T05:35:03.000Z';
const target=()=>({id:80,chatId:100,configId:71,crmEntityType:'DEAL',crmEntityId:127114,
  dateCreate:'2026-10-27T00:00:00Z',dateClose:'2026-10-29T00:00:00Z'});
const other=i=>({id:1000+i,chatId:200,configId:71,crmEntityType:'CONTACT',crmEntityId:42,
  dateCreate:'2026-10-27T00:00:00Z',privateField:'PRIVATE'});
const input={deal_id:'127114',chat_id:'100',session_id:'80',line_id:'71',cutoff};
function fixture(pages) {
  const calls=[];
  return {calls,client:{async request(method,body,options) {
    calls.push({method,body,options});
    if(method!=='imopenlines.v2.Session.list')throw Error('forbidden');
    const page=pages[body.offset/200]; if(page instanceof Error || !page)throw Error('PRIVATE');
    return {result:page};
  }}};
}
async function search(pages, changes={}, options={}) {
  const f=fixture(pages), run=createSessionLookup({client:f.client,from,...options});
  return {result:await run({...input,...changes}),calls:f.calls};
}

test('разрешает ровно одну линию и возвращает только целевую запись после полной пагинации',async()=>{
  const pages=[{sessions:[target(),...Array.from({length:199},(_,i)=>other(i))],hasNextPage:true},
    {sessions:[{...other(200),dateCreate:'2026-10-26T00:00:00Z'}],hasNextPage:false}];
  const {result,calls}=await search(pages);
  assert.equal(result.status,'found'); assert.equal(result.kind,'single_session_lookup_v1');
  assert.deepEqual(result.session,{id:'80',chatId:'100',configId:'71',crmEntityType:'DEAL',crmEntityId:'127114',
    dateCreate:'2026-10-27T00:00:00Z',dateClose:'2026-10-29T00:00:00Z'});
  assert.equal(calls.length,2); assert.deepEqual(calls[0].body,{configId:71,dateCreateFrom:from,dateCreateTo:cutoff,
    limit:200,offset:0,order:'dateCreate',orderDirection:'desc'});
  assert.equal(calls[1].body.offset,200);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal(Object.hasOwn(result,'history_complete'),false);
});

test('не подтверждает найденную сессию, пока пагинация не исчерпана или содержит ошибки',async()=>{
  const page={sessions:[target(),...Array.from({length:199},(_,i)=>other(i))],hasNextPage:true};
  for(const [pages,options,reason] of [
    [[page],{maxPages:1},'pagination_incomplete'],
    [[page,new Error('failure')],{},'request_unavailable'],
    [[{sessions:[target()],hasNextPage:true}],{},'invalid_page'],
    [[{sessions:[target()],hasNextPage:null}],{},'invalid_page'],
    [[page,{sessions:[target()],hasNextPage:false}],{},'duplicate_session'],
    [[page,{sessions:[other(300)],hasNextPage:false}],{},'unstable_page_boundary'],
  ]) {
    const {result}=await search(pages,{},options);assert.equal(result.status,'unverified');assert.equal(result.reason,reason);
  }
});

test('не принимает другую сделку, чат, линию, неправильную CRM-привязку или время сессии',async()=>{
  for(const changed of [
    {chatId:101},{configId:72},{crmEntityId:0},{crmEntityId:127115},{crmEntityType:null},
    {crmEntityType:' deal '},{dateCreate:'invalid'}, {dateCreate:'2026-10-29T00:00:00Z'},
    {dateClose:'2026-10-26T00:00:00Z'}, {dateClose:'invalid'},
  ]) {
    const {result}=await search([{sessions:[{...target(),...changed}],hasNextPage:false}]);
    assert.equal(result.status,'unverified');
  }
  const absent=await search([{sessions:[other(1)],hasNextPage:false}]);
  assert.deepEqual(absent.result,{status:'unverified',reason:'not_found'});
  const open=await search([{sessions:[{...target(),dateClose:null}],hasNextPage:false}]);
  assert.equal(open.result.status,'found');assert.equal(open.result.session.dateClose,null);
});

test('отсутствующие поля, неверная сортировка и сдвиг страниц не дают ложного подтверждения',async()=>{
  for(const row of [{...other(1),id:null},{...other(1),configId:null},{...other(1),dateCreate:null},
    {...other(1),dateCreate:'2026-10-28T01:00:00Z'},{...other(1),configId:72}]) {
    const {result}=await search([{sessions:[target(),row],hasNextPage:false}]);
    assert.equal(result.status,'unverified');assert.equal(result.reason,'invalid_row');
  }
});

test('не выполняет запросы при некорректных параметрах и при отмене',async()=>{
  const f=fixture([{sessions:[target()],hasNextPage:false}]);
  for(const invalid of [
    {dealId:'0'}, {chatId:'1x'}, {sessionId:'0001'}, {lineId:0}, {from:'2024-01-01T00:00:00Z'},
    {from:'2026-11-01T00:00:00Z'}, {cutoff:'2026-02-30T00:00:00Z'}, {maxPages:21}, {maxPages:0},
  ]) {
    const r=await lookupSession({client:f.client,dealId:127114,chatId:100,sessionId:80,lineId:71,from,cutoff,...invalid});
    assert.deepEqual(r,{status:'unverified',reason:'invalid_input'});
  }
  assert.equal(f.calls.length,0);
  const signal=AbortSignal.abort();
  const r=await createSessionLookup({client:f.client,from,signal})(input);
  assert.deepEqual(r,{status:'unverified',reason:'cancelled'});assert.equal(f.calls.length,0);
});

test('не отбрасывает ненулевые микросекунды у границы окна и времени записи',async()=>{
  // Парсер Date.parse свёл бы эти значения к одной миллисекунде и принял
  // запись, которая на самом деле наступила после даты отказа.
  for (const value of ['2026-10-28T05:35:03.0001Z','2026-10-28T05:35:03.000000001Z']) {
    const {result}=await search([{sessions:[{...target(),dateCreate:value}],hasNextPage:false}]);
    assert.deepEqual(result,{status:'unverified',reason:'invalid_row'});
    const f=fixture([{sessions:[target()],hasNextPage:false}]);
    const bad=await createSessionLookup({client:f.client,from})({...input,cutoff:value});
    assert.deepEqual(bad,{status:'unverified',reason:'invalid_input'});assert.equal(f.calls.length,0);
    const invalidFrom=await createSessionLookup({client:f.client,from:value})(input);
    assert.deepEqual(invalidFrom,{status:'unverified',reason:'invalid_input'});assert.equal(f.calls.length,0);
  }
  const exactlyRepresentable=await search([{sessions:[{...target(),dateCreate:'2026-10-27T00:00:00.000000Z'}],hasNextPage:false}]);
  assert.equal(exactlyRepresentable.result.status,'found');
  const badClose=await search([{sessions:[{...target(),dateClose:'2026-10-29T00:00:00.000000001Z'}],hasNextPage:false}]);
  assert.deepEqual(badClose.result,{status:'unverified',reason:'target_mismatch'});
});
