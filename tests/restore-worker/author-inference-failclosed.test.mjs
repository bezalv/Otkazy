import test from 'node:test';
import assert from 'node:assert/strict';
import { inferChatRoles } from '../../app/src/analysis/chat-role-inference.mjs';
import { createPolzaRoleInferenceClient } from '../../app/src/polza-client.mjs';

const at = n => `2026-01-01T00:00:0${n}Z`;
const row = n => ({ type:'chat', connector_id:'wz_test',chat_id:'1',session_id:String(n),
  message_id:`message${n}`,date:at(n),text:`Сообщение ${n}`,role:'unknown',direction:'unknown',
  author_name:'Участник чата',_wazzup_author_ambiguous:true });
const response = roles => ({choices:[{finish_reason:'stop',message:{content:JSON.stringify({roles})}}]});
const valid = response([{id:'m001',role:'client',impact:'not_applicable'}]);

test('ошибка результата запечатывает ограниченный клиент до следующих сессий',async()=>{
  for (const first of [new Error('неизвестный исход'), response([{id:'wrong',role:'client',impact:'not_applicable'}])]) {
    let calls=0,seals=0;
    const client={async complete(){calls++;if(first instanceof Error)throw first;return first;},failClosed(){seals++;}};
    const input=[row(1),row(2),row(3)];
    const result=await inferChatRoles({communications:input,client,cutoff:'2026-01-01T00:01:00Z'});
    assert.equal(calls,1);assert.equal(seals,1);assert.equal(result.stats.model_calls,1);
    assert.equal(result.stats.failed_sessions,1);assert.equal(result.stats.unresolved,3);
    assert.equal(result.stats.skipped_sessions,2);assert.deepEqual(result.communications,input);
  }
});
test('проверенные ответы разных сессий разрешены до лимита и имеют вероятностный источник',async()=>{
  let calls=0,seals=0;const client={async complete(){calls++;return valid;},failClosed(){seals++;}};
  const result=await inferChatRoles({communications:[row(1),row(2),row(3)],client,cutoff:'2026-01-01T00:01:00Z'});
  assert.equal(calls,3);assert.equal(seals,0);assert.equal(result.stats.resolved,3);
  assert.ok(result.communications.every(x=>x._role_source==='semantic_inference'));
});
test('ошибка бизнес-валидации закрывает реальный ограниченный транспорт без второго физического запроса',async()=>{
  let requests=0;
  const client=createPolzaRoleInferenceClient({apiKey:'synthetic-key',fetchImpl:async()=>{
    requests++;return {ok:true,async json(){return response([{id:'unexpected',role:'client',impact:'not_applicable'}]);}};
  }});
  const input=[row(1),row(2),row(3)];
  const result=await inferChatRoles({communications:input,client,cutoff:'2026-01-01T00:01:00Z'});
  assert.equal(requests,1);assert.equal(result.stats.model_calls,1);assert.equal(result.stats.unresolved,3);
  assert.equal(client.snapshot().uncertain_outcome,true);assert.deepEqual(result.communications,input);
});
