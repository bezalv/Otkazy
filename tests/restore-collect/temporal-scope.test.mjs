import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeCollectionAtLose } from '../../app/src/collect/temporal-scope.mjs';
import { normalizeCommunications, TemporalScopeError } from '../../app/src/collect/normalize.mjs';
import { buildJournal } from '../../app/src/analysis/journal.mjs';
import { buildCommunicationAnalytics } from '../../app/src/analysis/communication-analytics.mjs';
import { communicationRow } from '../../app/src/persistence/rows.mjs';

const cutoff = '2026-11-04T10:00:00Z';
const collection = () => ({ _status:'pending_normalization', deal_id:42, silent:true,
  _sources:Object.fromEntries(['calls','comments','tasks','openlines'].map(key=>[key,{complete:true}])),
  deal_data:{ lose_date:cutoff }, raw:{calls:[],comments:[],tasks:[],chats:[],sessions:[]} });
const call = (created, start, end) => ({ ID:'1', PROVIDER_ID:'VOXIMPLANT_CALL', CREATED:created, START_TIME:start, END_TIME:end });

test('время разговора важнее времени регистрации активности; будущий звонок исключается', () => {
  const c=collection();c.raw.calls=[call('2026-11-04T10:05:00Z','2026-11-04T09:55:00Z','2026-11-04T09:59:00Z'),
    { ...call('2026-11-04T09:00:00Z','2026-11-04T10:05:00Z','2026-11-04T10:06:00Z'), ID:'2' }];
  const result=scopeCollectionAtLose(c);
  assert.equal(result.error,undefined);assert.equal(result.collection.raw.calls.length,2);
  assert.equal(result.collection.raw.calls[0]._historical_event_time,'2026-11-04T09:55:00Z');
  assert.equal(result.excluded.calls,1);assert.equal(c.raw.calls[0].CREATED,'2026-11-04T10:05:00Z');
});

test('пересечение границы, равное время и неизвестное начало не считаются известным прошлым', () => {
  for(const c1 of [call('2026-11-04T09:59:00Z','2026-11-04T09:59:00Z','2026-11-04T10:01:00Z'),
    call(cutoff,cutoff,'2026-11-04T10:01:00Z'),call('2026-11-04T09:59:00Z',null,null),
    { ...call('2026-11-04T09:59:00Z','2026-11-04T09:59:00Z',null),SETTINGS:{RECORD_URL:'https://example.test/record'} },
    call('2026-11-04T09:59:00Z','2026-11-04T09:59:00Z',cutoff)]) {
    const c=collection();c.raw.calls=[c1];assert.equal(scopeCollectionAtLose(c).error.source,'calls');
  }
});

test('другой провайдер сохраняет ранний план без будущей записи', async () => {
  const c=collection();c.raw.calls=[{...call('2026-11-04T09:00:00Z','2026-11-04T11:00:00Z','2026-11-04T11:01:00Z'),
    PROVIDER_ID:'OTHER',SETTINGS:{RECORD_URL:'https://example.test/record'}}];
  const r=scopeCollectionAtLose(c);assert.equal(r.collection.raw.calls.length,1);assert.equal(r.excluded.calls,1);
  const n=await normalizeCommunications({collection:r.collection,temporalCutoff:cutoff});
  assert.equal(n.deal_data.communications[0].type,'task');assert.equal(n.deal_data.communications[0]._needs_transcription,undefined);
  const row=communicationRow(42,n.deal_data.communications[0],0);
  assert.equal(row.event_type,'task');assert.equal(row.event_id,'activity:1');
});

test('планируемая активность не превращается в состоявшийся разговор', async () => {
  const c=collection();c.raw.calls=[{...call('2026-11-04T08:00:00Z','2026-11-04T09:00:00Z','2026-11-04T09:30:00Z'),PROVIDER_ID:'OTHER'}];
  const scoped=scopeCollectionAtLose(c);
  const result=await normalizeCommunications({collection:scoped.collection,temporalCutoff:cutoff});
  const event=result.deal_data.communications[0];assert.equal(event.duration_end,event.duration_start);
  const analytics=buildCommunicationAnalytics(buildJournal({...result.deal_data,_historical_scope_checked:true}));
  assert.equal(analytics.comm_analytics.calls_meaningful,0);
});

test('поздний или недатированный скриншот старого комментария не отправляется на OCR', () => {
  for (const date of ['2026-11-04T11:00:00Z',null]) {
    const c=collection();c.raw.comments=[{ID:'3',CREATED:'2026-11-04T09:00:00Z',COMMENT:'Текст',
      FILES:{'4':{id:'4',type:'image',date}}}];
    assert.equal(scopeCollectionAtLose(c).error.source,'comments');
  }
});

test('созданные ранее задачи остаются планами, поздние события и задачи исключаются', async () => {
  const c=collection();c.raw.tasks=[{ID:'1',TITLE:'Предстоящий замер',CREATED_DATE:'2026-11-03T08:00:00Z',STATUS:'5',CLOSED_DATE:'2026-11-05T08:00:00Z'},
    {ID:'2',TITLE:'Поздняя задача',CREATED_DATE:'2026-11-05T08:00:00Z'}];
  c.raw.comments=[{ID:'3',CREATED:'2026-11-05T08:00:00Z',COMMENT:'После отказа'}];
  const scoped=scopeCollectionAtLose(c);const n=await normalizeCommunications({collection:scoped.collection,temporalCutoff:cutoff});
  assert.equal(n.deal_data.communications.length,1);const task=n.deal_data.communications[0];
  assert.equal(task.title,'Предстоящий замер');assert.equal(task.status,null);assert.equal(task.closed_date,null);
  const journal=buildJournal(n.deal_data);assert.match(journal.journal_text,/статус на момент отказа не подтверждён/);
  assert.equal(scoped.excluded.tasks,1);assert.equal(scoped.excluded.comments,1);
});

test('будущее голосовое и его файл не распознаются как сообщение или orphan', async () => {
  const c=collection();c.raw.chats=[{CHAT_ID:'5',CONNECTOR_ID:'wazzup'}];
  c.raw.sessions=[{session_id:'6',history:{chatId:'5',sessionId:'6',chat:{'5':{}},users:{},
    message:{'7':{id:7,date:'2026-11-04T11:00:00Z',senderid:1,text:'',params:{FILE_ID:[8]}}},
    files:{'8':{id:8,name:'voice.ogg',type:'audio'}}}}];
  let sent=0;const n=await normalizeCommunications({collection:c,temporalCutoff:cutoff,
    resolveFile:async()=>{sent++;},transcribeVoice:async()=>{sent++;}});
  assert.equal(sent,0);assert.equal(n.deal_data.communications.length,0);
});

test('недатированное содержательное сообщение и orphan-аудио не считаются отсутствием', async () => {
  for(const history of [
    {message:{'7':{id:7,text:'Клиент не ответил',senderid:1}},files:{}},
    {message:{},files:{'8':{id:8,name:'voice.ogg',type:'audio'}}},
  ]) {
    const c=collection();c.raw.chats=[{CHAT_ID:'5',CONNECTOR_ID:'wazzup'}];
    c.raw.sessions=[{session_id:'6',history:{...history,chatId:'5',sessionId:'6',chat:{'5':{}},users:{}}}];
    await assert.rejects(normalizeCommunications({collection:c,temporalCutoff:cutoff}), TemporalScopeError);
  }
});

test('позднее или недатированное вложение старого сообщения не отправляется на STT', async () => {
  for (const date of ['2026-11-04T11:00:00Z',null]) {
    const c=collection();c.raw.chats=[{CHAT_ID:'5',CONNECTOR_ID:'wazzup'}];
    c.raw.sessions=[{session_id:'6',history:{chatId:'5',sessionId:'6',chat:{'5':{}},users:{},
      message:{'7':{id:7,date:'2026-11-04T09:00:00Z',senderid:1,text:'',params:{FILE_ID:[8]}}},
      files:{'8':{id:8,name:'voice.ogg',type:'audio',date}}}}];
    let sent=0;await assert.rejects(normalizeCommunications({collection:c,temporalCutoff:cutoff,
      resolveFile:async()=>{sent++;},transcribeVoice:async()=>{sent++;}}),TemporalScopeError);
    assert.equal(sent,0);
  }
});

test('отдельная картинка без сообщения не исчезает из истории как будто её не было', async () => {
  const c=collection();c.raw.chats=[{CHAT_ID:'5',CONNECTOR_ID:'wazzup'}];
  c.raw.sessions=[{session_id:'6',history:{chatId:'5',sessionId:'6',chat:{'5':{}},users:{},message:{},
    files:{'8':{id:8,name:'photo.jpg',type:'image',date:'2026-11-04T09:00:00Z'}}}}];
  await assert.rejects(normalizeCommunications({collection:c,temporalCutoff:cutoff}),TemporalScopeError);
});

test('аналитика проверенного входа не сдвигает cutoff за границу отказа', () => {
  const data={lose_date:cutoff,_historical_scope_checked:true,communications:[{type:'chat',date:'2026-11-04T09:00:00Z',role:'Клиент',text:'Здравствуйте'}]};
  const analytics=buildCommunicationAnalytics(buildJournal(data));
  assert.equal(analytics.comm_analytics.cutoff_at,'2026-11-04T10:00:00.000Z');
  assert.throws(()=>buildCommunicationAnalytics(buildJournal({...data,communications:[{type:'chat',date:'2026-11-04T11:00:00Z',role:'Клиент',text:'Позже'}]})),/вне исторической границы/);
});
