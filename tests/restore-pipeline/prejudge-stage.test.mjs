import test from 'node:test';
import assert from 'node:assert/strict';
import { processDeal } from '../../app/src/process-deal.mjs';
import { PrejudgeStageError } from '../../app/src/persistence/prejudge.mjs';
import { normalizeCommunications } from '../../app/src/collect/normalize.mjs';
import { runJob } from '../../app/src/worker/run-job.mjs';
import { SttAttemptsExhaustedError } from '../../app/src/persistence/stt-attempts.mjs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createSttClient } from '../../app/src/stt-client.mjs';

const nowMs = Date.parse('2026-11-05T00:00:00Z');
function fixture(events) {
  const judge = { verdict:'правомерен',verdict_reason_short:'Клиент отказался',recoverable_level:null,
    closure_reason_class:'competitor',misplaced:false,correct_stage:null,exact_reason:'Клиент купил в другом месте',
    manager_mistakes:[],key_signals:[],risk_factors:[],questions_for_manager:[] };
  const bitrix = { async request(method,body) {
    if (method === 'crm.deal.userfield.list') return {result:[{LIST:[{ID:'1',VALUE:'Другая'}]}]};
    if (method === 'crm.deal.get') return {result:{ID:'42',STAGE_ID:'C23:LOSE',ASSIGNED_BY_ID:'65',UF_CRM_1584703948317:'1'}};
    if (method === 'crm.stagehistory.list') return {result:{items:[{ID:'101',STAGE_ID:'C23:LOSE',CREATED_TIME:'2026-11-04T00:00:00Z'}]}};
    if (method === 'crm.activity.list' && body.filter.TYPE_ID) return {result:[1,2].map((id)=>({
      ID:String(id),PROVIDER_ID:'VOXIMPLANT_CALL',COMPLETED:'Y',CREATED:`2026-11-03T0${id}:00:00Z`,
      START_TIME:`2026-11-03T0${id}:00:00Z`,END_TIME:`2026-11-03T0${id}:01:10Z`,
      SETTINGS:{RECORD_URL:`https://example.invalid/audio?fileId=${100+id}`} }))};
    if (method === 'crm.activity.list' || method === 'imopenlines.crm.chat.get' || method === 'crm.timeline.comment.list') return {result:[]};
    if (method === 'tasks.task.list') return {result:{tasks:[]}};
    throw new Error(`Неожиданный метод ${method}`);
  } };
  return { dealId:42,bitrix,nowMs,wait:async()=>{},audioWaitEnabledAt:'2026-11-01T00:00:00Z',
    expectedHistoryId:'101',expectedLoseDate:'2026-11-04T00:00:00Z',prejudgeCheckLease:async()=>{},
    judgeSystemPrompt:'Промпт',writerSystemPrompt:'Писатель',
    transcribe:async request => {events.push(`stt:${request.activity_id}`);return {success:true,
      activity_id:request.activity_id,formatted_dialog:'Клиент: Я уже купил в другом месте',
      client_text:'Я уже купил в другом месте',manager_text:'',total_replicas:1,channel_count:2};},
    llm:{async complete(body,{role}={}) {events.push(`llm:${role}`); return role==='writer'
      ? {choices:[{message:{content:'Итог'}}]}
      : {choices:[{message:{content:JSON.stringify(judge)}}]};}}
  };
}

test('звонки сохраняются по одному, общий пакет — до судьи', async () => {
  const events=[];const args=fixture(events);
  args.prejudgeCheckpoint=async ({artifact}) => {events.push(`save:${artifact.type}`);return {saved:true};};
  const result=await processDeal(args);
  assert.equal(result.status,'processed');
  assert.deepEqual(events.slice(0,7),['save:begin','save:raw_collection','save:communications','stt:1','save:transcript','stt:2','save:transcript']);
  assert.ok(events.indexOf('save:judge_input') < events.indexOf('llm:judge'));
});

test('неполное распознавание сохраняет интервалы и передаёт их судье, не объявляя звонок несостоявшимся', async () => {
  const events=[],args=fixture(events),artifacts=[];
  const coverage={version:1,status:'incomplete',total_fragments:2,unrecognized_count:1,
    unrecognized_segments:[{channel:1,start:10.25,end:12.5}]};
  args.transcribe=async request=>({success:true,activity_id:request.activity_id,
    formatted_dialog:'Клиент: Я уже купил окна в другом месте',client_text:'Я уже купил окна в другом месте',manager_text:'',total_replicas:1,channel_count:2,
    conversation:[{id:1,speaker:'Клиент',text:'Я уже купил окна в другом месте'}],transcription_coverage:coverage});
  args.prejudgeCheckpoint=async ({artifact})=>{artifacts.push(artifact);return {saved:true};};
  let seen; const complete=args.llm.complete;
  args.llm.complete=async(body,options)=>{if(options?.role==='judge')seen=JSON.parse(body.messages[1].content);return complete(body,options);};
  const result=await processDeal(args);assert.equal(result.status,'processed');
  const transcript=artifacts.find(a=>a.type==='transcript');
  assert.deepEqual(transcript.payload.transcript.transcription_coverage,coverage);
  const facts=artifacts.find(a=>a.type==='judge_input').payload.facts_packet.facts;
  assert.ok(facts.some(f=>f.content.includes('не распознано фрагментов 1 из 2') && f.content.includes('10.25–12.5')));
  assert.ok(!facts.some(f=>f.content.includes('разговор не состоялся')));
  assert.deepEqual(seen.facts,facts);
});

for (const requested of [2,1]) test(`подтверждённый пустой ${requested===2?'stereo':'mono'} ответ сохраняется до решения`, async()=>{
  const events=[],args=fixture(events),artifacts=[];
  const server=createServer(async(req,res)=>{
    if(req.url==='/audio'){res.end(Buffer.alloc(2048,17));return;}
    for await(const _ of req){};
    const mode=new URL(req.url,'http://localhost').searchParams.get('channels');
    if(requested===1 && mode==='stereo'){
      res.writeHead(422,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:{code:'channels_mismatch',retryable:false}}));return;
    }
    const channels=mode==='mono'?1:2;
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,model:'ai-sage/gigaam-v3',
      channels,duration_sec:70,segments:[],transcription_coverage:{version:1,status:'incomplete',total_fragments:1,
        unrecognized_count:1,unrecognized_segments:[{channel:channels-1,start:1,end:2}]}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const client=createSttClient({bitrix:{request:async()=>({result:{DOWNLOAD_URL:`${base}/audio`}})},
      sttUrl:base,sttKey:'test-only',tempRoot:resolve('tmp')});
    args.transcribe=async req=>{events.push(`stt:${req.activity_id}:${req.channel_count}`);return client(req);};
    args.prejudgeCheckpoint=async({artifact})=>{artifacts.push(artifact);events.push(`save:${artifact.type}`);return {saved:true};};
    const result=await processDeal(args);assert.equal(result.status,'processed');
    const empty=artifacts.filter(a=>a.type==='transcript');assert.equal(empty.length,2);
    assert.ok(empty.every(a=>a.payload.status==='verified_stt_response' && a.payload.transcript.formatted_dialog===''
      && a.payload.source.channel_count===requested && a.payload.transcript.transcription_coverage.status==='incomplete'));
    assert.ok(events.lastIndexOf('save:transcript')<events.indexOf('save:judge_input'));
  } finally {server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
});

test('фальшивый SHA пустого результата не создаёт запись и не запускает судью', async()=>{
  const events=[],args=fixture(events);
  args.prejudgeCheckpoint=async({artifact})=>{events.push(`save:${artifact.type}`);return {saved:true};};
  args.transcribe=async req=>({success:true,activity_id:req.activity_id,formatted_dialog:'',manager_text:'',client_text:'',
    conversation:[],total_replicas:0,channel_count:2,transcript_engine:'reserve:gigaam',audio_sha256:'a'.repeat(64),
    reserve_duration_sec:70,transcription_coverage:{version:1,status:'incomplete',total_fragments:1,unrecognized_count:1,
      unrecognized_segments:[{channel:0,start:1,end:2}]}});
  await assert.rejects(processDeal(args),PrejudgeStageError);
  assert.ok(!events.includes('save:transcript'));assert.ok(!events.some(x=>x.startsWith('llm:')));
});

test('старый пустой ответ без карты покрытия остаётся неизвестным и сохраняет mono fallback', async()=>{
  const events=[],args=fixture(events),artifacts=[];
  args.prejudgeCheckpoint=async({artifact})=>{artifacts.push(artifact);return {saved:true};};
  args.transcribe=async req=>{events.push(req.channel_count);return req.channel_count===2
    ? {success:true,activity_id:req.activity_id,channel_count:2,formatted_dialog:''}
    : {success:true,activity_id:req.activity_id,channel_count:1,formatted_dialog:'Говорящий: Я уже купил в другом месте',
      client_text:'',manager_text:'Я уже купил в другом месте',total_replicas:1,
      conversation:[{id:1,speaker:'Говорящий',text:'Я уже купил в другом месте'}]};};
  const result=await processDeal(args);assert.equal(result.status,'processed');
  assert.deepEqual(events,[2,1,2,1]);
  const transcripts=artifacts.filter(a=>a.type==='transcript');assert.equal(transcripts.length,2);
  assert.ok(transcripts.every(a=>a.payload.source.channel_count===1));
  assert.ok(!transcripts.some(a=>a.payload.transcript.formatted_dialog===''));
});

test('судья получает ровно сохранённый пакет без секретов в ссылках', async () => {
  const events=[];const args=fixture(events);let stored, sent;const original=args.bitrix.request, originalComplete=args.llm.complete;
  args.bitrix.request=async(method,body)=>method==='crm.timeline.comment.list'
    ? {result:[{ID:7,AUTHOR_ID:65,CREATED:'2026-11-03T03:00:00Z',COMMENT:'Документ https://example.invalid/a?token=SECRET'}]}
    : original(method,body);
  args.prejudgeCheckpoint=async({artifact})=>{if(artifact.type==='judge_input')stored=artifact.payload.facts_packet;return {saved:true};};
  args.llm.complete=async(body,options)=>{if(options?.role==='judge')sent=JSON.parse(body.messages[1].content);return originalComplete(body,options);};
  const result=await processDeal(args);
  assert.equal(result.status,'processed');assert.deepEqual(sent,stored);
  assert.doesNotMatch(JSON.stringify(sent),/token=SECRET/);assert.match(JSON.stringify(sent),/https:\/\/example\.invalid\/a\?token=/);
});

test('сбой записи первого звонка останавливает следующий вызов и судью', async () => {
  const events=[];const args=fixture(events);
  args.prejudgeCheckpoint=async ({artifact}) => {events.push(`save:${artifact.type}`);if(artifact.type==='transcript')throw Error('db');return {saved:true};};
  await assert.rejects(processDeal(args),PrejudgeStageError);
  assert.deepEqual(events,['save:begin','save:raw_collection','save:communications','stt:1','save:transcript']);
});

test('сбой записи итогового пакета останавливает судью', async () => {
  const events=[];const args=fixture(events);
  args.prejudgeCheckpoint=async ({artifact}) => {events.push(`save:${artifact.type}`);if(artifact.type==='judge_input')throw Error('db');return {saved:true};};
  await assert.rejects(processDeal(args),PrejudgeStageError);
  assert.equal(events.some(e=>e.startsWith('llm:')),false);
});

test('потеря аренды между звонками не запускает второе распознавание', async () => {
  const events=[];const args=fixture(events);let checks=0;
  args.prejudgeCheckLease=async()=>{if(++checks===2)throw Error('lease');};
  args.prejudgeCheckpoint=async({artifact})=>{events.push(`save:${artifact.type}`);return {saved:true};};
  await assert.rejects(processDeal(args),PrejudgeStageError);
  assert.deepEqual(events,['save:begin','save:raw_collection','save:communications','stt:1','save:transcript']);
});

test('потеря аренды между скриншотами не запускает вторую модель и судью', async () => {
  const events=[];const args=fixture(events);const original=args.bitrix.request;let checks=0;
  args.bitrix.request=async(method,body)=>method==='crm.timeline.comment.list'
    ? {result:[1,2].map(id=>({ID:id,AUTHOR_ID:65,CREATED:'2026-11-03T03:00:00Z',COMMENT:'Текст',
      FILES:{[id]:{id,type:'image',date:'2026-11-03T03:00:00Z'}}}))} : original(method,body);
  args.resolveFile=async()=>({DOWNLOAD_URL:'https://example.invalid/image'});
  args.downloadFile=async()=>Buffer.from([0x89,0x50,0x4e,0x47,1,2,3,4,5]);
  args.prejudgeCheckpoint=async()=>({saved:true});
  args.prejudgeCheckLease=async()=>{if(++checks===4)throw Error('lease');};
  args.llm.complete=async(_body,{role}={})=>{events.push(`llm:${role}`);
    return {choices:[{message:{content:JSON.stringify({screenshots:[{file_id:0,is_chat_screenshot:false}],turns:[]})}}]};};
  const result=await processDeal(args);
  assert.equal(result.status,'blocked');assert.equal(events.filter(event=>event==='llm:screenshots').length,1);
  assert.equal(events.includes('llm:judge'),false);
});

test('сбой записи первого голосового не позволяет отправить второе', async () => {
  let calls=0;
  const collection={deal_id:42,silent:true,_status:'pending_normalization',deal_data:{deal_id:42},
    _sources:Object.fromEntries(['calls','openlines','comments','tasks'].map(k=>[k,{complete:true}])),
    raw:{calls:[],comments:[],tasks:[],chats:[{CHAT_ID:100,CONNECTOR_ID:'wappi'}],sessions:[{session_id:80,history:{
      chatId:100,chat:{100:{}},users:{55:{connector:true}},
      files:{1:{id:1,name:'a.ogg',type:'audio'},2:{id:2,name:'b.ogg',type:'audio'}},
      message:{1:{id:1,senderid:55,text:'',params:{FILE_ID:[1,2]}}}
    }}]}};
  await assert.rejects(normalizeCommunications({collection,resolveFile:async()=>({NAME:'a.ogg',DOWNLOAD_URL:'https://example.invalid/a'}),
    transcribeVoice:async()=>{calls++;throw new PrejudgeStageError();}}),PrejudgeStageError);
  assert.equal(calls,1);
});

test('исходные сообщения сохраняются до транскрибации голосового', async () => {
  const events=[];const args=fixture(events);const original=args.bitrix.request;
  args.bitrix.request=async(method,body)=>{
    if(method==='crm.activity.list' && body.filter.PROVIDER_ID==='IMOPENLINES_SESSION')return {result:[{ASSOCIATED_ENTITY_ID:'80'}]};
    if(method==='imopenlines.crm.chat.get')return {result:[{CHAT_ID:100,CONNECTOR_ID:'wappi',CONNECTOR_TITLE:'wappi'}]};
    if(method==='imopenlines.session.history.get')return {result:{sessionId:80,chatId:100,chat:{100:{}},users:{55:{connector:true}},
      message:{1:{id:1,senderid:55,date:'2026-11-03T00:00:00Z',text:'Добрый день',params:{FILE_ID:[7]}}},
      files:{7:{id:7,type:'audio',name:'voice.ogg',date:'2026-11-03T00:00:00Z'}}}};
    return original(method,body);
  };
  args.resolveFile=async()=>({NAME:'voice.ogg',DOWNLOAD_URL:'https://example.invalid/voice'});
  args.transcribe=async request=>{events.push(`stt:${request.activity_id}`);return {success:true,formatted_dialog:'Клиент: Пока не готов',
    client_text:'Пока не готов',manager_text:'',total_replicas:1,channel_count:1};};
  args.prejudgeCheckpoint=async ({artifact})=>{events.push(`save:${artifact.type}`);
    if(artifact.type==='raw_collection')assert.equal(artifact.payload.sessions[0].messages[0].text,'Добрый день');
    if(artifact.type==='transcript')throw Error('db');return {saved:true};};
  await assert.rejects(processDeal(args),PrejudgeStageError);
  assert.deepEqual(events,['save:begin','save:raw_collection','stt:chat_7','save:transcript']);
});

test('worker передаёт checkpoint только при явном включении и с известным переходом', async () => {
  const job={id:'00000000-0000-4000-8000-000000000101',lease_token:'00000000-0000-4000-8000-000000000102',
    deal_id:42,lose_date:'2026-11-04T00:00:00Z',request_key:'bitrix24:deal-stage-history:101',silent:true};
  const seen=[];const queue={renew:async()=>true};
  const store={loadResumableResult:async()=>null,persistResult:async()=>({status:'processed',needsExternalActions:false}),
    hasPrejudgeArtifacts:async()=>false,markPrejudgeNeedsReview:async()=>true,
    savePrejudgeArtifact:async input=>{seen.push(input);return {saved:true};}};
  const process=async args=>{await args.prejudgeCheckpoint({dealId:42,stageHistoryId:'101',loseDate:job.lose_date,
    artifact:{type:'judge_input',key:'a'.repeat(64),payload:{}}});return {status:'processed',analysis:{},dealData:{}};};
  const result=await runJob({job,queue,store,loadAudioWait:async()=>null,process,
    processOptions:{persistInputsBeforeJudge:true}});
  assert.equal(result.status,'processed');assert.equal(seen.length,1);
  assert.equal(seen[0].operationId,job.id);assert.equal(seen[0].leaseToken,job.lease_token);
  await assert.rejects(runJob({job:{...job,request_key:'manual:1'},queue,store,loadAudioWait:async()=>null,process,
    processOptions:{persistInputsBeforeJudge:true}}),PrejudgeStageError);
  assert.deepEqual(await runJob({job,queue,store:{...store,hasPrejudgeArtifacts:async()=>true},loadAudioWait:async()=>null,
    process:async()=>{throw Error('Повторное распознавание запрещено');},processOptions:{persistInputsBeforeJudge:true}}),
    {status:'needs_review',reason:'prejudge_materials_need_review'});
});

test('поздний звонок и ручной повтор допускаются с подтверждённым origin очереди аудио', async () => {
  const base={id:'00000000-0000-4000-8000-000000000101',lease_token:'00000000-0000-4000-8000-000000000102',
    deal_id:42,lose_date:'2026-11-04T00:00:00Z',silent:true};
  const queue={renew:async()=>true};let calls=0;
  const store={loadResumableResult:async()=>null,persistResult:async()=>({status:'processed',needsExternalActions:false}),
    hasPrejudgeArtifacts:async()=>false,markPrejudgeNeedsReview:async()=>true,savePrejudgeArtifact:async()=>({saved:true})};
  for (const trigger of ['audio_wait','manual','nightly']) {
    const requestKey=trigger==='audio_wait'?'audio-wait:42:1:2':`${trigger}:42`;
    const audioWait={state:trigger==='audio_wait'?'waiting':'done',lose_date:base.lose_date,
      origin_stage_history_id:'101',_scheduled_request_key:requestKey};
    const process=async args=>{calls++;assert.equal(args.expectedHistoryId,'101');
      await args.prejudgeCheckpoint({dealId:42,stageHistoryId:'101',loseDate:base.lose_date,
        artifact:{type:'begin',key:'a'.repeat(64),payload:{}}});return {status:'processed',analysis:{},dealData:{}};};
    const result=await runJob({job:{...base,trigger_type:trigger,request_key:requestKey},queue:{...queue,finishObsoleteNightly:async()=>false},
      store,loadAudioWait:async()=>audioWait,process,processOptions:{persistInputsBeforeJudge:true}});
    assert.equal(result.status,'processed');
  }
  assert.equal(calls,3);
});

test('новый протокол подключает журнал STT и разрешает повтор с сохранёнными материалами', async () => {
  const job={id:'00000000-0000-4000-8000-000000000101',lease_token:'00000000-0000-4000-8000-000000000102',
    deal_id:42,lose_date:'2026-11-04T00:00:00Z',request_key:'bitrix24:deal-stage-history:101',silent:true};
  const seen=[],marked=[]; const store={loadResumableResult:async()=>null,persistResult:async()=>({status:'processed',needsExternalActions:false}),
    hasPrejudgeArtifacts:async()=>true,hasUnsafePrejudgeResume:async()=>false,markPrejudgeNeedsReview:async x=>{marked.push(x);return true;},
    savePrejudgeArtifact:async()=>({saved:true}),claimSttAttempt:async x=>{seen.push(x);return {allowed:true,attemptId:'test'};},
    completeSttAttempt:async x=>{seen.push(x);return true;}};
  const options={persistInputsBeforeJudge:true,sttAttemptPolicy:{sha256:'a'.repeat(64),expectedEngine:'reserve:gigaam'}};
  const process=async args=>{const attempt=await args.prejudgeSttHooks.beforeStt({request:{file_id:1},audioSha256:'b'.repeat(64)});
    await args.prejudgeSttHooks.afterStt({request:{file_id:1},audioSha256:'b'.repeat(64),attempt});
    return {status:'processed',analysis:{},dealData:{}};};
  assert.equal((await runJob({job,queue:{renew:async()=>true},store,loadAudioWait:async()=>null,process,processOptions:options})).status,'processed');
  assert.equal(seen.length,2);assert.equal(seen[0].scope.stageHistoryId,'101');assert.equal(seen[0].policySha256,'a'.repeat(64));
  assert.deepEqual(await runJob({job,queue:{renew:async()=>true},store:{...store,hasUnsafePrejudgeResume:async()=>true},
    loadAudioWait:async()=>null,process,processOptions:options}),{status:'needs_review',reason:'prejudge_materials_need_review'});
  assert.deepEqual(await runJob({job,queue:{renew:async()=>true},store,loadAudioWait:async()=>null,
    process:async()=>{throw new SttAttemptsExhaustedError();},processOptions:options}),{status:'needs_review',reason:'stt_attempts_exhausted'});
  assert.equal(marked.at(-1).reason,'stt_attempts_exhausted');
});
