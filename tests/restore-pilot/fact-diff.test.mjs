import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorizeReasons, compareCallFacts, summarizeJudgeEvidence } from '../../app/src/pilot/fact-diff.mjs';

const ts = '2026-10-30T12:00:00Z';
const fact = (source, actor, content = 'тестовая речь', extra = {}) => ({ source, actor, ts, direction: 'outgoing', content, ...extra });
const comm = (extra = {}) => ({ type: 'call', date: ts, direction: 'outgoing', activity_id: 100, ...extra });

test('кандидат mono→stereo сопоставляется только по времени и направлению, текст не выходит наружу', () => {
  const privateText = 'конфиденциальный-синтетический-текст';
  const old = [fact('call_transcript', 'unknown', `Запись без разделения сторон (одна звуковая дорожка, кто именно говорит — неизвестно): ${privateText} привет клиент`)];
  const current = [fact('call_transcript', 'manager', `${privateText} привет`), fact('call_transcript', 'client', 'клиент')];
  const result = compareCallFacts({ previousFacts: old, currentFacts: current, currentCommunications: [comm()] });
  assert.equal(result.candidate_groups, 1);
  assert.equal(result.id_verified_groups, 0);
  assert.equal(result.transitions.mono_unknown_to_stereo, 1);
  assert.equal(result.lexical_overlap.same_normalized, 1);
  assert.ok(result.limitations.includes('time_direction_match_is_not_identity'));
  assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.equal(JSON.stringify(result).includes(ts), false);
  assert.equal(JSON.stringify(result).includes('100'), false);
});

test('старое событие без записи и новый транскрипт даёт только категорию события', () => {
  const result = compareCallFacts({ previousFacts: [fact('call_event', 'system', 'Звонок 12 сек, записи нет')],
    currentFacts: [fact('call_transcript', 'manager'), fact('call_transcript', 'client')], currentCommunications: [comm()] });
  assert.equal(result.transitions.event_to_stereo, 1);
  assert.equal(result.old_event_to_transcript_reasons.no_recording, 1);
  assert.equal(result.candidate_groups, 1);
});

test('временные зоны нормализуются, отсутствующие даты и несовпадающие направления не сопоставляются', () => {
  const result = compareCallFacts({ previousFacts: [fact('call_event', 'system')],
    currentFacts: [fact('call_event', 'system', '', { ts: '2026-10-30T19:00:00+07:00' }),
      fact('call_event', 'system', '', { ts: 'ошибка' }), fact('call_event', 'system', '', { direction: null })],
    currentCommunications: [comm()] });
  assert.equal(result.transitions.event_to_event, 1);
  assert.equal(result.invalid_new_facts, 2);
});

test('повтор роли, несколько текущих активностей или конфликт ID не считаются идентичностью', () => {
  const duplicated = compareCallFacts({ previousFacts: [fact('call_transcript', 'manager'), fact('call_transcript', 'manager')],
    currentFacts: [fact('call_transcript', 'manager')], currentCommunications: [comm()] });
  assert.equal(duplicated.ambiguous_groups, 1);
  const multi = compareCallFacts({ previousFacts: [fact('call_event', 'system')], currentFacts: [fact('call_event', 'system')],
    currentCommunications: [comm(), comm({ activity_id: 101 })] });
  assert.equal(multi.ambiguous_groups, 1);
  const mismatch = compareCallFacts({ previousFacts: [fact('call_event', 'system', '', { activity_id: '101' })],
    currentFacts: [fact('call_event', 'system')], currentCommunications: [comm()] });
  assert.equal(mismatch.id_mismatch_groups, 1);
  const match = compareCallFacts({ previousFacts: [fact('call_event', 'system', '', { activity_id: '100' })],
    currentFacts: [fact('call_event', 'system')], currentCommunications: [comm()] });
  assert.equal(match.id_verified_groups, 1);
  assert.ok(match.limitations.includes('activity_id_does_not_prove_identical_audio_bytes'));
  const partial = compareCallFacts({ previousFacts: [fact('call_transcript', 'manager', '', { activity_id: '100' }), fact('call_transcript', 'client')],
    currentFacts: [fact('call_transcript', 'manager'), fact('call_transcript', 'client')], currentCommunications: [comm()] });
  assert.equal(partial.id_verified_groups, 0);
  assert.equal(partial.candidate_groups, 1);
  const partialMismatch = compareCallFacts({ previousFacts: [fact('call_transcript', 'manager', '', { activity_id: '101' }), fact('call_transcript', 'client')],
    currentFacts: [fact('call_transcript', 'manager'), fact('call_transcript', 'client')], currentCommunications: [comm()] });
  assert.equal(partialMismatch.id_verified_groups, 0);
  assert.equal(partialMismatch.id_mismatch_groups, 1);
});

test('ошибочные пакеты и неожиданные поля не становятся результатом', () => {
  assert.throws(() => compareCallFacts({ previousFacts: null, currentFacts: [], currentCommunications: [] }));
  assert.throws(() => compareCallFacts({ previousFacts: [], currentFacts: [], currentCommunications: null }));
  const secret = 'не выводить этот текст';
  const result = compareCallFacts({ previousFacts: [fact('call_event', 'system', secret, { extra: secret })],
    currentFacts: [fact('call_transcript', 'manager', secret)], currentCommunications: [comm({ extra: secret })] });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('ссылки судьи подсчитываются по источникам и ролям, не раскрывая тексты', () => {
  const result = summarizeJudgeEvidence({ manager_mistakes: [{ proof_fact_ids: ['f1', 'metric:test', 'missing'] }],
    key_signals: [], risk_factors: [] }, [{ fact_id: 'f1', source: 'call_transcript', actor: 'client', content: 'секретная речь' }], { test: 3 });
  assert.equal(result.available, true);
  assert.equal(result.sections.manager_mistakes.by_source.call_transcript, 1);
  assert.equal(result.sections.manager_mistakes.by_source.metric, 1);
  assert.equal(result.sections.manager_mistakes.by_actor.client, 1);
  assert.equal(result.sections.manager_mistakes.missing, 1);
  assert.equal(JSON.stringify(result).includes('секретная речь'), false);
  assert.deepEqual(summarizeJudgeEvidence({ manager_mistakes: [] }, []), { available: false });
});

test('несуществующая метрика отсутствует, а недоступные metrics не изображаются отсутствующей метрикой', () => {
  const judge = { manager_mistakes: [{ proof_fact_ids: ['metric:test', 'metric:missing'] }], key_signals: [], risk_factors: [] };
  const available = summarizeJudgeEvidence(judge, [], { test: 0 });
  assert.equal(available.sections.manager_mistakes.by_source.metric, 1);
  assert.equal(available.sections.manager_mistakes.missing, 1);
  assert.equal(available.sections.manager_mistakes.unverified, 0);
  const unavailable = summarizeJudgeEvidence(judge, [], null);
  assert.equal(unavailable.sections.manager_mistakes.by_source.metric, 0);
  assert.equal(unavailable.sections.manager_mistakes.missing, 0);
  assert.equal(unavailable.sections.manager_mistakes.unverified, 2);
});

test('основания судьи сводятся только к признакам слов, не считаются доказательством', () => {
  const result = categorizeReasons({ verdict_reason_short: 'Клиент указал высокую цену', exact_reason: 'Стоимость превышает бюджет' });
  assert.equal(result.mentions_price, true);
  assert.equal(result.mentions_competitor, false);
  assert.equal(JSON.stringify(result).includes('Клиент указал'), false);
  assert.ok(result.limitations.includes('keyword_flags_are_not_proof_or_explanation'));
  assert.deepEqual(categorizeReasons({}), { available: false });
});
