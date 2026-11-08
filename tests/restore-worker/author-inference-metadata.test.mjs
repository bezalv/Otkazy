import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRoleInferenceMetadata } from '../../app/src/worker/role-inference-metadata.mjs';

const stats = () => ({ candidate_sessions:1,resolved:1,unresolved:0,skipped_sessions:0,failed_sessions:0,
  excluded_after_cutoff:0,budget_exhausted_sessions:0,nonmaterial_unknown:0,model_calls:1,
  model_unavailable_calls:0,actual_models:['openai/gpt-6-sol'],usage_complete:true,
  usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120} });
const transport = () => ({ physical_requests_started:1,responses_received:1,in_flight:false,uncertain_outcome:false,cost:'unknown' });
const evidence = () => [{session:'session_1',messages:[{id:'m001',ts:'2026-01-01T00:00:00Z',
  predicted_role:'client',effective_role:'client',source:'semantic_inference',impact:'not_applicable',nonmaterial_unknown:false}]}];

test('сохраняет только безопасные числа и псевдонимы, не раскрывая текст, даты, ошибки и идентификаторы',()=>{
  const s=stats(),t=transport(),e=evidence();
  s.private='SECRET_PRIVATE_CHAT';s.usage.hidden='SECRET_USAGE';t.error='SECRET_PROVIDER';
  e[0].chat_id='123456';e[0].messages[0].text='SECRET_MESSAGE';e[0].messages[0].unknown='SECRET_EXTRA';
  const actual=sanitizeRoleInferenceMetadata(s,t,e);
  assert.equal(actual.usage_complete,true);assert.deepEqual(actual.usage,{prompt_tokens:100,completion_tokens:20,total_tokens:120});
  assert.equal(actual.cost_rub,null);assert.equal(actual.evidence_for_model_calls_complete,true);
  assert.deepEqual(actual.evidence,[{session:'session_1',messages:[{id:'m001',predicted_role:'client',effective_role:'client',
    source:'semantic_inference',impact:'not_applicable',nonmaterial_unknown:false}]}]);
  assert.doesNotMatch(JSON.stringify(actual),/SECRET|123456|2026-01-01/);
});
test('неизвестные и неполные данные не становятся нулевыми токенами или известной ценой',()=>{
  for(const mutate of [
    (s)=>{s.usage_complete=false;},(s)=>{delete s.usage.completion_tokens;},
    (_s,t)=>{t.uncertain_outcome=true;},(_s,t)=>{t.in_flight=true;},
    (_s,t)=>{t.physical_requests_started=2;},(_s,t)=>{t.responses_received=0;},
  ]){
    const s=stats(),t=transport();mutate(s,t);
    const actual=sanitizeRoleInferenceMetadata(s,t,evidence());
    assert.equal(actual.usage_complete,false);assert.equal(actual.usage,null);assert.equal(actual.cost_rub,null);
  }
  const t=transport();t.responses_received=0;
  assert.equal(sanitizeRoleInferenceMetadata(stats(),t,evidence()).uncertain_outcome,true);
});
test('неверные физические счётчики или произвольные агрегаты отклоняются',()=>{
  for(const mutate of [(s)=>{s.model_calls=4;},(s)=>{s.resolved=-1;},
    (_s,t)=>{t.physical_requests_started=4;},(_s,t)=>{t.responses_received=2;},
    (_s,t)=>{t.in_flight='false';}]){
    const s=stats(),t=transport();mutate(s,t);assert.equal(sanitizeRoleInferenceMetadata(s,t,evidence()),null);
  }
});
test('неизвестная модель и повреждённые доказательства не копируются',()=>{
  const s=stats(), e=evidence();s.actual_models=['SECRET_MODEL'];e[0].messages[0].id='SECRET_ID';
  const actual=sanitizeRoleInferenceMetadata(s,transport(),e);
  assert.deepEqual(actual.models,[]);assert.equal(actual.models_complete,false);
  assert.deepEqual(actual.evidence,[]);assert.equal(actual.evidence_for_model_calls_complete,false);
  assert.doesNotMatch(JSON.stringify(actual),/SECRET/);
});
test('потерянная сессия не выдаётся за полный набор доказательств',()=>{
  const actual=sanitizeRoleInferenceMetadata(stats(),transport(),[]);
  assert.equal(actual.evidence_for_model_calls_complete,false);assert.deepEqual(actual.evidence,[]);
});
test('после ошибки отсутствие успешных доказательств и имени модели не считается полной информацией',()=>{
  const s=stats();s.failed_sessions=1;s.actual_models=null;
  const t=transport();t.responses_received=0;
  const actual=sanitizeRoleInferenceMetadata(s,t,[]);
  assert.equal(actual.evidence_for_model_calls_complete,false);assert.equal(actual.models_complete,false);
  assert.equal(actual.uncertain_outcome,true);
});
test('несогласованный счётчик POST не выдаёт сведения за полные',()=>{
  const t=transport();t.physical_requests_started=0;t.responses_received=0;
  const actual=sanitizeRoleInferenceMetadata(stats(),t,evidence());
  assert.equal(actual.evidence_for_model_calls_complete,false);assert.equal(actual.models_complete,false);
  assert.equal(actual.usage_complete,false);assert.deepEqual(actual.evidence,[]);
});
test('ранее подтверждённые псевдоданные остаются доступны с пометкой неполноты',()=>{
  const s=stats(),t=transport();s.model_calls=2;s.failed_sessions=1;
  t.physical_requests_started=2;t.responses_received=1;t.uncertain_outcome=true;
  const actual=sanitizeRoleInferenceMetadata(s,t,evidence());
  assert.equal(actual.evidence_for_model_calls_complete,false);assert.equal(actual.evidence.length,1);
  assert.equal(actual.usage_complete,false);assert.equal(actual.cost_rub,null);
});
test('отсутствующие данные не выдаются за полный учёт',()=>{
  const s=stats(),t=transport();s.model_calls=0;s.actual_models=[];t.physical_requests_started=0;t.responses_received=0;
  const actual=sanitizeRoleInferenceMetadata(s,t,undefined);
  assert.equal(actual.usage,null);assert.equal(actual.usage_complete,false);assert.equal(actual.models_complete,false);
  assert.equal(actual.evidence_for_model_calls_complete,false);assert.deepEqual(actual.evidence,[]);
});
