import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runManualVoicePipeline } from '../../app/src/pilot/manual-voice-pipeline.mjs';

const cutoff='2026-11-04T12:00:00.000Z',from='2026-01-01T00:00:00.000Z';
async function fixture() {
  const calls=[], counts={uploads:0,downloads:0,roles:0,judge:0,writer:0};
  const state={recordedCall:false,extraCallFile:false,malformedCallFiles:false,conflictingRecordFile:false,otherVoice:false,selectedVideo:false,image:false,screenshot:false,wappiKnown:false,changedStage:false,lookupMismatch:false,changedHistory:false};
  const h={chatId:100,sessionId:80,chat:{100:{entityId:'wazzup|71|client|external'}},users:{55:{connector:true}},
    files:{'200':{id:200,type:'audio',name:'voice.ogg'}},message:{
      1:{id:1,senderid:55,date:'2026-11-04T10:00:00Z',text:'=== Исходящее сообщение ===\nМожем предложить вам замену окна.'},
      2:{id:2,senderid:55,date:'2026-11-04T10:01:00Z',text:'',params:{FILE_ID:[200]}}}};
  let histories=0,disk=0;
  const bitrix={async request(method,body){calls.push({method,body});
    if(method==='crm.deal.userfield.list')return {result:[{LIST:[{ID:'1',VALUE:'Другая'}]}]};
    if(method==='crm.deal.get')return {result:{ID:'42',STAGE_ID:'C23:LOSE',ASSIGNED_BY_ID:'65',UF_CRM_1584703948317:'1'}};
    if(method==='crm.stagehistory.list')return {result:{items:[{ID:state.changedStage?'102':'101',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}]},total:1};
    if(method==='crm.activity.list'&&body.filter.PROVIDER_ID==='IMOPENLINES_SESSION')return {result:[]};
    if(method==='imopenlines.crm.chat.get')return {result:[{CHAT_ID:100,CONNECTOR_ID:state.wappiKnown?'opaque':'wazzup',CONNECTOR_TITLE:state.wappiKnown?'Wappi':'wazzup'}]};
    if(method==='imopenlines.session.history.get'){
      histories++;const copy=structuredClone(h);if(state.changedHistory&&histories>1)copy.message[2].params.FILE_ID=[201];
      if(state.wappiKnown){copy.chat[100].entityId='opaque|71|client|external';copy.message[1].text='Нам нужны условия по замене окон.';}
      if(state.selectedVideo){copy.files['200'].type='video';copy.files['200'].name='video.mp4';}
      if(state.otherVoice){copy.message[3]={id:3,senderid:55,date:'2026-11-04T10:02:00Z',text:'',params:{FILE_ID:[201]}};
        copy.files['201']={id:201,type:'audio',name:'other.ogg'};}
      if(state.image){copy.message[3]={id:3,senderid:55,date:'2026-11-04T10:02:00Z',text:'',params:{FILE_ID:[201]}};
        copy.files['201']={id:201,type:'image',name:'photo.png'};}
      return {result:copy};
    }
    if(method==='imopenlines.v2.Session.list')return {result:{sessions:[{id:80,chatId:100,configId:71,
      crmEntityType:'deal',crmEntityId:state.lookupMismatch?43:42,dateCreate:'2026-11-01T00:00:00.000Z'}],hasNextPage:false}};
    if(method==='disk.file.get')return {result:{ID:String(body.id),NAME:Number(body.id)===99?'call.mp3':'voice.ogg',SIZE:'2048',DOWNLOAD_URL:`https://dinalnsk.bitrix24.ru/rest/65/abc/download/?token=${++disk}`}};
    if(method==='crm.activity.list'&&body.filter.TYPE_ID===2&&state.recordedCall)return {result:[{ID:'301',CREATED:'2026-11-04T09:00:00Z',
      START_TIME:'2026-11-04T09:00:00Z',END_TIME:'2026-11-04T09:01:00Z',SETTINGS:{RECORD_URL:'https://example.invalid/?fileId=99'},
      ...(state.extraCallFile?{FILES:[{url:'https://example.invalid/?fileId=99'},{id:88}]}:{}),
      ...(state.malformedCallFiles?{FILES:'bad'}:{}),
      ...(state.conflictingRecordFile?{RECORD_FILE_ID:88}:{})}]};
    if(method==='crm.timeline.comment.list'&&state.screenshot)return {result:[{ID:5,COMMENT:'скриншот',FILES:{30:{id:30,type:'image'}}}]};
    if(method==='crm.activity.list'||method==='crm.timeline.comment.list')return {result:[]};
    if(method==='tasks.task.list')return {result:{tasks:[]}};
    throw new Error('unexpected');
  }};
  const llm={async complete(body,options={}) {
    if(options.role==='chat-role-inference'){
      counts.roles++;const entries=JSON.parse(body.messages[1].content).messages;
      return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({roles:entries.map((entry,i)=>({id:entry.id,
        role:i?'client':'manager',impact:'not_applicable'}))})}}]};
    }
    if(options.role==='judge'){
      counts.judge++;return {choices:[{message:{content:JSON.stringify({verdict:'недостаточно_данных',verdict_reason_short:'Недостаточно',
        recoverable_level:null,closure_reason_class:'other',misplaced:false,correct_stage:null,exact_reason:'Недостаточно данных',
        manager_mistakes:[],key_signals:[],risk_factors:[],questions_for_manager:[]})}}]};
    }
    if(options.role==='writer'){counts.writer++;return {choices:[{message:{content:'Тестовый комментарий'}}]};}
    throw Error('unexpected');
  }};
  const server=createServer(async(req,res)=>{counts.uploads++;for await(const chunk of req)void chunk;
    const stereo=req.url.includes('stereo');res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true,model:'ai-sage/gigaam-v3',channels:stereo?2:1,
      segments:stereo?[{channel:0,start:0,end:1,text:'Здравствуйте'},
        {channel:1,start:1,end:2,text:'Мы уже заказали окна в другом месте.'}]
        :[{channel:0,start:0,end:1,text:'Нет, спасибо, мы уже заказали окна в другом месте.'}]}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const tempRoot=await mkdtemp(join(tmpdir(),'manual-voice-test-'));
  const controller=new AbortController();
  const args={dealId:42,expectedHistoryId:'101',expectedLoseDate:cutoff,from,maxPages:20,
    chatId:100,sessionId:80,messageId:2,fileId:200,bitrixRestBase:'https://dinalnsk.bitrix24.ru/rest/65/abc/',
    silent:true,semanticChatRoles:true,bitrix,llm,sttUrl:`http://127.0.0.1:${server.address().port}`,
    sttKey:'local-test-key',reserveRequest:request,tempRoot,probeAudioOnly:async()=>true,
    fetchImpl:async()=>{counts.downloads++;return new Response(Buffer.alloc(2048),{status:200});},
    judgeSystemPrompt:'Промпт судьи',writerSystemPrompt:'Промпт писателя',
    nowMs:Date.parse('2026-11-05T00:00:00Z'),audioWaitEnabledAt:'2026-11-01T00:00:00Z',wait:async()=>{},signal:controller.signal};
  return {args,calls,counts,state,controller,async close(){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));
    assert.deepEqual(await readdir(tempRoot),[]);await rmdir(tempRoot);}};
}

test('одно распознанное голосовое попадает в полный ручной конвейер без доставки',async()=>{
  const f=await fixture();try {
    const result=await runManualVoicePipeline(f.args);
    assert.equal(result.status,'unverified');assert.equal(result.preliminary.status,'processed');
    assert.equal(result.delivery_permitted,false);assert.equal(result.history_complete,null);
    assert.equal(f.counts.uploads,1);assert.equal(f.counts.downloads,1);assert.equal(f.counts.roles,1);assert.equal(f.counts.judge,1);
    const facts=result.preliminary.analysis?.multi_agent_analysis?.facts_packet?.facts || [];
    assert.equal(facts.filter(x=>x.source==='chat_voice_transcript').length,1);
    assert.ok(f.calls.filter(x=>x.method==='disk.file.get').every(x=>String(x.body.id)==='200'));
    assert.ok(f.calls.every(x=>!/(?:update|add|delete|send)/i.test(x.method)));
  } finally {await f.close();}
});

test('другие голосовые и звонки не подменяются и блокируют вердикт',async()=>{
  for(const field of ['recordedCall','otherVoice','image','screenshot']){
    const f=await fixture();f.state[field]=true;try {
      if(field==='otherVoice'||field==='image')await assert.rejects(runManualVoicePipeline(f.args));
      else {const result=await runManualVoicePipeline(f.args);assert.notEqual(result.preliminary.status,'processed');}
      assert.equal(f.counts.judge,0);
      assert.ok(f.counts.uploads<=1);assert.ok(f.calls.filter(x=>x.method==='disk.file.get').every(x=>String(x.body.id)==='200'));
    } finally {await f.close();}
  }
});

test('Wappi с известным клиентом распознаёт голосовое с обязательной проверкой аудио',async()=>{
  const f=await fixture();f.state.wappiKnown=true;try {
    const result=await runManualVoicePipeline(f.args);
    assert.equal(result.status,'unverified');assert.equal(result.preliminary.status,'processed');
    assert.equal(f.counts.uploads,1);assert.equal(f.counts.roles,0);
    const facts=result.preliminary.analysis?.multi_agent_analysis?.facts_packet?.facts || [];
    assert.equal(facts.filter(x=>x.source==='chat_voice_transcript').length,1);
  } finally {await f.close();}
});

test('разрешённый звонок и голосовое распознаются отдельно с разными каналами',async()=>{
  const f=await fixture();f.state.recordedCall=true;try {
    const result=await runManualVoicePipeline({...f.args,callActivityId:301,callFileId:99});
    assert.equal(result.status,'unverified');assert.equal(result.preliminary.status,'processed');
    assert.equal(result.delivery_permitted,false);assert.equal(f.counts.uploads,2);assert.equal(f.counts.downloads,2);
    const facts=result.preliminary.analysis?.multi_agent_analysis?.facts_packet?.facts || [];
    assert.equal(facts.filter(x=>x.source==='chat_voice_transcript').length,1);
    assert.ok(facts.some(x=>x.source==='call_transcript'));
    assert.deepEqual([...new Set(f.calls.filter(x=>x.method==='disk.file.get').map(x=>String(x.body.id)))].sort(),['200','99']);
  } finally {await f.close();}
});

test('несовпадающие звонок и файл не допускают платную обработку',async()=>{
  for(const change of [{callActivityId:302,callFileId:99},{callActivityId:301,callFileId:98}]){
    const f=await fixture();f.state.recordedCall=true;try {
      const result=await runManualVoicePipeline({...f.args,...change});
      assert.notEqual(result.preliminary.status,'processed');assert.equal(f.counts.uploads,0);assert.equal(f.counts.judge,0);
    } finally {await f.close();}
  }
});

test('отсутствующий звонок и дополнительные или противоречивые файлы не допускают судью',async()=>{
  for(const field of ['missing','extraCallFile','malformedCallFiles','conflictingRecordFile']){
    const f=await fixture();f.state.recordedCall=field!=='missing';if(field!=='missing')f.state[field]=true;
    try {
      const result=await runManualVoicePipeline({...f.args,callActivityId:301,callFileId:99});
      assert.notEqual(result.preliminary.status,'processed');assert.equal(f.counts.uploads,0);assert.equal(f.counts.judge,0);
    } finally {await f.close();}
  }
});

test('выбранный видеофайл при известном авторе не становится распознанным голосовым',async()=>{
  const f=await fixture();f.state.wappiKnown=true;f.state.selectedVideo=true;try {
    const result=await runManualVoicePipeline(f.args);
    assert.equal(result.status,'blocked');assert.equal(f.counts.uploads,0);assert.equal(f.counts.judge,0);
  } finally {await f.close();}
});

test('несовпадение выбранных параметров или привязки не допускает распознавание',async()=>{
  for(const change of [f=>f.args.messageId=3,f=>f.args.fileId=201,f=>f.state.lookupMismatch=true,
    f=>f.state.changedStage=true,f=>f.state.changedHistory=true]){
    const f=await fixture();change(f);try {
      await assert.rejects(runManualVoicePipeline(f.args));assert.equal(f.counts.uploads,0);assert.equal(f.counts.judge,0);
    } finally {await f.close();}
  }
});

test('эксперимент требует тихий режим, ограниченное окно и действующий сигнал',async()=>{
  const f=await fixture();try {
    for(const change of [{silent:false},{semanticChatRoles:false},{from:'2024-01-01T00:00:00Z'},
      {signal:null},{reserveRequest:null},{callActivityId:301},{callActivityId:301,callFileId:200},
      {bitrixRestBase:'https://other.invalid/rest/65/abc/'}]) await assert.rejects(runManualVoicePipeline({...f.args,...change}));
    assert.equal(f.calls.length,0);assert.equal(f.counts.uploads,0);
  } finally {await f.close();}
});
