import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleFacts} from '../../app/src/analysis/facts-assembler.mjs';
import {transcribeCalls} from '../../app/src/calls/index.mjs';
import {buildCommunicationAnalytics} from '../../app/src/analysis/communication-analytics.mjs';

const coverage={version:1,status:'incomplete',total_fragments:3,unrecognized_count:2,
  unrecognized_segments:[{channel:0,start:0.2,end:1.2},{channel:1,start:4,end:5}]};

test('приветствие в неполном звонке не объявляется доказательством отсутствия разговора', async()=>{
  const deal={deal_id:42,communications:[{type:'call',activity_id:'1',date:'2026-11-01T00:00:00Z',
    direction:'incoming',duration_seconds:10,_needs_transcription:true,audio_url:'https://example.invalid/a?fileId=1'}]};
  const transcribe=async()=>({success:true,activity_id:'1',channel_count:2,formatted_dialog:'Клиент: Алло',
    client_text:'Алло',manager_text:'',conversation:[{id:1,speaker:'Клиент',text:'Алло'}],total_replicas:1,
    transcription_coverage:coverage});
  const collected=await transcribeCalls({dealData:deal,transcribe});
  assert.deepEqual(collected.communications[0].transcription_coverage,coverage);
  const facts=assembleFacts({...deal,communications:collected.communications},'prompt').facts_packet.facts;
  assert.ok(facts.some(f=>f.content.includes('не распознано фрагментов 2 из 3')&&f.content.includes('0.2–1.2')));
  assert.ok(facts.some(f=>f.actor==='client'&&f.content==='Алло'));
  assert.ok(!facts.some(f=>f.content.includes('разговор не состоялся')));
});

test('голосовое с незаполненными отрезками сообщает судье их границы и количество',()=>{
  const result=assembleFacts({deal_id:42,communications:[{type:'chat',date:'2026-11-01T00:00:00Z',
    text:'Текст голосового',role:'client',_has_audio_transcript:true,transcription_coverage:[coverage]}]},'prompt');
  assert.ok(result.facts_packet.facts.some(f=>f.content.includes('2 из 3')&&f.content.includes('4–5 сек')));
});

test('исторический результат без отметки отличается от новой проверки фрагментов',()=>{
  const result=assembleFacts({deal_id:42,communications:[{type:'call',date:'2026-11-01T00:00:00Z',
    direction:'incoming',transcript_client_text:'Алло',transcription_coverage:{version:0,status:'unknown_legacy'}}]},'prompt');
  const facts=result.facts_packet.facts;
  assert.ok(facts.some(f=>f.content.includes('полнота неизвестна')));
  assert.ok(!facts.some(f=>f.content.includes('разговор не состоялся')));
});

function evaluateCall(call) {
  const input={deal_id:42,lose_date:'2026-11-04T00:00:00Z',date_create:'2026-10-01T00:00:00Z',
    communications:[{type:'call',date:'2026-11-01T00:00:00Z',direction:'outgoing',duration_seconds:45,
      _needs_transcription:true,...call}]};
  return {facts:assembleFacts(input,'prompt').facts_packet.facts,
    analytics:buildCommunicationAnalytics(input,new Date('2026-11-05T00:00:00Z')).comm_analytics};
}

for (const [name,call] of [
  ['автоответчик и пробелы',{transcript_client_text:'Абонент временно недоступен',transcription_coverage:coverage}],
  ['пустой результат и пробелы',{transcription_coverage:coverage}],
  ['старый результат',{transcript_client_text:'Абонент временно недоступен',transcription_coverage:{version:0,status:'unknown_legacy'}}],
  ['неполная моно',{_transcript_mode:'mono',transcript_manager_text:'Я уже купил окна в другом месте',transcription_coverage:coverage}],
  ['менеджер и приветствие клиента',{transcript_client_text:'Алло',transcript_manager_text:'Здравствуйте, звоню по вашему заказу окон.',transcription_coverage:coverage}],
]) test(`${name}: контакт неизвестен, звонок не становится успешным`,()=>{
  const {facts,analytics}=evaluateCall(call);
  assert.equal(analytics.calls_total,1);assert.equal(analytics.calls_contact_unknown,1);
  assert.equal(analytics.calls_meaningful,0);assert.equal(analytics.calls_last_successful,null);
  assert.equal(analytics.calls_no_conversation,0);
  assert.ok(facts.some(f=>f.content.includes('Контакт с клиентом')&&f.content.includes('не установлен')));
  assert.ok(!facts.some(f=>f.actor==='client'&&/абонент/i.test(f.content)));
  if (/абонент/i.test(call.transcript_client_text || '')) assert.ok(facts.some(f=>f.actor==='system'&&/абонент/i.test(f.content)));
});

test('робот и затем содержательная речь клиента: оба распознанных фрагмента сохранены',()=>{
  const {facts,analytics}=evaluateCall({transcript_client_text:'Абонент временно недоступен. Я уже купил окна у конкурентов.',
    transcription_coverage:coverage});
  assert.ok(facts.some(f=>f.actor==='system'&&f.content.includes('Абонент временно недоступен')));
  assert.ok(facts.some(f=>f.actor==='client'&&f.content.includes('Я уже купил окна')));
  assert.ok(!facts.some(f=>f.actor==='client'&&f.content.includes('Абонент')));
  assert.equal(analytics.calls_meaningful,1);assert.equal(analytics.calls_contact_unknown,undefined);
});

test('полный разговор сохраняет прежние метрики',()=>{
  const {facts,analytics}=evaluateCall({transcript_client_text:'Я уже купил окна у конкурентов.'});
  assert.ok(facts.some(f=>f.actor==='client'&&f.content.includes('Я уже купил окна')));
  assert.equal(analytics.calls_meaningful,1);assert.equal(analytics.calls_contact_unknown,undefined);
});

test('слитые слова робота и клиента сохраняются целиком без ложного авторства',()=>{
  const text='Голосовая почта я уже купил окна у конкурентов';
  const {facts,analytics}=evaluateCall({transcript_client_text:text,transcription_coverage:coverage});
  assert.ok(facts.some(f=>f.actor==='unknown'&&f.content.includes(text)));
  assert.ok(!facts.some(f=>f.actor==='client'&&f.content.includes('Голосовая почта')));
  assert.equal(analytics.calls_contact_unknown,1);assert.equal(analytics.calls_meaningful,0);
});

for (const prefix of ['Здравствуйте я голосовой помощник', 'Абонент не на связи']) {
  test(`длинная непунктированная фраза с системным маркером не становится словами клиента: ${prefix}`,()=>{
    const text=(prefix+' '+('дополнительная информация '.repeat(12))).trim();
    const {facts,analytics}=evaluateCall({transcript_client_text:text,transcription_coverage:coverage});
    assert.ok(facts.some(f=>f.actor==='unknown'&&f.content.includes(text)));
    assert.ok(!facts.some(f=>f.actor==='client'&&f.content.includes(prefix)));
    assert.equal(analytics.calls_contact_unknown,1);
  });
}

for (const text of ['Объект сейчас недоступен, перенесите замер на пятницу',
  'Мой секретарь сказал, что доставка в пятницу не подходит', 'Не актуально']) {
  test(`обычные слова клиента не превращаются в робота: ${text}`,()=>{
    const {facts,analytics}=evaluateCall({transcript_client_text:text,transcription_coverage:coverage});
    assert.ok(facts.some(f=>f.actor==='client'&&f.content.includes(text)));
    assert.equal(analytics.calls_meaningful,1);
  });
}

test('длинная последовательность одних приветствий не подтверждает контакт',()=>{
  const text=Array(60).fill('алло').join(' ');
  const {facts,analytics}=evaluateCall({transcript_client_text:text,transcription_coverage:coverage});
  assert.ok(facts.some(f=>f.actor==='client'&&f.content.includes(text)));
  assert.equal(analytics.calls_contact_unknown,1);assert.equal(analytics.calls_meaningful,0);
});

for (const text of ['Вы не туда попали','Ошиблись номером','Его сейчас нет']) {
  test(`ответ другого человека не приписывается клиенту: ${text}`,()=>{
    const {facts,analytics}=evaluateCall({transcript_client_text:text,transcription_coverage:coverage});
    assert.ok(facts.some(f=>f.actor==='unknown'&&f.content.includes(text)));
    assert.ok(!facts.some(f=>f.actor==='client'&&f.content.includes(text)));
    assert.equal(analytics.calls_contact_unknown,1);
  });
}

test('после слов другого человека текст сохраняется без назначения автора',()=>{
  const {facts,analytics}=evaluateCall({transcript_client_text:'Вы не туда попали. Не актуально.',transcription_coverage:coverage});
  assert.ok(facts.some(f=>f.actor==='unknown'&&f.content.includes('Вы не туда попали')));
  assert.ok(facts.some(f=>f.actor==='unknown'&&f.content.includes('Не актуально')));
  assert.equal(analytics.calls_contact_unknown,1);
});

test('признак чужого собеседника не скрывает клиентскую речь другого звонка',()=>{
  const input={deal_id:42,communications:[
    {type:'call',date:'2026-11-01T00:00:00Z',transcript_client_text:'Вы не туда попали.',transcription_coverage:coverage},
    {type:'call',date:'2026-11-02T00:00:00Z',transcript_client_text:'Не актуально.',transcription_coverage:coverage},
  ]};
  const facts=assembleFacts(input,'prompt').facts_packet.facts;
  assert.ok(facts.some(f=>f.actor==='unknown'&&f.content.includes('Вы не туда попали')));
  assert.ok(facts.some(f=>f.actor==='client'&&f.content.includes('Не актуально')));
});
