import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { reviewOne, runEvidenceReview, extractRedactedProofExcerpts, sealEvidenceReport } from '../../app/src/pilot/evidence-review.mjs';

const fixture = () => ({
  facts: [
    { fact_id: 'f1', source: 'call_transcript', actor: 'unknown', transcript_mode: 'mono', content: 'синтетическая моно речь' },
    { fact_id: 'f2', source: 'call_event', actor: 'system', content: 'Звонок 10 сек, записи нет' },
    { fact_id: 'f3', source: 'call_event', actor: 'system', content: 'Звонок: запись есть, но не распознана — содержание неизвестно' },
    { fact_id: 'f4', source: 'call_event', actor: 'system', content: 'Звонок: разговор не состоялся — ответил автоответчик или голосовой помощник' },
    { fact_id: 'f5', source: 'call_event', actor: 'system', content: 'Звонок: разговор не состоялся — связь не установилась' },
    { fact_id: 'f6', source: 'call_transcript', actor: 'client', content: 'достаточно длинная синтетическая реплика' },
    { fact_id: 'f7', source: 'chat', actor: 'client', content: 'да' },
    { fact_id: 'f8', source: 'crm_comment', actor: 'manager', content: 'PRIVATE-CONTENT' },
  ], metrics: { known: 0, empty: null } });
const judge = () => ({ manager_mistakes: [
  { proof_type: 'client_statement', proof_fact_ids: ['f1', 'f6', 'f8', 'missing', 'metric:known'] },
  { proof_type: 'crm_comment', proof_fact_ids: ['f6'] },
  { proof_type: 'absence', proof_fact_ids: ['metric:absent', 'metric:empty'] },
  { proof_type: 'metric', proof_fact_ids: [] },
], key_signals: [], risk_factors: [] });

test('структурная проверка различает звонки, роли, отсутствующие доказательства и неподтверждённую семантику', () => {
  const output = reviewOne({ packet: fixture(), judge: judge(), verdict: 'неправомерен', reasonClass: 'price' });
  assert.equal(output.available, true);
  assert.deepEqual(output.facts.calls, { no_recording: 1, recording_unrecognized: 1, machine_or_voicemail: 1,
    greeting_only: 0, not_client: 0, bad_line: 1, no_conversation: 0, other_event: 0, mono_unknown: 1,
    unassigned_transcript: 0, client_transcript: 1, manager_transcript: 0 });
  assert.equal(output.facts.client_text_at_least_20, 1);
  assert.equal(output.facts.client_text_under_20, 1);
  assert.equal(output.facts.unknown_text, 1);
  assert.equal(output.proof.claims, 4);
  assert.equal(output.proof.claims_without_refs, 1);
  assert.equal(output.proof.unknown_speaker, 1);
  assert.equal(output.proof.wrong_actor_or_source, 2);
  assert.equal(output.proof.missing_fact, 1);
  assert.equal(output.proof.incompatible_reference, 1);
  assert.equal(output.proof.missing_metric, 1);
  assert.equal(output.proof.metric_null, 1);
  assert.equal(output.proof.absence_requires_review, 1);
  assert.ok(output.limitations.includes('correctness_requires_semantic_review'));
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE-CONTENT|синтетическ|f[1-8]/);
});

test('отсутствие данных, метрик, неверные ссылки и некорректные enum не становятся подтверждённой корректностью', () => {
  assert.equal(reviewOne({ packet: null, verdict: 'подмена', reasonClass: 'текст' }).available, false);
  const packet = fixture(); delete packet.metrics;
  const audit = reviewOne({ packet, judge: judge(), verdict: 'правомерен', reasonClass: 'other' });
  assert.equal(audit.proof.metric_unverified, 3);
  assert.equal(audit.proof.missing_metric, 0);
  const duplicate = fixture(); duplicate.facts[1].fact_id = 'f1';
  assert.equal(reviewOne({ packet: duplicate, judge: judge() }).proof.available, false);
  const invalid = judge(); invalid.key_signals = [{ proof_type: 'client_statement', proof_fact_ids: [123] }];
  assert.equal(reviewOne({ packet: fixture(), judge: invalid }).proof.available, false);
});

test('автоответчик, приветствие, чужой человек и плохая связь считаются раздельно', () => {
  const packet = { facts: ['Сработал автоответчик оператора или ИИ-секретарь',
    'разговор не состоялся — прозвучало только приветствие, цель звонка не названа',
    'разговор не состоялся — трубку снял не клиент',
    'разговор не состоялся — связь не установилась',
    'разговор не состоялся — причина не уточнена'].map((content, i) => ({ fact_id: 'f' + i, source: 'call_event', actor: 'system', content })) };
  const calls = reviewOne({ packet, judge: judge() }).facts.calls;
  for (const type of ['machine_or_voicemail', 'greeting_only', 'not_client', 'bad_line', 'no_conversation']) assert.equal(calls[type], 1);
});

test('проверка cutoff отдельно отмечает поздние и недатированные факты и ссылки', () => {
  const packet = fixture();
  packet.metrics.cutoff_at = '2026-11-01T08:00:00Z';
  packet.facts[0].ts = '2026-11-01T15:00:00+07:00';
  packet.facts[5].ts = '2026-11-01T08:01:00Z';
  const audit = reviewOne({ packet, judge: judge(), transitionLoseDate: '2026-11-01T07:30:00Z' });
  assert.equal(audit.temporal.cutoff_available, true);
  assert.equal(audit.temporal.after_cutoff, 1);
  assert.equal(audit.temporal.time_unverified, 6);
  assert.equal(audit.proof.referenced_facts_after_cutoff, 2);
  assert.equal(audit.proof.referenced_fact_time_unverified, 1);
  assert.equal(audit.temporal.lose_date_available, true);
  assert.equal(audit.temporal.cutoff_after_lose, true);
  assert.equal(audit.temporal.after_lose, 2);
  assert.equal(audit.temporal.lose_time_unverified, 6);
  assert.equal(audit.proof.referenced_facts_after_lose, 3);
  assert.equal(audit.proof.referenced_fact_lose_time_unverified, 1);
  const earlier = reviewOne({ packet, judge: judge(), transitionLoseDate: '2026-11-01T09:00:00Z' });
  assert.equal(earlier.temporal.cutoff_after_lose, false);
  assert.equal(earlier.temporal.after_lose, 0);
  packet.metrics.cutoff_at = '2026-02-30T08:00:00Z';
  assert.equal(reviewOne({ packet, judge: judge() }).temporal.cutoff_available, false);
  assert.equal(reviewOne({ packet, judge: judge() }).temporal.cutoff_after_lose, null);
});

test('неявный экспорт запрещён; явные выдержки только по ссылкам судьи с предупреждением и маскированием', () => {
  assert.deepEqual(extractRedactedProofExcerpts(), { enabled: false, excerpts: [] });
  const packet = fixture(), proof = judge();
  packet.facts[5].content = 'Позвоните +7 (999) 123-45-67, почта x@example.com, https://example.test/path ' +
    'token=SHORT_SECRET пароль:othersecret Bearer abc123 rest/123/freshkey';
  const output = extractRedactedProofExcerpts({ enabled: true, selectedFactIds: ['f6'], judge: proof, facts: packet.facts });
  assert.equal(output.excerpts.length, 1);
  assert.ok(output.limitations.includes('redaction_may_leave_names_addresses_or_unknown_secrets'));
  assert.doesNotMatch(JSON.stringify(output), /999|123-45|x@example|https:|SHORT_SECRET|othersecret|abc123|freshkey/);
  assert.throws(() => extractRedactedProofExcerpts({ enabled: true, selectedFactIds: ['f7'], judge: proof, facts: packet.facts }), /не подтверждено/);
  assert.throws(() => extractRedactedProofExcerpts({ enabled: true, selectedFactIds: ['f6', 'f6'], judge: proof, facts: packet.facts }), /Некорректный/);
});

const baseline = () => ({ deal_id: 126402, analysis_id: '1981', lose_date: '2026-01-01T00:00:00Z',
  audio_wait_enabled_at: '2025-01-01T00:00:00Z', ai_verdict: 'правомерен', ai_reason_class: 'price',
  ai_facts_json: fixture(), ai_judge_json: judge(), saved_audio_wait: null });

function fakeCommand({ baselineValue = baseline(), close = true, processResult, calls }) {
  return async ({ ids, readBaselines, makeRunner }) => {
    assert.deepEqual(ids, ['126402']);
    const originals = await readBaselines({}, { dealIds: [126402] });
    const runner = makeRunner({ bitrix: { async request(method) { calls.push(method); return { result: [] }; } },
      llm: {}, transcribe() {}, downloadFile() {}, judgeSystemPrompt: 'x', writerSystemPrompt: 'y' });
    const value = await runner.run({ dealId: 126402, baseline: originals.baselines[0], screenshots: true });
    if (processResult) processResult(value);
    return { selected: 1, attempted: 1, statuses: { [value.status]: 1 }, service_closed: close };
  };
}

test('явная пара вызывает только изолированный silent processDeal, а результат не содержит текста, ID и секретов', async () => {
  const calls = [];
  const output = await runEvidenceReview({ dealId: '126402', analysisId: '1981',
    readBaselines: async () => ({ baselines: [baseline()] }), runCommand: fakeCommand({ calls }),
    async processFn(options) {
      assert.equal(options.silent, true);
      assert.throws(() => options.bitrix.request('crm.timeline.comment.add', {}), /запрещён/);
      await options.bitrix.request('crm.deal.get', {});
      return { status: 'processed', analysis: { multi_agent_analysis: { ...judge(), verdict: 'правомерен',
        closure_reason_class: 'price', facts_packet: fixture(), exact_reason: 'SECRET-REASON' } } };
    },
  });
  assert.deepEqual(calls, ['crm.deal.get']);
  assert.equal(output.status, 'processed');
  assert.equal(output.detail.correctness, 'requires_manual_review');
  assert.equal(output.service_closed, true);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE-CONTENT|SECRET-REASON|1981|126402/);
});

test('сменившийся analysis ID, неподтверждённое ожидание аудио и отсутствие маркера безопасно останавливаются', async () => {
  let called = false;
  const changed = baseline(); changed.analysis_id = '2022';
  await assert.rejects(runEvidenceReview({ dealId: '126402', analysisId: '1981',
    readBaselines: async () => ({ baselines: [changed] }), runCommand: fakeCommand({ calls: [] }),
    async processFn() { called = true; } }), /Эталон изменился/);
  assert.equal(called, false);
  const old = baseline(); old.saved_audio_wait = { state: 'waiting', lose_date: '2025-01-01T00:00:00Z', origin_stage_history_id: null };
  const result = await runEvidenceReview({ dealId: '126402', analysisId: '1981', readBaselines: async () => ({ baselines: [old] }),
    runCommand: fakeCommand({ calls: [] }), async processFn() { called = true; } });
  assert.equal(result.status, 'unverified');
  assert.equal(called, false);
  await assert.rejects(runEvidenceReview({ dealId: '126402', analysisId: '1981', readBaselines: async () => ({ baselines: [baseline()] }),
    runCommand: fakeCommand({ calls: [], close: false }), async processFn() { return { status: 'blocked' }; } }), /не подтверждено/);
});

test('неявный, повторный или недопустимый выбор ID отвергается до любых сетевых действий', async () => {
  let called = false;
  for (const [dealId, analysisId] of [[null, '1'], ['0', '1'], ['42', ''], ['-1', '1'], ['42', '1;drop'], ['2147483648', '1'], ['126402', '1978'], ['42', '2021']]) {
    await assert.rejects(runEvidenceReview({ dealId, analysisId, runCommand: async () => { called = true; } }));
  }
  assert.equal(called, false);
});

test('opt-in показывает лишь ограниченные выдержки с маскировкой и предупреждением', async () => {
  const result = await runEvidenceReview({ dealId: '126402', analysisId: '1981', includeExcerpts: true,
    readBaselines: async () => ({ baselines: [baseline()] }), runCommand: fakeCommand({ calls: [] }),
    async processFn() { const j = judge(); j.exact_reason = 'Клиент написал на x@example.com';
      return { status: 'processed', analysis: { multi_agent_analysis: { ...j, verdict: 'правомерен', closure_reason_class: 'price', facts_packet: fixture() } } }; },
  });
  const selected = result.detail.selected_excerpts.current;
  assert.equal(selected.available, true);
  assert.ok(selected.excerpts.length > 0 && selected.excerpts.length <= 3);
  assert.match(selected.reason, /\[почта\]/);
  assert.ok(selected.limitations.includes('redaction_may_leave_names_addresses_or_unknown_secrets'));
  assert.ok(selected.limitations.includes('verdict_proof_not_guaranteed'));
  assert.equal(selected.shown_facts_count, selected.excerpts.length);
  assert.ok(selected.referenced_facts_count >= selected.shown_facts_count);
  assert.doesNotMatch(JSON.stringify(result), /x@example.com/);
});

test('sealed: RSA-OAEP-SHA256 и AES-256-GCM восстанавливают данные, без plaintext и без marker при ошибке', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const encoded = Buffer.from(pem).toString('base64');
  const report = { service_closed: true, detail: { excerpt: 'синтетический приватный текст 123456789' } };
  const envelope = sealEvidenceReport(report, encoded);
  assert.equal(envelope.service_closed, true);
  assert.equal(envelope.sealed_version, 1);
  assert.equal(envelope.algorithm, 'RSA-OAEP-SHA256+A256GCM');
  assert.doesNotMatch(JSON.stringify(envelope), /синтетический|123456789/);
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.encrypted_key, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString()), report);
  const bad = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  bad.setAuthTag(Buffer.alloc(16));
  assert.throws(() => { bad.update(Buffer.from(envelope.ciphertext, 'base64')); bad.final(); });
  assert.throws(() => sealEvidenceReport({ service_closed: false }, encoded));
  assert.throws(() => sealEvidenceReport({ service_closed: true, data: 'x'.repeat(100001) }, encoded));
  assert.throws(() => sealEvidenceReport(report, Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64')));
  assert.throws(() => sealEvidenceReport(report, 'abc'));
  const cli = spawnSync(process.execPath, ['app/src/pilot/evidence-review.mjs', '126402', '1981', '--sealed', 'abc'], { encoding: 'utf8' });
  assert.notEqual(cli.status, 0);
  assert.equal(cli.stdout, '');
  assert.doesNotMatch(cli.stderr, /service_closed|синтетический/);
  const openCli = spawnSync(process.execPath, ['app/src/pilot/evidence-review.mjs', '126402', '1981', '--excerpts'], { encoding: 'utf8' });
  assert.notEqual(openCli.status, 0);
  assert.equal(openCli.stdout, '');
});
