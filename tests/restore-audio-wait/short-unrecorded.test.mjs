import {test} from 'node:test';
import assert from 'node:assert/strict';
import {awAssess,awNonBlockingReason,planAudioWait} from '../../app/src/audio-wait/index.mjs';

const now=Date.parse('2026-11-20T06:55:25.032Z'),lose='2026-11-20T06:50:06Z';
const short={ID:'1697414',PROVIDER_ID:'VOXIMPLANT_CALL',COMPLETED:'Y',
  CREATED:'2026-11-19T09:58:44+03:00',START_TIME:'2026-11-19T09:58:44+03:00',END_TIME:'2026-11-19T09:58:48+03:00'};
const assess=(calls,saved=null,at=now)=>awAssess(calls,lose,'2026-01-01T00:00:00Z',saved,at);
const saved={state:'expired',lose_date:lose,first_seen_at:new Date(now).toISOString(),deadline_at:new Date(now+86400000).toISOString(),
  observations:{1697414:{activity_id:'1697414',ended_at:short.END_TIME,first_missing_at:new Date(now).toISOString(),first_audio_seen_at:null}}};

test('127888: четырёхсекундное событие без файла не блокирует доступные разговоры',()=>{
  const snapshot=structuredClone(short);
  assert.equal(assess([short,{...short,ID:'1697424',FILES:[{id:1715076,url:'https://example.test/audio'}]}]).state,'ready');
  assert.deepEqual(short,snapshot);
  assert.equal(awNonBlockingReason(short),'short_unrecorded_content_unknown');
});
test('порог 5 секунд не применяется к записи, известному ID файла и ранее доступному аудио',()=>{
  for(const changed of [{FILES:[{id:7}]},{STORAGE_ELEMENT_IDS:[7]}])assert.equal(assess([{...short,...changed}]).state,'waiting');
  assert.equal(awNonBlockingReason({...short,FILES:[{url:'https://example.test/audio'}]}),null);
  assert.equal(awNonBlockingReason(short,{first_audio_seen_at:new Date(now).toISOString()}),null);
  for(const seconds of [5,6,28,35,213]){
    const call={...short,END_TIME:new Date(Date.parse(short.START_TIME)+seconds*1000).toISOString()};
    assert.equal(assess([call]).state,seconds<=5?'ready':'waiting');
  }
});
test('существующая очередь освобождается только при наличии самого короткого события',()=>{
  const active={...saved,state:'waiting'},before=structuredClone(active);
  const out=assess([short],active);
  assert.equal(out.state,'ready');assert.equal(out.queue.observations['1697414'].non_blocking_reason,'short_unrecorded_content_unknown');
  assert.deepEqual(active,before);assert.equal(assess([],active).state,'waiting');
  assert.equal(assess([short],{...active,observations:{1697414:{...active.observations[1697414],first_audio_seen_at:new Date(now).toISOString()}}}).state,'waiting');
});
test('явный повтор истёкшей 127888 проходит без изменения исторической очереди',()=>{
  const args={stageId:'C23:LOSE',callsComplete:true,calls:[short],loseDate:lose,enabledAt:'2026-01-01T00:00:00Z',saved:{...saved,_recheck_terminal:true},nowMs:now+5*86400000};
  assert.deepEqual(planAudioWait(args),{action:'analyze',queue:null});
  assert.equal(planAudioWait({...args,saved}).action,'skip');
  assert.equal(planAudioWait({...args,calls:[]}).action,'skip');
});
test('настоящая задержка записи сохраняет суточное ожидание и диагностические данные',()=>{
  const call={...short,END_TIME:new Date(Date.parse(short.START_TIME)+90_000).toISOString()};
  const first=assess([call]);
  assert.equal(first.queue.observations['1697414'].duration_seconds,90);
  const active={...first.queue,state:'waiting'};
  assert.equal(assess([call],active,now+7*3600000).state,'waiting');
  assert.equal(assess([{...call,FILES:[{url:'https://example.test/audio'}]}],active,now+7*3600000).state,'ready');
  const expired=planAudioWait({stageId:'C23:LOSE',callsComplete:true,calls:[call],loseDate:lose,enabledAt:'2026-01-01',saved:active,nowMs:now+86400000});
  assert.match(expired.classification.exact_reason,/#1697414 \(90 сек\)/);
  assert.match(expired.classification.exact_reason,/не измеренная задержка/);
});
