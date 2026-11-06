import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInvestigation } from '../../app/src/pilot/investigate.mjs';

const timestamp = '2026-10-30T12:00:00Z';
const secret = 'тестовый текст, который нельзя выводить';
const baseline = {
  deal_id: 126198, analysis_id: '2005', lose_date: '2026-10-30T13:00:00Z',
  ai_verdict: 'неправомерен', ai_reason_class: 'manager_dropped',
  ai_facts_json: { facts: [{ fact_id: 'f1', source: 'call_event', actor: 'system', ts: timestamp, direction: 'outgoing', content: 'Звонок, записи нет' }] },
  ai_judge_json: { verdict_reason_short: 'Запись звонка 30 октября отсутствует', exact_reason: secret,
    manager_mistakes: [{ proof_fact_ids: ['f1'] }], key_signals: [], risk_factors: [] },
};

function fakeCommand({ ids, readBaselines, makeRunner }) {
  return (async () => {
    const data = await readBaselines({}, { dealIds: ids.map(Number) });
    const reader = { request: async () => { throw new Error('Нет реальной сети'); } };
    const runner = makeRunner({ bitrix: reader, llm: {}, transcribe() {}, downloadFile() {}, judgeSystemPrompt: 'Судья', writerSystemPrompt: 'Писатель' });
    const outcome = await runner.run({ dealId: Number(ids[0]), baseline: { ...data.baselines[0], audio_wait_enabled_at: data.audio_wait_enabled_at }, screenshots: true });
    return { statuses: { [outcome.status]: 1 }, selected: 1, attempted: 1, service_closed: true };
  })();
}

const reader = async () => ({ audio_wait_enabled_at: '2026-11-01T00:00:00Z', baselines: [baseline] });
const current = { status: 'processed', calls: { communications: [{ type: 'call', activity_id: 123, date: timestamp, direction: 'outgoing' }] },
  analysis: { multi_agent_analysis: { verdict: 'правомерен', closure_reason_class: 'competitor',
    verdict_reason_short: 'Клиент выбрал конкурента', exact_reason: secret,
    manager_mistakes: [], key_signals: [{ proof_fact_ids: ['f2'] }], risk_factors: [],
    facts_packet: { facts: [{ fact_id: 'f2', source: 'call_transcript', actor: 'client', ts: timestamp, direction: 'outgoing', content: secret }] } } } };

test('явная пара и безопасное сопоставление без текстов и ID после закрытия сервиса', async () => {
  let options;
  const result = await runInvestigation({ dealId: '126198', analysisId: '2005', runCommand: fakeCommand, readBaselines: reader,
    processFn: async value => { options = value; return current; } });
  assert.equal(options.silent, true);
  assert.equal(options.expectedLoseDate, baseline.lose_date);
  assert.equal(result.service_closed, true);
  assert.equal(result.detail.calls.transitions.event_to_stereo, 1);
  assert.equal(result.detail.calls.old_event_to_transcript_reasons.no_recording, 1);
  assert.equal(result.detail.previous_reasons.mentions_missing_recording, true);
  assert.equal(result.detail.current_reasons.mentions_competitor, true);
  assert.equal(result.detail.current_evidence.sections.key_signals.by_source.call_transcript, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes('126198'), false);
  assert.equal(JSON.stringify(result).includes('123'), false);
  assert.equal('pool' in options, false);
  assert.equal('queue' in options, false);
  assert.equal('delivery' in options, false);
  assert.throws(() => options.bitrix.request('crm.deal.update', { id: 126198 }), /запрещён/);
});

test('неподтверждённый ID и изменившийся старый анализ не запускают обработку', async () => {
  let processed = false;
  const process = async () => { processed = true; return current; };
  await assert.rejects(runInvestigation({ dealId: '126198', analysisId: '2021', runCommand: fakeCommand, readBaselines: reader, processFn: process }));
  await assert.rejects(runInvestigation({ dealId: '126198', analysisId: '2005', runCommand: fakeCommand,
    readBaselines: async () => ({ baselines: [{ ...baseline, analysis_id: '2006' }] }), processFn: process }));
  assert.equal(processed, false);
});

test('неподтверждённая уборка или историческое ожидание без ID не дают доказанного результата', async () => {
  await assert.rejects(runInvestigation({ dealId: '126198', analysisId: '2005', runCommand: async () => ({ service_closed: false }) }));
  let processed = false;
  const result = await runInvestigation({ dealId: '126198', analysisId: '2005', runCommand: fakeCommand,
    readBaselines: async () => ({ audio_wait_enabled_at: '2026-11-01T00:00:00Z',
      baselines: [{ ...baseline, saved_audio_wait: { state: 'waiting', lose_date: baseline.lose_date } }] }),
    processFn: async () => { processed = true; return current; } });
  assert.equal(processed, false);
  assert.equal(result.status, 'unverified');
  assert.equal(result.detail, null);
});
