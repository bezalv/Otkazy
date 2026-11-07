import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { semanticReview, technicalReader, runCohortCase } from '../../app/src/pilot/cohort20.mjs';
import { inspectForSemanticReview, reviewOne, sealEvidenceReport } from '../../app/src/pilot/evidence-review.mjs';

const fact = (i, source = 'call_transcript', actor = 'client') => ({ fact_id: 'f' + String(i).padStart(3, '0'), source, actor,
  ts: '2026-10-01T01:00:00.000Z', content: 'пример содержания факт ' + i });
const judge = { exact_reason: 'По объективным фактам', manager_mistakes: [{ mistake: 'Ошибка', proof_type: 'manager_statement', proof_fact_ids: ['f001', 'f002', 'f999', 'f003'] }],
  key_signals: [], risk_factors: [] };
const selected = [
  ['126946','1993'], ['126964','1986'], ['126548','1992'], ['127132','1990'], ['126470','1951'], ['127068','1963'],
  ['126742','1952'], ['127188','1983'], ['126418','1985'], ['123379','2000'], ['92137','1899'], ['126520','1939'],
  ['126936','1949'], ['126952','1987'], ['126944','1996'], ['125149','1935'], ['127250','1988'], ['127114','1968'],
];

test('семантическая сверка показывает роли, тип и содержимое ссылок без объявления их истинными', () => {
  const facts = [fact(1, 'call_transcript', 'manager'), fact(2, 'crm_comment', 'manager'), fact(3, 'call_transcript', 'client')];
  const r = semanticReview({ judge, facts, transitionLoseDate: '2026-10-02T00:00:00.000Z' });
  assert.equal(r.available, true); assert.equal(r.reason, 'По объективным фактам');
  assert.equal(r.claims_total, 1); assert.equal(r.claims[0].refs_total, 4); assert.equal(r.claims[0].refs_omitted, 1);
  assert.deepEqual(r.claims[0].refs.map(x => x.status), ['found', 'found', 'missing']);
  assert.equal(r.claims[0].refs[1].source, 'crm_comment'); assert.equal(r.claims[0].refs[1].actor, 'manager');
  assert.equal(r.facts[0].actor, 'client'); assert.equal(r.facts[0].time_relation, 'before_or_at_lose');
  assert.ok(r.limitations.includes('verdict_proof_not_guaranteed'));
});

test('дубликаты fact ID, неизвестная структура и неверное время не подменяются доказанными данными', () => {
  assert.deepEqual(semanticReview({ judge, facts: [fact(1), fact(1)] }), { available: false });
  assert.deepEqual(semanticReview({ judge: {}, facts: [] }), { available: false });
  const f = { ...fact(1), ts: null, source: 'screenshot_chat', ts_precision: 'inferred' };
  assert.equal(semanticReview({ judge, facts: [f], transitionLoseDate: '2026-10-02T00:00:00Z' }).facts[0].time_relation, 'unknown');
});

test('длинный факт показывает смещение к смысловому маркеру, а группы доказательств не вытесняются', () => {
  const f = { ...fact(1), content: 'Начало разговора. '.repeat(80) + 'Клиент нашёл других и заказал там.' + ' Завершение. '.repeat(80) };
  const lengthy = { exact_reason: 'other', manager_mistakes: Array.from({ length: 9 }, () => ({ mistake: 'ошибка', proof_type: 'manager_statement', proof_fact_ids: ['f001'] })),
    key_signals: [{ signal: 'сигнал', proof_type: 'client_statement', proof_fact_ids: ['f001'] }],
    risk_factors: [{ factor: 'риск', proof_type: 'absence', proof_fact_ids: [] }] };
  const r = semanticReview({ judge: lengthy, facts: [f], transitionLoseDate: '2026-10-02T00:00:00Z' });
  assert.ok(r.facts[0].excerpt_start > 0); assert.ok(r.facts[0].excerpt.includes('нашёл других'));
  assert.ok(r.facts[0].content_length > r.facts[0].excerpt.length); assert.equal(r.facts[0].truncated, true);
  assert.ok(r.claims.some(x => x.group === 'key_signals')); assert.ok(r.claims.some(x => x.group === 'risk_factors'));
  assert.equal(r.claims_shown, 8); assert.equal(r.claims_omitted, 3);
});

test('технический путь допускает только три метода чтения и только выбранную сделку', async () => {
  const called = [];
  const reader = technicalReader({ async request(method, body) { called.push([method, body]); return { result: method === 'crm.deal.get' ? { ID: '12345' } : [] }; } }, '12345');
  await reader.request('crm.deal.userfield.list', { filter: { FIELD_NAME: 'UF_CRM_1584703948317' } });
  await reader.request('crm.deal.get', { id: 12345 });
  await reader.request('crm.stagehistory.list', { entityTypeId: 2, filter: { OWNER_ID: 12345 } });
  assert.equal(called.length, 3);
  assert.throws(() => reader.request('crm.activity.list', { filter: { OWNER_ID: 12345 } }));
  assert.throws(() => reader.request('crm.timeline.comment.add', {}));
  assert.throws(() => reader.request('crm.deal.get', { id: 12346 }));
  assert.throws(() => reader.request('crm.stagehistory.list', { entityTypeId: 2, filter: { OWNER_ID: 12346 } }));
  assert.equal(called.length, 3);
});

test('случайные ID и ключи отклоняются до любых адаптеров и до выхода в открытом виде', async () => {
  let called = false;
  await assert.rejects(() => runCohortCase({ dealId: '99999999', analysisId: '1', runCommand: () => { called = true; } }));
  await assert.rejects(() => runCohortCase({ dealId: '99999999', analysisId: 'skip', collect: () => { called = true; } }));
  assert.equal(called, false);
  const module = fileURLToPath(new URL('../../app/src/pilot/cohort20.mjs', import.meta.url));
  const cli = spawnSync(process.execPath, [module, '99999999', '1', '--sealed', 'bad'], { encoding: 'utf8' });
  assert.notEqual(cli.status, 0); assert.equal(cli.stdout, '');
});

test('18 закреплённых пар проходят только silent пилот с подтверждённым конкретным эталоном', async () => {
  let processed = 0;
  for (const [dealId, analysisId] of selected) {
    const facts = [fact(1, 'call_transcript', 'client'), fact(2, 'crm_comment', 'manager')];
    const previous = { ...judge, verdict: 'правомерен', closure_reason_class: 'other' };
    const packet = { facts, metrics: { cutoff_at: '2026-10-02T00:00:00.000Z' } };
    const baseline = { deal_id: Number(dealId), analysis_id: analysisId, pipeline_error: null, lose_date: '2026-10-02T00:00:00.000Z',
      ai_facts_json: packet, ai_judge_json: previous, ai_verdict: 'правомерен', ai_reason_class: 'other', audio_wait_enabled_at: '2020-01-01T00:00:00Z' };
    const readBaselines = async () => ({ baselines: [baseline], audio_wait_enabled_at: '2020-01-01T00:00:00Z' });
    const processFn = async options => {
      processed++; assert.equal(options.silent, true); assert.equal(options.dealId, Number(dealId));
      assert.equal(options.screenshots, true); assert.equal(options.expectedLoseDate, baseline.lose_date);
      assert.throws(() => options.bitrix.request('crm.timeline.comment.add', {}));
      return { status: 'processed', analysis: { multi_agent_analysis: { ...previous, facts_packet: packet } } };
    };
    const runCommand = async opts => {
      assert.deepEqual(opts.ids, [dealId]);
      const confirmed = await opts.readBaselines({}, { dealIds: [Number(dealId)] });
      const runner = opts.makeRunner({ bitrix: { request: async () => ({ result: [] }) }, llm: {}, transcribe: () => {},
        downloadFile: () => {}, judgeSystemPrompt: 'judge', writerSystemPrompt: 'writer' });
      const compared = await runner.run({ dealId: Number(dealId), baseline: confirmed.baselines[0], screenshots: true });
      assert.equal(compared.status, 'processed');
      return { selected: 1, attempted: 1, statuses: { processed: 1 }, service_closed: true };
    };
    const out = await runCohortCase({ dealId, analysisId, env: {}, readBaselines, processFn, runCommand });
    assert.equal(out.status, 'processed'); assert.equal(out.analysis_id, analysisId); assert.equal(out.service_closed, true);
    assert.equal(out.detail.semantic.current.available, true); assert.equal(out.detail.semantic.current.facts_total, 2);
    await assert.rejects(() => runCohortCase({ dealId, analysisId: String(Number(analysisId) + 100000), env: {}, runCommand }));
  }
  assert.equal(processed, 18);
});

test('неверный номер эталона и неподтверждённое закрытие не выдают защищённый успешный результат', async () => {
  const [dealId, analysisId] = selected[0];
  const wrong = async () => ({ baselines: [{ deal_id: Number(dealId), analysis_id: '9999999' }] });
  const runCommand = async opts => opts.readBaselines({}, { dealIds: [Number(dealId)] });
  await assert.rejects(() => runCohortCase({ dealId, analysisId, env: {}, readBaselines: wrong, runCommand }));
  await assert.rejects(() => runCohortCase({ dealId, analysisId, env: {}, runCommand: async () => ({ selected: 1, service_closed: false }) }));
});

test('две технические сделки проверяются только чтением справочника, карточки и истории', async () => {
  for (const [dealId, reasonId, reason] of [['126994','3297','дубль'], ['126438','3131','дополнительный контакт']]) {
    const methods = [];
    let closed = false;
    const makeLimiter = () => ({ close() { closed = true; } });
    const makeClient = () => ({ async request(method) {
      methods.push(method);
      if (method === 'crm.deal.userfield.list') return { result: [{ LIST: [{ ID: reasonId, VALUE: reason }] }] };
      if (method === 'crm.deal.get') return { result: { ID: dealId, STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: '65', UF_CRM_1584703948317: reasonId } };
      if (method === 'crm.stagehistory.list') return { result: { items: [
        { ID: '101', STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00.000Z' },
        { ID: '100', STAGE_ID: 'C23:NEW', CREATED_TIME: '2026-11-03T00:00:00.000Z' },
      ] }, total: 2 };
      throw new Error('not permitted');
    } });
    const out = await runCohortCase({ dealId, analysisId: 'skip', env: { BITRIX_REST_BASE: 'https://dinalnsk.bitrix24.ru/rest/1/test' }, makeClient, makeLimiter });
    assert.equal(out.status, 'skipped_by_reason'); assert.equal(out.analysis_id, null); assert.equal(out.detail.expected_reason, reason);
    assert.equal(out.detail.history_verified, true); assert.equal(out.service_closed, true); assert.equal(closed, true);
    assert.deepEqual(methods, ['crm.deal.userfield.list', 'crm.deal.get', 'crm.stagehistory.list']);
  }
});

test('сменившаяся техническая причина не приводит к чтению коммуникаций или вызову анализа', async () => {
  const methods = [];
  const makeClient = () => ({ async request(method) {
    methods.push(method);
    if (method === 'crm.deal.userfield.list') return { result: [{ LIST: [{ ID: '1', VALUE: 'Цена' }] }] };
    if (method === 'crm.deal.get') return { result: { ID: '126994', STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: '65', UF_CRM_1584703948317: '1' } };
    if (method === 'crm.stagehistory.list') return { result: { items: [{ ID: '101', STAGE_ID: 'C23:LOSE', CREATED_TIME: '2020-11-04T00:00:00Z' }] }, total: 1 };
    throw new Error('unexpected');
  } });
  const out = await runCohortCase({ dealId: '126994', analysisId: 'skip', env: { BITRIX_REST_BASE: 'https://dinalnsk.bitrix24.ru/rest/1/test' },
    makeClient, makeLimiter: () => ({ close() {} }) });
  assert.equal(out.status, 'unverified'); assert.equal(out.service_closed, true);
  assert.deepEqual(methods, ['crm.deal.userfield.list', 'crm.deal.get', 'crm.stagehistory.list']);
});

test('ограниченный большой отчёт помещается в sealed; тело аутентифицируется', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
  const facts = Array.from({ length: 30 }, (_, i) => ({ ...fact(i + 1), content: '满'.repeat(1000) }));
  const large = { exact_reason: '满'.repeat(3000), manager_mistakes: [], key_signals: [], risk_factors: [] };
  for (let i = 0; i < 30; i++) large.manager_mistakes.push({ mistake: '满'.repeat(500), proof_type: 'client_statement', proof_fact_ids: ['f001','f002','f003','f004'] });
  const review = semanticReview({ judge: large, facts, transitionLoseDate: '2026-10-02T00:00:00Z' });
  assert.equal(review.facts_shown, 15); assert.equal(review.claims_shown, 8);
  assert.ok(review.facts.every(x => x.truncated));
  const packet = { facts, metrics: { cutoff_at: '2026-10-02T00:00:00Z' } };
  const basic = reviewOne({ judge: large, packet, verdict: 'правомерен', reasonClass: 'other', transitionLoseDate: '2026-10-02T00:00:00Z' });
  const inspection = inspectForSemanticReview({ judge: large, facts, transitionLoseDate: '2026-10-02T00:00:00Z' });
  const envelope = sealEvidenceReport({ status: 'processed', detail: { previous: basic, current: basic,
    inspection: { previous: inspection, current: inspection }, semantic: { previous: review, current: review } }, service_closed: true }, pub);
  const key = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.encrypted_key, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const json = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString());
  assert.equal(json.service_closed, true); assert.equal(json.detail.semantic.current.claims_shown, 8);
  assert.ok(JSON.stringify(envelope).length < 1000000);
});
