import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { persistResult } from '../../app/src/persistence/index.mjs';

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const operation = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lease = operation(99);
const date = '2026-11-02T00:00:00Z';
const deal = { deal_id: 42, title: 'Тест', lose_date: date, stage_id: 'C23:LOSE' };
const base = {
  deal_id: 42, deal_data: deal, lease_token: lease, _status: 'processed', prompt_version: 'v2.8-sol',
  classification: { summary: 'Итог' },
  multi_agent_analysis: { verdict: 'правомерен', final_comment: 'Тест', facts_packet: { facts: [] } },
  comm_stats: { total_events: 2, calls: 1, calls_with_audio: 1 },
  journal_text: 'Старый журнал', full_prompt_text: 'Старый промпт', comm_analytics: { calls_total: 1 },
};
const oldCall = {
  type: 'call', activity_id: 12, date: date, _needs_transcription: true,
  transcript: 'Менеджер: Привет\nКлиент: Здравствуйте', transcript_manager_text: 'Привет',
  transcript_client_text: 'Здравствуйте', transcript_replicas: 2, transcript_engine: 'reserve:gigaam',
};
const emptyCall = { ...oldCall, _needs_transcription: false, transcript: '', transcript_manager_text: '',
  transcript_client_text: '', transcript_replicas: 0, transcript_engine: null };
const audioWait = { origin_stage_history_id: '101', lose_date: date, first_seen_at: '2026-11-02T00:01:00Z', deadline_at: '2026-11-03T00:01:00Z',
  next_check_at: '2026-11-03T00:01:00Z', pending_calls: ['12'], observations: { 12: { activity_id: '12' } } };

test('архив, новая карточка и результат сохраняются атомарно в PGlite', { skip: !existsSync(pglitePath) }, async (t) => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8'));
    await db.exec(readFileSync('supabase/migrations/20261105052525_lost_processing_jobs.sql', 'utf8'));
    await db.exec(readFileSync('supabase/migrations/20261106031734_lost_audio_wait_origins.sql', 'utf8'));
    await db.exec(readFileSync('supabase/migrations/20261105065551_lost_overwrite_history.sql', 'utf8'));
    const query = q => typeof q === 'string' ? db.query(q) : db.query(q.text, q.values);
    const pool = { async connect() { return { query, release() {} }; } };
    async function job(n, silent = true) {
      await db.query(`INSERT INTO lost_processing_jobs
        (id,request_key,deal_id,lose_date,trigger_type,status,lease_token,lease_until,silent,screenshots)
        VALUES ($1,$2,42,$3,'batch','processing',$4,now()+interval '1 hour',$5,false)`,
      [operation(n), `history-${n}`, date, lease, silent]);
    }

    await t.test('пустой новый транскрипт архивирует прежний, но не выдаёт его за текущий', async () => {
      await job(1);
      await persistResult(pool, { ...base, operation_id: operation(1), communications_with_transcripts: [oldCall] });
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_overwrite_history')).rows[0].n, 0);
      await job(2, false);
      await persistResult(pool, { ...base, operation_id: operation(2), communications_with_transcripts: [emptyCall] });
      const saved = (await db.query('SELECT record_type,event_type,event_id,previous_values FROM lost_overwrite_history WHERE operation_id=$1', [operation(2)])).rows;
      assert.equal(saved.length, 1);
      assert.equal(saved[0].record_type, 'communication');
      assert.equal(saved[0].event_type, 'call');
      assert.equal(saved[0].event_id, '12');
      assert.equal(saved[0].previous_values.transcript_formatted, oldCall.transcript);
      assert.equal(saved[0].previous_values.transcript_engine, 'reserve:gigaam');
      assert.equal(Object.hasOwn(saved[0].previous_values, 'call_audio_url'), false);
      const current = (await db.query('SELECT transcript_formatted,transcript_status,transcript_engine FROM lost_deal_communications WHERE deal_id=42')).rows[0];
      assert.deepStrictEqual(current, { transcript_formatted: '', transcript_status: 'skipped', transcript_engine: null });
      const again = await persistResult(pool, { ...base, operation_id: operation(2), communications_with_transcripts: [emptyCall] });
      assert.equal(again.status, 'already_committed');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_overwrite_history WHERE operation_id=$1', [operation(2)])).rows[0].n, 1);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_deal_analyses WHERE pipeline_operation_id=$1', [operation(2)])).rows[0].n, 1);
      await db.query("UPDATE lost_processing_jobs SET status='done',lease_token=NULL,lease_until=NULL WHERE id=$1", [operation(2)]);
    });

    await t.test('одинаковый транскрипт не дублирует архив, изменённый сохраняет прежнюю версию', async () => {
      await job(5);
      await persistResult(pool, { ...base, operation_id: operation(5), communications_with_transcripts: [oldCall] });
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_overwrite_history WHERE operation_id=$1', [operation(5)])).rows[0].n, 0);
      await job(6);
      await persistResult(pool, { ...base, operation_id: operation(6), communications_with_transcripts: [oldCall] });
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_overwrite_history WHERE operation_id=$1', [operation(6)])).rows[0].n, 0);
      await job(7);
      const changed = { ...oldCall, transcript: 'Клиент: Другой текст', transcript_client_text: 'Другой текст', transcript_engine: 'reserve:aiesa' };
      await persistResult(pool, { ...base, operation_id: operation(7), communications_with_transcripts: [changed] });
      const snapshot = (await db.query('SELECT previous_values FROM lost_overwrite_history WHERE operation_id=$1', [operation(7)])).rows;
      assert.equal(snapshot.length, 1);
      assert.equal(snapshot[0].previous_values.transcript_formatted, oldCall.transcript);
      const current = (await db.query('SELECT transcript_formatted,transcript_engine FROM lost_deal_communications WHERE deal_id=42')).rows[0];
      assert.deepStrictEqual(current, { transcript_formatted: changed.transcript, transcript_engine: 'reserve:aiesa' });
    });

    await t.test('истечение аудио архивирует старую карточку и явно оставляет несобранные поля NULL', async () => {
      await db.query(`INSERT INTO lost_audio_wait (deal_id,lose_date,state,first_seen_at,deadline_at,next_check_at,pending_calls,observations,origin_stage_history_id)
        VALUES (42,$1,'waiting',$2,$3,$4,$5::jsonb,$6::jsonb,'101')`,
      [date, audioWait.first_seen_at, audioWait.deadline_at, audioWait.next_check_at, JSON.stringify(audioWait.pending_calls), JSON.stringify(audioWait.observations)]);
      await db.query("UPDATE lost_deals SET last_ai_probability=75,last_ai_misplaced=true,last_ai_recovery_probability=50,last_ai_reason_class='price',last_ai_maturity='warm',last_ai_route='call',last_ai_closure_correctness='premature',last_ai_closure_reason_class='price',last_ai_recoverable_now='yes_medium',last_ai_recovery_route='contact' WHERE deal_id=42");
      await job(3);
      await persistResult(pool, { ...base, operation_id: operation(3), audio_wait: audioWait, audio_wait_expired: true,
        communications_with_transcripts: [], multi_agent_analysis: { verdict: 'недостаточно_данных', final_comment: 'Аудио не получено' } });
      const history = (await db.query("SELECT previous_values FROM lost_overwrite_history WHERE operation_id=$1 AND record_type='card'", [operation(3)])).rows;
      assert.equal(history.length, 1);
      assert.equal(history[0].previous_values.journal_text, 'Старый журнал');
      assert.equal(history[0].previous_values.comm_total_events, 2);
      assert.deepStrictEqual(history[0].previous_values.comm_analytics, { calls_total: 1 });
      assert.equal(history[0].previous_values.last_ai_probability, 75);
      assert.equal(history[0].previous_values.last_ai_misplaced, true);
      assert.equal(history[0].previous_values.last_ai_recovery_probability, 50);
      assert.equal(history[0].previous_values.last_ai_reason_class, 'price');
      assert.equal(history[0].previous_values.last_ai_maturity, 'warm');
      assert.equal(history[0].previous_values.last_ai_route, 'call');
      assert.equal(history[0].previous_values.last_ai_closure_correctness, 'premature');
      assert.equal(history[0].previous_values.last_ai_closure_reason_class, 'price');
      assert.equal(history[0].previous_values.last_ai_recoverable_now, 'yes_medium');
      assert.equal(history[0].previous_values.last_ai_recovery_route, 'contact');
      const card = (await db.query('SELECT comm_total_events,comm_calls,trans_calls_transcribed,journal_text,full_prompt_text,comm_analytics,last_ai_misplaced,last_ai_probability,last_ai_recovery_probability FROM lost_deals WHERE deal_id=42')).rows[0];
      assert.deepStrictEqual(card, { comm_total_events: null, comm_calls: null, trans_calls_transcribed: null, journal_text: null, full_prompt_text: null, comm_analytics: null, last_ai_misplaced: null, last_ai_probability: null, last_ai_recovery_probability: null });
      const analysis = (await db.query('SELECT ai_verdict,ai_judge_json,ai_facts_json,ai_facts_count,comm_total_at_run,calls_transcribed_at_run,journal_text,screenshots_total,ai_misplaced,ai_probability,ai_recovery_probability,ai_key_signals,ai_risk_factors,ai_manager_mistakes,ai_manager_script FROM lost_deal_analyses WHERE pipeline_operation_id=$1', [operation(3)])).rows[0];
      assert.equal(analysis.ai_verdict, 'недостаточно_данных');
      assert.equal(analysis.ai_judge_json.data_scope, 'not_collected');
      assert.equal(analysis.ai_judge_json.data_scope_reason, 'audio_wait_expired');
      for (const field of ['ai_facts_json', 'ai_facts_count', 'comm_total_at_run', 'calls_transcribed_at_run', 'journal_text', 'screenshots_total', 'ai_misplaced', 'ai_probability', 'ai_recovery_probability', 'ai_key_signals', 'ai_risk_factors', 'ai_manager_mistakes', 'ai_manager_script']) assert.equal(analysis[field], null);
      assert.equal((await db.query('SELECT state FROM lost_audio_wait WHERE deal_id=42')).rows[0].state, 'expired');
    });

    await t.test('ошибка после создания архива откатывает архив, данные и задачу', async () => {
      await db.query("UPDATE lost_deal_communications SET transcript_formatted='Сохранённый старый текст',full_content='Сохранённый старый текст',transcript_status='transcribed',transcript_engine='reserve:gigaam' WHERE deal_id=42");
      await job(4);
      const failingPool = { async connect() { return { async query(q) {
        const text = typeof q === 'string' ? q : q.text;
        if (text.includes('INSERT INTO public.lost_deal_communications')) throw new Error('Тестовая ошибка');
        return query(q);
      }, release() {} }; } };
      await assert.rejects(persistResult(failingPool, { ...base, operation_id: operation(4), communications_with_transcripts: [emptyCall] }));
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_overwrite_history WHERE operation_id=$1', [operation(4)])).rows[0].n, 0);
      assert.equal((await db.query('SELECT transcript_formatted FROM lost_deal_communications WHERE deal_id=42')).rows[0].transcript_formatted, 'Сохранённый старый текст');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_deal_analyses WHERE pipeline_operation_id=$1', [operation(4)])).rows[0].n, 0);
      assert.equal((await db.query('SELECT status FROM lost_processing_jobs WHERE id=$1', [operation(4)])).rows[0].status, 'processing');
      await db.query("UPDATE lost_processing_jobs SET status='done',lease_token=NULL,lease_until=NULL WHERE id=$1", [operation(4)]);
    });

    await t.test('потерянный ответ COMMIT не создаёт дубликаты архива при повторном чтении операции', async () => {
      await job(8, false);
      const lostReplyPool = { async connect() { return { async query(q) {
        const result = await query(q);
        if (q === 'COMMIT') throw new Error('Ответ потерян');
        return result;
      }, release() {} }; } };
      const input = { ...base, operation_id: operation(8), communications_with_transcripts: [emptyCall] };
      await assert.rejects(persistResult(lostReplyPool, input), error => error.code === 'COMMIT_OUTCOME_UNKNOWN');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_overwrite_history WHERE operation_id=$1', [operation(8)])).rows[0].n, 1);
      assert.equal((await persistResult(pool, input)).status, 'already_committed');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_overwrite_history WHERE operation_id=$1', [operation(8)])).rows[0].n, 1);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_deal_analyses WHERE pipeline_operation_id=$1', [operation(8)])).rows[0].n, 1);
    });

    await t.test('архив закрыт от анонимной и пользовательской роли', async () => {
      const row = (await db.query(`SELECT relrowsecurity AS rls,
        has_table_privilege('anon','public.lost_overwrite_history','SELECT') AS anon_select,
        has_table_privilege('authenticated','public.lost_overwrite_history','SELECT') AS authenticated_select
        FROM pg_class WHERE oid='public.lost_overwrite_history'::regclass`)).rows[0];
      assert.deepStrictEqual(row, { rls: true, anon_select: false, authenticated_select: false });
    });
  } finally { await db.close(); }
});
