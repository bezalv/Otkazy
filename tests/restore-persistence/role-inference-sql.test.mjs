import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { persistResult } from '../../app/src/persistence/index.mjs';
import { toPersistenceResult } from '../../app/src/worker/run-job.mjs';
import { createRoleInferenceLedger } from '../../app/src/worker/role-inference-ledger.mjs';
import { sanitizeRoleInferenceMetadata } from '../../app/src/worker/role-inference-metadata.mjs';

const pglite = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const operation = n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const leaseToken = '00000000-0000-4000-8000-000000000099';
const cutoff = '2026-11-02T00:00:00.000Z';
function metadata(jobId,{uncertain=false,stage='101'}={}) {
  const ledger=createRoleInferenceLedger({connect(){}},{jobId,leaseToken,dealId:'42',stageHistoryId:stage,cutoff});
  return sanitizeRoleInferenceMetadata({candidate_sessions:1,resolved:uncertain?0:1,unresolved:uncertain?1:0,
    skipped_sessions:0,failed_sessions:uncertain?1:0,excluded_after_cutoff:0,budget_exhausted_sessions:0,
    nonmaterial_unknown:0,model_calls:1,model_unavailable_calls:uncertain?1:0,
    actual_models:uncertain?[]:['openai/gpt-6-sol'],usage_complete:!uncertain,
    usage:uncertain?null:{prompt_tokens:3,completion_tokens:2,total_tokens:5},private:'SECRET_INPUT'},
  {physical_requests_started:1,responses_received:uncertain?0:1,in_flight:false,uncertain_outcome:uncertain},
  uncertain?[]:[{session:'session_1',messages:[{id:'m001',predicted_role:'client',effective_role:'client',
    source:'semantic_inference',impact:'not_applicable',nonmaterial_unknown:false}]}],{ledger});
}

test('existing JSONB: scoped role usage и неизвестные затраты проходят реальный SQL в изолированной PGlite',
  {skip:!existsSync(pglite)},async t=>{
    const {PGlite}=await import(pathToFileURL(pglite).href),db=new PGlite();t.after(()=>db.close());
    await db.exec(readFileSync('tests/restore-persistence/synthetic-schema.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20261105052525_lost_processing_jobs.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20261106031734_lost_audio_wait_origins.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20261105065551_lost_overwrite_history.sql','utf8'));
    const pool={async connect(){return {query(q){return typeof q==='string'?db.query(q):db.query(q.text,q.values);},release(){}};}};
    async function insertJob(id, date=cutoff, stage='101') {
      await db.query(`INSERT INTO lost_processing_jobs
        (id,request_key,deal_id,lose_date,trigger_type,status,lease_token,lease_until,silent,screenshots)
        VALUES($1,$4,42,$2,'manual','processing',$3,now()+interval '1 hour',true,false)`,[id,date,leaseToken,`bitrix24:deal-stage-history:${stage}`]);
    }
    const job1=operation(101);await insertJob(job1);
    const role=metadata(job1), outcome={status:'processed',dealData:{deal_id:42,stage_id:'C23:LOSE',lose_date:cutoff},
      analysis:{classification:{summary:'Тест',reason_class:'other'},
        multi_agent_analysis:{verdict:'правомерен',closure_reason_class:'other',facts_packet:{facts:[]}},
        llm_meta:{usage_complete:true,prompt_tokens:10,completion_tokens:5,total_tokens:15},communications:[]},
      chatRoleInferenceMetadata:role};
    const job={id:job1,lease_token:leaseToken,deal_id:42,lose_date:cutoff,
      request_key:'bitrix24:deal-stage-history:101',silent:true};
    await persistResult(pool,toPersistenceResult(job,outcome));
    const success=(await db.query(`SELECT ai_judge_json,llm_prompt_tokens,llm_completion_tokens,llm_total_tokens,
      judge_prompt_tokens,judge_completion_tokens FROM lost_deal_analyses WHERE pipeline_operation_id=$1`,[job1])).rows[0];
    assert.equal(success.ai_judge_json.role_inference.physical_requests_started,1);
    assert.equal(success.ai_judge_json.role_inference.cost_rub,null);
    assert.deepEqual([success.llm_prompt_tokens,success.llm_completion_tokens,success.llm_total_tokens],[null,null,null]);
    assert.deepEqual([success.judge_prompt_tokens,success.judge_completion_tokens],[null,null]);
    assert.doesNotMatch(JSON.stringify(success),/SECRET_INPUT/);

    const job2=operation(102);await insertJob(job2,cutoff,'102');
    const error=toPersistenceResult({...job,id:job2,request_key:'bitrix24:deal-stage-history:102'},
      {status:'blocked',pipelineGate:{pipeline_error:'автор неизвестен'},
      chatRoleInferenceMetadata:metadata(job2,{uncertain:true,stage:'102'})});
    await persistResult(pool,error);
    const failed=(await db.query(`SELECT ai_verdict,ai_judge_json,llm_prompt_tokens,llm_completion_tokens,llm_total_tokens,
      judge_prompt_tokens,judge_completion_tokens,writer_prompt_tokens,writer_completion_tokens
      FROM lost_deal_analyses WHERE pipeline_operation_id=$1`,[job2])).rows[0];
    assert.equal(failed.ai_verdict,null);assert.equal(failed.ai_judge_json.role_inference.uncertain_outcome,true);
    assert.equal(failed.ai_judge_json.role_inference.cost_rub,null);
    for(const key of ['llm_prompt_tokens','llm_completion_tokens','llm_total_tokens','judge_prompt_tokens',
      'judge_completion_tokens','writer_prompt_tokens','writer_completion_tokens']) assert.equal(failed[key],null,key);

    const job3=operation(103);await insertJob(job3,'2026-11-02T00:00:00.000500Z','103');
    const stale=metadata(job3,{stage:'103'});
    await persistResult(pool,{operation_id:job3,lease_token:leaseToken,deal_id:42,_status:'error',_error:'Сбой',role_inference_metadata:stale});
    const mismatch=(await db.query('SELECT ai_judge_json,llm_total_tokens FROM lost_deal_analyses WHERE pipeline_operation_id=$1',[job3])).rows[0];
    assert.deepEqual(mismatch.ai_judge_json,{role_inference_unaccounted:true});assert.equal(mismatch.llm_total_tokens,null);
  });
