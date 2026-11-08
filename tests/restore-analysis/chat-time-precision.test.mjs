import test from 'node:test';
import assert from 'node:assert/strict';
import { chatMillisTimestamp } from '../../app/src/time-precision.mjs';
import { inferChatRoles } from '../../app/src/analysis/chat-role-inference.mjs';

const event = date => ({ type:'chat', connector_id:'wz_test', chat_id:'12', session_id:'34',
  message_id:'34_1', date, role:'unknown', direction:'unknown', _wazzup_author_ambiguous:true, text:'Текст' });
function client(calls) { return { async complete(body) {
  calls.push(body); const messages=JSON.parse(body.messages[1].content).messages;
  return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({roles:messages.map(x=>
    ({id:x.id,role:'client',impact:'not_applicable'}))})}}]};
} }; }

test('сохраняет прежние форматы чатов и отклоняет непредставимые микросекунды',()=>{
  assert.equal(chatMillisTimestamp('2026-11-05 07:00:00.123000+0700')?.toISOString(),'2026-11-05T00:00:00.123Z');
  assert.equal(chatMillisTimestamp('2026-11-05T00:00:00.123999Z'),null);
  assert.equal(chatMillisTimestamp('2026-02-30T00:00:00Z'),null);
  assert.equal(chatMillisTimestamp('2026-11-05T00:00:00.1230000000Z'),null);
});
test('микросекунды на границе отказа не позволяют передать сообщение модели',async()=>{
  for (const [cutoff,date] of [
    ['2026-11-05T00:00:00.123000Z','2026-11-05T00:00:00.123999Z'],
    ['2026-11-05T00:00:00.123999Z','2026-11-05T00:00:00.123000Z'],
  ]) {
    const calls=[];const result=await inferChatRoles({communications:[event(date)],cutoff,client:client(calls)});
    assert.equal(calls.length,0);assert.equal(result.communications[0].role,'unknown');
  }
  const calls=[];const result=await inferChatRoles({communications:[event('2026-11-05 07:00:00.123000+0700')],
    cutoff:'2026-11-05T00:00:00.123000Z',client:client(calls)});
  assert.equal(calls.length,1);assert.equal(result.communications[0].role,'Клиент');
});
