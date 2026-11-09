import assert from 'node:assert/strict';
import test from 'node:test';
import { persistResult, lookupOperation, loadResumableResult, CommitOutcomeUnknownError } from '../../app/src/persistence/index.mjs';
import { toPersistenceResult } from '../../app/src/worker/run-job.mjs';
import { sanitizeRoleInferenceMetadata } from '../../app/src/worker/role-inference-metadata.mjs';
import { createRoleInferenceLedger } from '../../app/src/worker/role-inference-ledger.mjs';
import { existsSync, readFileSync } from 'node:fs';

function mockPool({ failAt, emptyQueue = false, invalidLease = false, expiredAtFinish = false, existing = null, lookup = null, resumable = null, silent = true, triggerType = 'batch', requestKey = 'test-key' } = {}) {
  const calls = [];
  let released;
  const connection = {
    async query(query) {
      const text = typeof query === 'string' ? query : query.text;
      calls.push(query);
      if (failAt && (typeof failAt === 'string' ? text.includes(failAt) : failAt(text))) throw new Error('Ошибка с секретом');
      if (text.includes('FROM public.lost_processing_jobs') && text.includes('FOR UPDATE')) {
        return invalidLease ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ deal_id: 42, lose_date: '2026-11-02T00:00:00Z', role_lose_date_exact:'2026-11-02T00:00:00.000000Z', silent, screenshots: false, trigger_type: triggerType, request_key: requestKey }] };
      }
      if (text.includes('SELECT j.deal_id, j.silent')) return { rowCount: resumable ? 1 : 0, rows: resumable ? [resumable] : [] };
      if (text.includes('FROM public.lost_processing_jobs j')) return { rowCount: lookup ? 1 : 0, rows: lookup ? [lookup] : [] };
      if (text.includes('SELECT id, deal_id, pipeline_error FROM public.lost_deal_analyses')) return { rowCount: existing ? 1 : 0, rows: existing ? [existing] : [] };
      if (text.includes('SELECT id FROM public.lost_processing_jobs') && expiredAtFinish) return { rowCount: 0, rows: [] };
      if (text.includes('UPDATE public.lost_processing_jobs') && expiredAtFinish) return { rowCount: 0, rows: [] };
      if (text.includes('INSERT INTO public.lost_deal_analyses') && text.includes('RETURNING id')) {
        return { rowCount: 1, rows: [{ id: '71' }] };
      }
      if (text.includes('RETURNING deal_id') || text.includes('RETURNING w.deal_id')) return { rowCount: emptyQueue ? 0 : 1, rows: emptyQueue ? [] : [{ deal_id: 42 }] };
      return { rowCount: 1, rows: [] };
    },
    release(error) { released = error || null; },
  };
  return { pool: { async connect() { return connection; } }, calls, released: () => released };
}

const audioWait = {
  origin_stage_history_id: '101',
  lose_date: '2026-11-02T00:00:00Z', first_seen_at: '2026-11-02T00:01:00Z',
  deadline_at: '2026-11-03T00:01:00Z', next_check_at: '2026-11-02T00:06:00Z',
  pending_calls: ['12'], observations: { 12: { activity_id: '12' } },
};
const operationId = '00000000-0000-4000-8000-000000000001';
const leaseToken = '00000000-0000-4000-8000-000000000002';
const lease = { operation_id: operationId, lease_token: leaseToken };
const deal = {
  deal_id: 42, title: "Тестовая'; DROP TABLE lost_deals; --", stage_id: 'C23:LOSE',
  lose_date: '2026-11-02T00:00:00Z', lose_reason: 'Цена', product_type: ['окна'],
};
const communication = {
  type: 'call', activity_id: 12, date: '2026-11-01T11:00:00Z',
  duration_start: '2026-11-01T11:00:00Z', duration_end: '2026-11-01T11:02:00Z',
  _needs_transcription: true, transcript: 'Менеджер: Добрый день', transcript_engine: 'reserve:gigaam',
  screenshot_files: [{ id: 42 }], screenshot_turns: [{ speaker: 'client', text: 'Добрый день' }],
};
const processed = {
  ...lease, deal_id: 42, deal_data: deal, _status: 'processed', prompt_version: 'v2.8-sol',
  classification: { summary: 'Итог', exact_reason: 'Причина', reason_class: 'price', reactivation_probability: 50 },
  multi_agent_analysis: { verdict: 'неправомерен', recoverable_level: 'средний', closure_reason_class: 'price', final_comment: 'Разбор', facts_packet: { facts: [] } },
  llm_meta: { model: 'openai/gpt-6-sol' }, comm_stats: { total_events: 1, calls: 1 },
  communications_with_transcripts: [communication], full_prompt_text: 'Журнал', journal_text: 'События',
  comm_analytics: { calls_total: 1 }, screenshot_stats: {}, silent: true,
};

const texts = (calls) => calls.map((call) => typeof call === 'string' ? call : call.text);

test('анализ и коммуникации записываются параметрами в одной транзакции', async () => {
  const mock = mockPool();
  const result = await persistResult(mock.pool, processed);
  const statements = texts(mock.calls);
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-1), 'COMMIT');
  assert.equal(result.analysisId, '71');
  assert.equal(result.status, 'processed');
  assert.equal(statements[1].includes('FOR UPDATE'), true);
  assert.equal(statements[2].includes('pg_advisory_xact_lock'), true);
  assert.equal(statements.at(-2).includes("status='done'"), true);
  assert.equal(statements.some((text) => text.includes(deal.title)), false);
  assert.equal(mock.calls.some((call) => typeof call !== 'string' && call.values.includes(deal.title)), true);
  assert.equal(statements.some((text) => text.includes('COALESCE(EXCLUDED.lose_date, lost_deals.lose_date)')), true);
  assert.equal(statements.some((text) => text.includes('COALESCE(EXCLUDED.transcript_engine, lost_deal_communications.transcript_engine)')), true);
  assert.equal(mock.released(), null);
});

function insertedValues(calls) {
  const query = calls.find(call => typeof call !== 'string' && call.text.includes('INSERT INTO public.lost_deal_analyses'));
  const columns = query.text.match(/lost_deal_analyses \(([^)]+)\)/)[1].split(', ');
  return Object.fromEntries(columns.map((column, index) => [column, query.values[index]]));
}

const roleBinding={jobId:operationId,leaseToken,dealId:'42',stageHistoryId:'101',cutoff:'2026-11-02T00:00:00.000Z'};
const roleJob={id:operationId,lease_token:leaseToken,deal_id:42,silent:true,
  request_key:'bitrix24:deal-stage-history:101',lose_date:roleBinding.cutoff};
function safeRoleMetadata({uncertain=false,binding=roleBinding,modelCalls=1}={}) {
  const ledger=createRoleInferenceLedger({connect(){}},binding);
  return sanitizeRoleInferenceMetadata({candidate_sessions:1,resolved:uncertain||!modelCalls?0:1,unresolved:uncertain?1:0,
    skipped_sessions:0,failed_sessions:uncertain?1:0,excluded_after_cutoff:0,budget_exhausted_sessions:0,
    nonmaterial_unknown:0,model_calls:modelCalls,model_unavailable_calls:uncertain?1:0,
    actual_models:uncertain||!modelCalls?[]:['openai/gpt-6-sol'],usage_complete:!uncertain && !!modelCalls,
    usage:uncertain||!modelCalls?null:{prompt_tokens:3,completion_tokens:2,total_tokens:5},private:'SECRET_TEXT'},
  {physical_requests_started:1,responses_received:uncertain?0:1,in_flight:false,uncertain_outcome:uncertain,
    private:'SECRET_URL'},uncertain||!modelCalls?[]:[{session:'session_1',messages:[{id:'m001',predicted_role:'client',
      effective_role:'client',source:'semantic_inference',impact:'not_applicable',nonmaterial_unknown:false,
      private:'SECRET_MESSAGE'}],private:'SECRET_ID'}],{ledger});
}

test('безопасная статистика авторов проходит worker и повторно проверяется до успешной SQL-записи',async()=>{
  const metadata=safeRoleMetadata(), mock=mockPool({requestKey:roleJob.request_key});
  const result=toPersistenceResult(roleJob,
    {status:'processed',analysis:{...processed},dealData:deal,chatRoleInferenceMetadata:metadata});
  await persistResult(mock.pool,result);
  const row=insertedValues(mock.calls), role=JSON.parse(row.ai_judge_json).role_inference;
  assert.equal(role.physical_requests_started,1);assert.equal(role.usage_complete,true);assert.equal(role.cost_rub,null);
  assert.equal(row.llm_prompt_tokens,null);assert.equal(row.llm_completion_tokens,null);assert.equal(row.llm_total_tokens,null);
  assert.equal(role.evidence_for_model_calls_complete,true);assert.equal(role.evidence[0].messages[0].id,'m001');
  assert.doesNotMatch(JSON.stringify(mock.calls),/SECRET_TEXT|SECRET_URL|SECRET_MESSAGE|SECRET_ID/);
});

test('неизвестный результат авторства сохраняется при сбое без вердикта и с null расходом',async()=>{
  const metadata=safeRoleMetadata({uncertain:true}),mock=mockPool({requestKey:roleJob.request_key});
  const result=toPersistenceResult(roleJob,
    {status:'blocked',pipelineGate:{pipeline_error:'автор не определён'},chatRoleInferenceMetadata:metadata});
  await persistResult(mock.pool,result);
  const row=insertedValues(mock.calls), value=JSON.parse(row.ai_judge_json), role=value.role_inference;
  assert.equal(role.uncertain_outcome,true);assert.equal(role.cost_rub,null);assert.equal(role.usage,null);
  assert.equal(role.evidence_for_model_calls_complete,false);assert.deepEqual(role.evidence,[]);
  for(const key of ['llm_prompt_tokens','llm_completion_tokens','llm_total_tokens',
    'judge_prompt_tokens','judge_completion_tokens','writer_prompt_tokens','writer_completion_tokens']) assert.equal(row[key],null,key);
  assert.equal('ai_verdict' in row,false);assert.doesNotMatch(JSON.stringify(mock.calls),/SECRET_/);
});

test('подмена, сериализованная копия или произвольная метаинформация не сохраняются',async()=>{
  for(const input of [JSON.parse(JSON.stringify(safeRoleMetadata())),{cost_rub:0,private:'SECRET_FAKE'}]) {
    const mock=mockPool();
    // Даже прямой вызов persistence в обход worker не доверяет JSON-копии.
    await persistResult(mock.pool,{...processed,multi_agent_analysis:{...processed.multi_agent_analysis,role_inference:input}});
    const row=insertedValues(mock.calls);
    assert.equal(JSON.parse(row.ai_judge_json).role_inference,undefined);
    assert.doesNotMatch(JSON.stringify(mock.calls),/SECRET_FAKE/);
  }
  const tampered=safeRoleMetadata();tampered.evidence[0].messages[0].id='SECRET_TAMPERED';
  const mock=mockPool({requestKey:roleJob.request_key});
  await persistResult(mock.pool,{...lease,deal_id:42,_status:'error',_error:'Сбой',role_inference_metadata:tampered});
  assert.deepEqual(JSON.parse(insertedValues(mock.calls).ai_judge_json),{role_inference_unaccounted:true});
  assert.doesNotMatch(JSON.stringify(mock.calls),/SECRET_TAMPERED/);
  const trusted=safeRoleMetadata(), afterWorker=toPersistenceResult(roleJob,
    {status:'processed',analysis:{...processed},dealData:deal,chatRoleInferenceMetadata:trusted});
  afterWorker.multi_agent_analysis.role_inference.private='SECRET_AFTER_WORKER';
  const changed=mockPool({requestKey:roleJob.request_key});await persistResult(changed.pool,afterWorker);
  const changedRow=insertedValues(changed.calls),changedJson=JSON.parse(changedRow.ai_judge_json);
  assert.equal(changedJson.role_inference,undefined);assert.equal(changedJson.role_inference_unaccounted,true);
  assert.equal(changedRow.llm_total_tokens,null);assert.doesNotMatch(JSON.stringify(changed.calls),/SECRET_AFTER_WORKER/);
});

test('подлинная метаинформация чужой сделки, задания, перехода, даты или аренды не сохраняется как своя',async()=>{
  for(const change of [{dealId:'43'},{stageHistoryId:'102'},{cutoff:'2026-11-02T00:00:01.000Z'},
    {jobId:'00000000-0000-4000-8000-000000000004'}, {leaseToken:'00000000-0000-4000-8000-000000000003'}]){
    const metadata=safeRoleMetadata({binding:{...roleBinding,...change}}),mock=mockPool({requestKey:roleJob.request_key});
    // Проверяем persistence напрямую, минуя worker.
    await persistResult(mock.pool,{...lease,deal_id:42,_status:'error',_error:'Сбой',role_inference_metadata:metadata});
    const row=insertedValues(mock.calls);assert.deepEqual(JSON.parse(row.ai_judge_json),{role_inference_unaccounted:true});
    assert.equal(row.llm_total_tokens,null);
  }
});

test('сбой ролей вместе с доказательствами судьи не выдаёт judge-only токены за полный расход',async()=>{
  const metadata=safeRoleMetadata(),mock=mockPool({requestKey:roleJob.request_key});
  const llm_meta={prompt_tokens:5,completion_tokens:6,total_tokens:11,usage_complete:true,judge_usage_complete:true,
    judge_usage:{prompt_tokens:5,completion_tokens:6,total_tokens:11},
    proof_repair:{attempted:true,judge_calls:2,status:'failed',initial_errors:1}};
  await persistResult(mock.pool,{...lease,deal_id:42,_status:'error',_error:'Сбой',llm_meta,role_inference_metadata:metadata});
  const row=insertedValues(mock.calls),j=JSON.parse(row.ai_judge_json);
  assert.equal(row.llm_prompt_tokens,null);assert.equal(row.llm_total_tokens,null);
  assert.equal(row.judge_prompt_tokens,5);assert.equal(j.judge_usage_complete,true);assert.equal(j.usage_complete,false);
  assert.equal(j.role_inference.cost_rub,null);
});

test('вызов ролей без доверенного snapshot помечается как неучтённый в успехе и ошибке',async()=>{
  for(const status of ['processed','error']) {
    const mock=mockPool({requestKey:roleJob.request_key});
    const result=status==='processed'
      ? {...processed,role_inference_unaccounted:true}
      : {...lease,deal_id:42,_status:'error',_error:'Сбой',role_inference_unaccounted:true};
    await persistResult(mock.pool,result);
    const row=insertedValues(mock.calls),value=JSON.parse(row.ai_judge_json);
    assert.equal(value.role_inference_unaccounted,true);
    assert.equal(row.llm_prompt_tokens,null);assert.equal(row.llm_completion_tokens,null);assert.equal(row.llm_total_tokens,null);
    assert.equal(value.role_inference,undefined);
  }
});

test('физический POST не считается нулевым расходом при model_calls=0',async()=>{
  for(const status of ['processed','error']) {
    const mock=mockPool({requestKey:roleJob.request_key}),metadata=safeRoleMetadata({modelCalls:0});
    const outcome=status==='processed'
      ? {status:'processed',analysis:{...processed},dealData:deal,chatRoleInferenceMetadata:metadata}
      : {status:'error',analysis:{pipeline_error:'Сбой'},chatRoleInferenceMetadata:metadata};
    const result=toPersistenceResult(roleJob,outcome);
    if(status==='processed')assert.equal(result.llm_meta.total_tokens,null);
    await persistResult(mock.pool,result);
    const row=insertedValues(mock.calls),role=JSON.parse(row.ai_judge_json).role_inference;
    assert.equal(role.model_calls,0);assert.equal(role.physical_requests_started,1);
    assert.equal(role.usage_complete,false);assert.equal(role.cost_rub,null);
    assert.equal(row.llm_prompt_tokens,null);assert.equal(row.llm_total_tokens,null);
  }
});

test('manual/nightly не принимает origin без независимой проверки в базе как доказательство перехода',async()=>{
  for(const trigger of ['manual','nightly']) {
    const metadata=safeRoleMetadata(), job={...roleJob,trigger_type:trigger,request_key:`${trigger}:42`};
    const result=toPersistenceResult(job,{status:'processed',analysis:{...processed},dealData:deal,
      chatRoleInferenceMetadata:metadata},'101');
    assert.equal(result.multi_agent_analysis.role_inference,undefined);
    assert.equal(result.multi_agent_analysis.role_inference_unaccounted,true);
    assert.equal(result.llm_meta.total_tokens,null);
    const mock=mockPool({requestKey:job.request_key,triggerType:trigger});
    await persistResult(mock.pool,result);
    const value=JSON.parse(insertedValues(mock.calls).ai_judge_json);
    assert.equal(value.role_inference,undefined);assert.equal(value.role_inference_unaccounted,true);
  }
});

test('неизвестная статистика повтора не превращается при записи в нули', async () => {
  const mock = mockPool();
  await persistResult(mock.pool, { ...processed,
    llm_meta: { usage_complete: false, judge_usage_complete: false, prompt_tokens: null, completion_tokens: null, total_tokens: null },
    multi_agent_analysis: { ...processed.multi_agent_analysis, judge_usage: null,
      judge_usage_known: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      writer_usage: { prompt_tokens: 4, completion_tokens: 5 } },
  });
  const row = insertedValues(mock.calls);
  assert.equal(row.llm_prompt_tokens, null);
  assert.equal(row.llm_completion_tokens, null);
  assert.equal(row.llm_total_tokens, null);
  assert.equal(row.judge_prompt_tokens, null);
  assert.equal(row.judge_completion_tokens, null);
  assert.equal(row.writer_prompt_tokens, 4);
  assert.equal(row.writer_completion_tokens, 5);
  assert.deepEqual(JSON.parse(row.ai_judge_json).judge_usage_known, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
});

test('отсутствующая статистика писателя остаётся неизвестной при неполном usage', async () => {
  for (const writerUsage of [{}, {prompt_tokens: 4}]) {
    const mock = mockPool();
    await persistResult(mock.pool, { ...processed,
      llm_meta: { usage_complete: false, judge_usage_complete: true, prompt_tokens: null, completion_tokens: null, total_tokens: null },
      multi_agent_analysis: { ...processed.multi_agent_analysis, judge_usage: { prompt_tokens: 8, completion_tokens: 2 }, writer_usage: writerUsage },
    });
    const row = insertedValues(mock.calls);
    assert.equal(row.judge_prompt_tokens, 8);
    assert.equal(row.writer_prompt_tokens, writerUsage.prompt_tokens ?? null);
    assert.equal(row.writer_completion_tokens, null);
  }
});

test('явный пропуск писателя сохраняется как нулевой расход писателя', async () => {
  const mock = mockPool();
  await persistResult(mock.pool, { ...processed,
    llm_meta: { usage_complete: false, judge_usage_complete: false, prompt_tokens: null, completion_tokens: null, total_tokens: null },
    multi_agent_analysis: { ...processed.multi_agent_analysis, judge_usage: null, writer_model: null, writer_usage: null },
  });
  const row = insertedValues(mock.calls);
  assert.equal(row.writer_prompt_tokens, 0);
  assert.equal(row.writer_completion_tokens, 0);
  assert.equal(row.judge_prompt_tokens, null);
});

test('ошибка повтора сохраняет только безопасный учёт через worker и SQL', async () => {
  for (const complete of [true, false]) {
    const mock = mockPool();
    const meta = { model: 'SECRET-MODEL', prompt_tokens: 5, completion_tokens: 6, total_tokens: 11,
      judge_usage_complete: complete, warnings: ['SECRET-INPUT'],
      proof_repair: { attempted: true, judge_calls: 2, status: 'failed', initial_errors: 1, initial_warnings: ['SECRET-FACT'] } };
    const result = toPersistenceResult({ id: operationId, lease_token: leaseToken, deal_id: 42, silent: true },
      { status: 'error', analysis: { pipeline_error: 'Сбой', llm_meta: meta } });
    await persistResult(mock.pool, result);
    const row = insertedValues(mock.calls);
    assert.equal(row.llm_prompt_tokens, complete ? 5 : null);
    assert.equal(row.llm_completion_tokens, complete ? 6 : null);
    assert.equal(row.llm_total_tokens, complete ? 11 : null);
    assert.deepEqual(JSON.parse(row.ai_judge_json), { proof_repair: { attempted: true, judge_calls: 2, status: 'failed', initial_errors: 1 },
      judge_usage: complete ? {prompt_tokens: 5, completion_tokens: 6, total_tokens: 11} : null, judge_usage_known: null,
      judge_usage_complete: complete, usage_complete: complete });
    assert.equal(JSON.stringify(row).includes('SECRET'), false);
    assert.equal('ai_verdict' in row, false);
  }
});

test('частичный расход остаётся частичным, известный расход судьи не выдаётся за полный расход', async () => {
  for (const complete of [false, true]) {
    const mock = mockPool();
    const judge = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, secret: 'SECRET' };
    const result = toPersistenceResult({ id: operationId, lease_token: leaseToken, deal_id: 42, silent: true },
      { status: 'error', analysis: { pipeline_error: 'Сбой', llm_meta: {
        prompt_tokens: null, completion_tokens: null, total_tokens: null, usage_complete: false,
        judge_usage_complete: complete, judge_usage: complete ? judge : null, judge_usage_known: judge,
        proof_repair: { attempted: true, judge_calls: 2, status: complete ? 'corrected' : 'failed', initial_errors: 1 },
      } } });
    await persistResult(mock.pool, result);
    const row = insertedValues(mock.calls), metadata = JSON.parse(row.ai_judge_json);
    assert.equal(row.llm_total_tokens, null);
    assert.equal(row.judge_prompt_tokens, complete ? 10 : null);
    assert.equal(row.judge_completion_tokens, complete ? 3 : null);
    assert.deepEqual(metadata.judge_usage_known, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
    assert.equal(metadata.judge_usage_complete, complete);
    assert.equal(metadata.usage_complete, false);
    assert.equal(JSON.stringify(row).includes('SECRET'), false);
  }
});

test('наборы сохраняемых колонок совпадают с выгрузкой n8n', {
  skip: !existsSync('tmp/backup/sql-posle.js'),
}, async () => {
  const source = readFileSync('tmp/backup/sql-posle.js', 'utf8');
  const old = new Function('$input', source)({ first: () => ({ json: processed }) })[0].json.sql;
  const mock = mockPool();
  await persistResult(mock.pool, processed);
  for (const table of ['lost_deals', 'lost_deal_analyses', 'lost_deal_communications']) {
    const pattern = new RegExp(`INSERT INTO (?:public\\.)?${table} \\(([^)]+)\\) VALUES`);
    const oldColumns = old.match(pattern)?.[1].split(',').map((part) => part.trim()).sort();
    const currentText = texts(mock.calls).find((text) => text.includes(`INSERT INTO public.${table} `));
    const currentColumns = currentText?.match(pattern)?.[1].split(',').map((part) => part.trim()).filter((column) => column !== 'pipeline_operation_id').sort();
    assert.ok(oldColumns, `нет исходной записи ${table}`);
    assert.deepStrictEqual(currentColumns, oldColumns);
  }
});

test('ожидающая аудиозапись ставится без анализа', async () => {
  const mock = mockPool();
  await persistResult(mock.pool, { ...lease, deal_id: 42, _status: 'waiting_audio', audio_wait: audioWait, silent: true });
  assert.equal(texts(mock.calls).some((text) => text.includes('INSERT INTO public.lost_audio_wait')), true);
  assert.equal(texts(mock.calls).some((text) => text.includes('lost_deal_analyses')), false);
  assert.deepStrictEqual(texts(mock.calls).filter((text) => text === 'BEGIN' || text === 'COMMIT'), ['BEGIN', 'COMMIT']);
});

test('сбой проверки аудио двигает только её актуальную очередь до завершения задачи', async () => {
  const mock = mockPool({ triggerType: 'audio_wait', requestKey: 'audio-wait:test' });
  await persistResult(mock.pool, { ...lease, deal_id: 42, _status: 'error', _error: 'тест' });
  const statements = texts(mock.calls);
  const update = mock.calls.find((call) => typeof call !== 'string' && call.text.includes('UPDATE public.lost_audio_wait w'));
  assert.deepStrictEqual(update.values, [42, '2026-11-02T00:00:00Z', 'audio-wait:test']);
  assert.match(update.text, /w\.lose_date=\$2 AND w\.state='waiting'/);
  assert.match(update.text, /w\.next_check_at <= retry_clock\.at/);
  assert.ok(statements.indexOf(update.text) < statements.findIndex((text) => text.includes("SET status='done'")));
  assert.equal(statements.at(-1), 'COMMIT');
});

test('неоднозначность автора завершает только исходное ожидание аудио вместе с записью сбоя', async () => {
  for (const kind of ['author_ambiguous', 'chat_connector_unknown']) {
    const mock = mockPool({ triggerType: 'audio_wait', requestKey: 'audio-wait:test' });
    const saved = await persistResult(mock.pool, { ...lease, deal_id: 42, _status: 'error', _error: 'требуется проверка',
      error_kind: kind, audio_origin_stage_history_id: '101' });
    const statements = texts(mock.calls);
    const update = mock.calls.find(call => typeof call !== 'string' && call.text.includes("SET state='cancelled'"));
    assert.deepEqual(update.values, [42, '2026-11-02T00:00:00Z', 'audio-wait:test', '101']);
    assert.match(update.text, /w\.lose_date=\$2 AND w\.state='waiting' AND w\.origin_stage_history_id=\$4/);
    assert.match(update.text, /w\.next_check_at/);
    assert.ok(statements.findIndex(text => text.includes('INSERT INTO public.lost_deal_analyses')) < statements.indexOf(update.text));
    assert.equal(statements.some(text => text.includes('retry_clock')), false);
    assert.equal(saved.status, 'error');
    assert.equal(saved.needsExternalActions, false);
    assert.equal(statements.at(-1), 'COMMIT');
  }
});

test('изменённое ожидание или неизвестный переход откатывают сохранение окончательной ошибки', async () => {
  for (const [emptyQueue, history] of [[true, '101'], [false, null]]) {
    const mock = mockPool({ triggerType: 'audio_wait', requestKey: 'audio-wait:test', emptyQueue });
    await assert.rejects(persistResult(mock.pool, { ...lease, deal_id: 42, _status: 'error',
      error_kind: 'author_ambiguous', audio_origin_stage_history_id: history }));
    assert.equal(texts(mock.calls).at(-1), 'ROLLBACK');
    assert.equal(texts(mock.calls).some(text => text.includes("SET status='done'")), false);
  }
});

test('сбой обычного задания не меняет расписание аудио', async () => {
  const mock = mockPool();
  await persistResult(mock.pool, { ...lease, deal_id: 42, _status: 'error', _error: 'тест' });
  assert.equal(texts(mock.calls).some((text) => text.includes('UPDATE public.lost_audio_wait w')), false);
});

test('ошибка изменения расписания откатывает запись сбоя и завершение задачи', async () => {
  const mock = mockPool({ triggerType: 'audio_wait', failAt: 'UPDATE public.lost_audio_wait w' });
  await assert.rejects(persistResult(mock.pool, { ...lease, deal_id: 42, _status: 'error' }));
  assert.equal(texts(mock.calls).at(-1), 'ROLLBACK');
  assert.equal(texts(mock.calls).some((text) => text.includes("SET status='done'")), false);
});

test('нетихий разбор оставляет задачу под арендой для внешних действий', async () => {
  const mock = mockPool({ silent: false });
  const saved = await persistResult(mock.pool, processed);
  assert.equal(saved.needsExternalActions, true);
  assert.equal(texts(mock.calls).some((text) => text.includes("SET status='done'")), false);
  assert.equal(texts(mock.calls).at(-1), 'COMMIT');
});

test('уже сохранённый нетихий разбор не записывается повторно', async () => {
  const mock = mockPool({ silent: false, existing: { id: '71', deal_id: 42, pipeline_error: null } });
  const saved = await persistResult(mock.pool, processed);
  assert.equal(saved.status, 'already_committed');
  assert.equal(saved.needsExternalActions, true);
  assert.equal(texts(mock.calls).some((text) => text.startsWith('INSERT')), false);
  assert.equal(texts(mock.calls).some((text) => text.includes("SET status='done'")), false);
});

for (const expired of [false, true]) {
  test(`сохранение и завершение очереди аудио атомарны, expired=${expired}`, async () => {
    const mock = mockPool();
    const input = {
      ...processed,
      multi_agent_analysis: { ...processed.multi_agent_analysis, verdict: expired ? 'недостаточно_данных' : 'неправомерен' },
      communications_with_transcripts: expired ? [] : processed.communications_with_transcripts,
      audio_wait: audioWait,
      audio_wait_expired: expired,
    };
    await persistResult(mock.pool, input);
    const finish = mock.calls.find((call) => typeof call !== 'string' && call.text.includes('UPDATE public.lost_audio_wait SET state=$1'));
    assert.equal(finish.values[0], expired ? 'expired' : 'done');
    assert.equal(finish.values[6], JSON.stringify(audioWait.pending_calls));
    assert.equal(texts(mock.calls).at(-1), 'COMMIT');
  });
}

test('потеря очереди аудио откатывает всю транзакцию', async () => {
  const mock = mockPool({ emptyQueue: true });
  await assert.rejects(persistResult(mock.pool, { ...processed, audio_wait: audioWait }), /Не удалось завершить/);
  assert.equal(texts(mock.calls).at(-1), 'ROLLBACK');
  assert.equal(texts(mock.calls).includes('COMMIT'), false);
});

test('дубли сохраняют карточку без анализа и отменяют ожидание', async () => {
  const mock = mockPool();
  await persistResult(mock.pool, { ...lease, deal_id: 42, deal_data: deal, _status: 'skipped_by_reason', audio_origin_stage_history_id: '101' });
  assert.equal(texts(mock.calls).some((text) => text.includes('INSERT INTO public.lost_deals')), true);
  assert.equal(texts(mock.calls).some((text) => text.includes('INSERT INTO public.lost_deal_analyses')), false);
  assert.equal(texts(mock.calls).some((text) => text.includes("state='cancelled'")), true);
});

test('без подтверждённого ID отмена очереди по одной дате не выполняется', async () => {
  const mock = mockPool();
  await persistResult(mock.pool, { ...lease, deal_id: 42, deal_data: deal, _status: 'skipped_by_reason' });
  assert.equal(texts(mock.calls).some(text => text.includes("state='cancelled'")), false);
});

test('ошибка сохраняется без вердикта и с очисткой секрета', async () => {
  const mock = mockPool();
  await persistResult(mock.pool, { ...lease, deal_id: 42, _status: 'error', _error: 'Ошибка https://site/rest/65/secretvalue/crm.deal.get' });
  const insert = mock.calls.find((call) => typeof call !== 'string' && call.text.includes('lost_deal_analyses'));
  assert.equal(insert.values.join(' ').includes('secretvalue'), false);
  assert.equal(texts(mock.calls).some((text) => text.includes('INSERT INTO public.lost_deals')), false);
});

test('сбой записи откатывает всё без повтора', async () => {
  const mock = mockPool({ failAt: 'INSERT INTO public.lost_deal_communications' });
  await assert.rejects(persistResult(mock.pool, processed));
  assert.equal(texts(mock.calls).at(-1), 'ROLLBACK');
  assert.equal(texts(mock.calls).includes('COMMIT'), false);
  assert.equal(texts(mock.calls).filter((text) => text.includes('INSERT INTO public.lost_deal_analyses')).length, 1);
});

test('неизвестный исход COMMIT нельзя автоматически повторить', async () => {
  const mock = mockPool({ failAt: 'COMMIT' });
  await assert.rejects(persistResult(mock.pool, processed), (error) => error instanceof CommitOutcomeUnknownError && error.code === 'COMMIT_OUTCOME_UNKNOWN' && error.operationId === operationId);
  assert.equal(texts(mock.calls).filter((text) => text === 'COMMIT').length, 1);
  assert.equal(texts(mock.calls).includes('ROLLBACK'), false);
  assert.ok(mock.released() instanceof Error);
});

test('устаревшая аренда не позволяет выполнить запись', async () => {
  const mock = mockPool({ invalidLease: true });
  await assert.rejects(persistResult(mock.pool, processed), /аренда истекла/);
  assert.equal(texts(mock.calls).some((text) => text.startsWith('INSERT')), false);
  assert.equal(texts(mock.calls).at(-1), 'ROLLBACK');
});

test('истечение аренды перед завершением откатывает все записи', async () => {
  const mock = mockPool({ expiredAtFinish: true });
  await assert.rejects(persistResult(mock.pool, processed), /Аренда задачи истекла/);
  assert.equal(texts(mock.calls).at(-1), 'ROLLBACK');
  assert.equal(texts(mock.calls).includes('COMMIT'), false);
});

test('сохранённая операция не создаёт второй анализ и повторные записи', async () => {
  const mock = mockPool({ existing: { id: '71', deal_id: 42, pipeline_error: null } });
  const result = await persistResult(mock.pool, processed);
  assert.equal(result.status, 'already_committed');
  assert.equal(result.analysisId, '71');
  assert.equal(texts(mock.calls).some((text) => text.startsWith('INSERT')), false);
  assert.equal(texts(mock.calls).at(-1), 'COMMIT');
});

test('совпавший operation_id другой сделки отклоняется', async () => {
  const mock = mockPool({ existing: { id: '71', deal_id: 99, pipeline_error: null } });
  await assert.rejects(persistResult(mock.pool, processed), /другому результату/);
  assert.equal(texts(mock.calls).at(-1), 'ROLLBACK');
});

test('состояние операции после неизвестного COMMIT читается отдельно без записи', async () => {
  const mock = mockPool({ lookup: { job_id: operationId, job_status: 'done', deal_id: 42, analysis_id: '71', pipeline_error: null } });
  const result = await lookupOperation(mock.pool, operationId);
  assert.deepStrictEqual(result, { operationId, dealId: 42, jobStatus: 'done', analysisId: '71', analysisStatus: 'processed' });
  assert.equal(mock.calls.length, 1);
  assert.match(texts(mock.calls)[0], /^SELECT/);
});

test('повторный захват читает готовый разбор без записи и вызова модели', async () => {
  const mock = mockPool({ resumable: {
    deal_id: 42, silent: false, screenshots: true, analysis_id: '71', pipeline_error: null,
    prompt_version: 'v2.8-sol', ai_judge_json: processed.multi_agent_analysis, title: 'Сделка',
  } });
  const loaded = await loadResumableResult(mock.pool, lease);
  assert.equal(loaded.analysisId, '71');
  assert.equal(loaded.result.multi_agent_analysis.verdict, 'неправомерен');
  assert.equal(loaded.result.prompt_version, 'v2.8-sol');
  assert.equal(mock.calls.length, 1);
  assert.match(texts(mock.calls)[0], /^SELECT/);
});

test('загрузка сохранённого результата требует действующей аренды', async () => {
  const mock = mockPool();
  await assert.rejects(loadResumableResult(mock.pool, lease), /аренда истекла/);
  assert.equal(mock.calls.length, 1);
});

test('неполный результат и чужая карточка не начинают транзакцию', async () => {
  const mock = mockPool();
  await assert.rejects(persistResult(mock.pool, { ...processed, pipeline_error: 'сбой' }), /Неполный результат/);
  await assert.rejects(persistResult(mock.pool, { ...processed, deal_id: 43 }), /Карточка не соответствует/);
  assert.equal(mock.calls.length, 0);
});
