import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listPilotCandidates, loadPilotBaselines } from '../../app/src/pilot/candidates.mjs';

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const schema = readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8');
const migration = readFileSync('supabase/migrations/20261105052525_lost_processing_jobs.sql', 'utf8');
const date = '2026-11-01T01:00:00Z';
const facts = sources => JSON.stringify({ facts: sources.map(source => ({ source, content: 'синтетический факт' })) });

function poolFor(db, statements = []) {
  return { async connect() { return {
    async query(sql, params) { statements.push({ sql, params }); return db.query(sql, params); },
    release() {},
  }; } };
}

test('неверный выбор не открывает соединение', async () => {
  const pool = { async connect() { assert.fail('соединение запрещено'); } };
  for (const dealIds of [[], [0], ['1;DELETE'], [1, '1'], [2147483648], [1, 2, 3, 4, 5, 6]]) {
    await assert.rejects(loadPilotBaselines(pool, { dealIds }), /выбрать|Некорректный/);
  }
  for (const limit of [0, 2, 6, '3']) await assert.rejects(listPilotCandidates(pool, { limit }), /Лимит/);
});

test('эталоны и метаданные читаются в одной защищённой транзакции без SQL-записи', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.query('INSERT INTO lost_audio_wait_config (id,enabled_at) VALUES (true,$1)', [date]);
    const rows = [
      [41, 'неправомерен', 'no_need', ['call_transcript', 'chat']],
      [42, 'правомерен', 'price', ['chat_voice_transcript']],
      [43, 'недостаточно_данных', null, []],
      [44, 'правомерен', 'own_decision', ['screenshot_chat']],
    ];
    for (const [id, verdict, reason, sources] of rows) {
      await db.query("INSERT INTO lost_deals (deal_id, stage_id, lose_date, title) VALUES ($1,'C23:LOSE',$2,'НЕ ВЫВОДИТЬ')", [id, date]);
      await db.query(`INSERT INTO lost_deal_analyses (deal_id,ai_verdict,ai_closure_reason_class,ai_facts_json,
        ai_judge_json,processed_at,prompt_version,judge_model) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,'v2.8-sol','test-model')`,
      [id, verdict, reason, facts(sources), JSON.stringify({ verdict }), date]);
    }
    await db.query(`INSERT INTO lost_audio_wait (deal_id,lose_date,state,first_seen_at,deadline_at,next_check_at,pending_calls,observations)
      VALUES (42,$1,'waiting',$1,$1,$1,'[]'::jsonb,'{}'::jsonb)`, [date]);
    const statements = [];
    const pool = poolFor(db, statements);
    const candidates = await listPilotCandidates(pool, { limit: 3 });
    assert.deepEqual(candidates.map(item => item.deal_id), [41, 42, 43]);
    assert.equal(candidates[0].has_call_facts, true);
    assert.equal(candidates[0].has_chat_facts, true);
    assert.equal(candidates[1].has_voice_facts, true);
    assert.equal(candidates[1].ai_reason_class, 'price');
    assert.equal(candidates[0].legacy_origin_verified, false);
    assert.equal(candidates[0].historical_transition_unverified, true);
    assert.equal(JSON.stringify(candidates).includes('синтетический факт'), false);
    assert.equal(JSON.stringify(candidates).includes('НЕ ВЫВОДИТЬ'), false);

    const baseline = await loadPilotBaselines(pool, { dealIds: [42, '41'] });
    assert.equal(baseline.audio_wait_enabled_at, '2026-11-01T01:00:00.000Z');
    assert.deepEqual(baseline.baselines.map(item => item.deal_id), [42, 41]);
    assert.equal(baseline.baselines[0].saved_audio_wait.state, 'waiting');
    assert.equal(baseline.baselines[1].saved_audio_wait, null);
    assert.equal(baseline.baselines[0].ai_facts_json.facts[0].source, 'chat_voice_transcript');
    assert.equal(baseline.baselines[1].ai_judge_json.verdict, 'неправомерен');
    const sql = statements.map(s => s.sql.trim());
    assert.equal(sql.filter(s => s === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY').length, 2);
    assert.equal(sql.filter(s => s === 'COMMIT').length, 2);
    assert.ok(sql.every(s => /^(BEGIN|SELECT|WITH|COMMIT)\b/i.test(s)));
    assert.ok(sql.every(s => !/\b(?:INSERT|UPDATE|DELETE|ALTER|TRUNCATE)\b/i.test(s)));
    assert.ok(statements.some(s => Array.isArray(s.params?.[0]) && s.params[0].join(',') === '42,41'));
    await assert.rejects(loadPilotBaselines(pool, { dealIds: [41, 99] }), /Не удалось безопасно/);
    assert.equal(statements.at(-1).sql, 'ROLLBACK');
  } finally { await db.close(); }
});

test('современный анализ не подменяет исторический эталон', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(migration);
    await db.query('INSERT INTO lost_audio_wait_config (id,enabled_at) VALUES (true,$1)', [date]);
    await db.query("INSERT INTO lost_deals (deal_id,stage_id,lose_date) VALUES (41,'C23:LOSE',$1)", [date]);
    await db.query("INSERT INTO lost_deal_analyses (deal_id,ai_verdict,ai_facts_json,processed_at) VALUES (41,'правомерен',$1::jsonb,$2)", [facts(['chat']), date]);
    await db.query(`INSERT INTO lost_deal_analyses (deal_id,ai_verdict,ai_facts_json,processed_at,pipeline_operation_id)
      VALUES (41,'неправомерен',$1::jsonb,'2026-11-02','00000000-0000-4000-8000-000000000001')`, [facts(['call_transcript'])]);
    const result = await loadPilotBaselines(poolFor(db), { dealIds: [41] });
    assert.equal(result.baselines[0].ai_verdict, 'правомерен');
    assert.equal(result.baselines[0].ai_facts_json.facts[0].source, 'chat');
    assert.equal((await listPilotCandidates(poolFor(db))).at(0).ai_verdict, 'правомерен');
  } finally { await db.close(); }
});

test('действующая RLS не позволяет считать скрытые строки отсутствующими', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(`CREATE ROLE limited; GRANT USAGE ON SCHEMA public TO limited;
      GRANT SELECT ON public.lost_deals,public.lost_deal_analyses,public.lost_audio_wait,public.lost_audio_wait_config TO limited;
      ALTER TABLE public.lost_deal_analyses ENABLE ROW LEVEL SECURITY; SET ROLE limited`);
    await assert.rejects(listPilotCandidates(poolFor(db)), /Не удалось безопасно/);
    await assert.rejects(loadPilotBaselines(poolFor(db), { dealIds: [41] }), /Не удалось безопасно/);
    await db.exec('RESET ROLE');
  } finally { await db.close(); }
});

test('если сервер не подтвердил READ ONLY, запрос данных запрещён и ошибки очищаются', async () => {
  const calls = [];
  let released = false;
  const pool = { async connect() { return { async query(sql) {
    calls.push(sql);
    if (sql.startsWith('SELECT current_setting')) return { rows: [{ read_only: 'off' }] };
    if (sql === 'ROLLBACK') return { rows: [] };
    return { rows: [] };
  }, release() { released = true; } }; } };
  await assert.rejects(listPilotCandidates(pool), error => error.message === 'Не удалось безопасно прочитать эталоны');
  assert.deepEqual(calls, ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', "SELECT current_setting('transaction_read_only') AS read_only", 'ROLLBACK']);
  assert.equal(released, true);
});

test('ошибка подключения не раскрывает детали соединения', async () => {
  const pool = { async connect() { throw new Error('чувствительные данные соединения'); } };
  await assert.rejects(listPilotCandidates(pool), error => error.message === 'Не удалось безопасно прочитать эталоны');
});
