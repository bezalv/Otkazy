import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { persistResult, lookupOperation, loadResumableResult } from '../../app/src/persistence/index.mjs';
import { enqueueDueAudioChecks } from '../../app/src/audio-wait/scheduler.mjs';

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const schema = readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8');
const migration = readFileSync('supabase/migrations/20261105052525_lost_processing_jobs.sql', 'utf8');
const leaseToken = '00000000-0000-4000-8000-000000000099';
const operation = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const deal = { deal_id: 42, title: "Тест'; SELECT 7; --", stage_id: 'C23:LOSE', lose_date: '2026-11-02T00:00:00Z', lose_reason: 'Цена', product_type: ['окна'] };
const comm = {
  type: 'call', activity_id: 12, date: '2026-11-01T11:00:00Z',
  duration_start: '2026-11-01T11:00:00Z', duration_end: '2026-11-01T11:02:00Z',
  _needs_transcription: true, transcript: 'Менеджер: Добрый день', transcript_engine: 'reserve:gigaam',
  screenshot_files: [{ id: 42 }], screenshot_turns: [{ speaker: 'client', text: 'Добрый день' }],
};
const result = {
  lease_token: leaseToken, deal_id: 42, deal_data: deal, _status: 'processed', prompt_version: 'v2.8-sol',
  classification: { summary: 'Итог', exact_reason: 'Причина', reason_class: 'price', reactivation_probability: 50 },
  multi_agent_analysis: { verdict: 'неправомерен', recoverable_level: 'средний', closure_reason_class: 'price', final_comment: 'Разбор', facts_packet: { facts: [] } },
  llm_meta: { model: 'openai/gpt-6-sol' }, comm_stats: { total_events: 1, calls: 1 },
  communications_with_transcripts: [comm], full_prompt_text: 'Журнал', journal_text: 'События',
  comm_analytics: { calls_total: 1 }, screenshot_stats: {}, silent: true,
};
const audioWait = {
  origin_stage_history_id: '101',
  lose_date: '2026-11-02T00:00:00Z', first_seen_at: '2026-11-02T00:01:00Z',
  deadline_at: '2026-11-03T00:01:00Z', next_check_at: '2026-11-02T00:06:00Z',
  pending_calls: ['12'], observations: { 12: { activity_id: '12' } },
};

test('реальный SQL в изолированной БД PGlite', { skip: !existsSync(pglitePath) }, async (t) => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(migration);
    await db.exec(readFileSync('supabase/migrations/20261106031734_lost_audio_wait_origins.sql', 'utf8'));
    await db.exec(readFileSync('supabase/migrations/20261105065551_lost_overwrite_history.sql', 'utf8'));
    const pool = {
      query(text, values) { return db.query(text, values); },
      async connect() {
        return {
          query(query) {
            return typeof query === 'string' ? db.query(query) : db.query(query.text, query.values);
          },
          release() {},
        };
      },
    };
    async function job(id, { status = 'processing', dealId = 42, silent = true } = {}) {
      await db.query(`INSERT INTO lost_processing_jobs
        (id,request_key,deal_id,lose_date,trigger_type,status,lease_token,lease_until,silent,screenshots)
        VALUES ($1,$2,$3,'2026-11-02T00:00:00Z','batch',$4,$5,now()+interval '1 hour',$6,false)`,
      [id, `test-${id}`, dealId, status, leaseToken, silent]);
    }

    await t.test('успех записывает все три таблицы и завершает job', async () => {
      await job(operation(1));
      const saved = await persistResult(pool, { ...result, operation_id: operation(1) });
      const card = (await db.query('SELECT title, lose_date, comm_analytics, analysis_count FROM lost_deals WHERE deal_id=42')).rows[0];
      const analysis = (await db.query('SELECT id, ai_verdict, ai_facts_json, ai_judge_json, pipeline_operation_id FROM lost_deal_analyses WHERE deal_id=42')).rows[0];
      const communication = (await db.query('SELECT call_duration_seconds, transcript_engine, screenshot_files FROM lost_deal_communications WHERE deal_id=42')).rows[0];
      const state = (await db.query('SELECT status,lease_token,lease_until FROM lost_processing_jobs WHERE id=$1', [operation(1)])).rows[0];
      assert.equal(card.title, deal.title);
      assert.equal(card.analysis_count, 1);
      assert.deepStrictEqual(card.comm_analytics, { calls_total: 1 });
      assert.equal(analysis.id, Number(saved.analysisId));
      assert.equal(analysis.ai_verdict, 'неправомерен');
      assert.equal(analysis.pipeline_operation_id, operation(1));
      assert.equal(communication.call_duration_seconds, 120);
      assert.equal(communication.transcript_engine, 'reserve:gigaam');
      assert.deepStrictEqual(communication.screenshot_files, [{ id: 42 }]);
      assert.deepStrictEqual(state, { status: 'done', lease_token: null, lease_until: null });
      assert.equal((await lookupOperation(pool, operation(1))).analysisStatus, 'processed');
    });

    await t.test('повтор с новой операцией сохраняет даты и скриншоты при пустых новых значениях', async () => {
      await job(operation(2));
      const newComm = { ...comm, screenshot_files: null, screenshot_turns: null, transcript_engine: null };
      await persistResult(pool, { ...result, operation_id: operation(2), deal_data: { ...deal, lose_date: null }, communications_with_transcripts: [newComm] });
      const card = (await db.query('SELECT lose_date,analysis_count FROM lost_deals WHERE deal_id=42')).rows[0];
      const c = (await db.query('SELECT transcript_engine,screenshot_files FROM lost_deal_communications WHERE deal_id=42')).rows[0];
      assert.equal(new Date(card.lose_date).toISOString(), '2026-11-02T00:00:00.000Z');
      assert.equal(card.analysis_count, 2);
      assert.equal(c.transcript_engine, 'reserve:gigaam');
      assert.deepStrictEqual(c.screenshot_files, [{ id: 42 }]);
    });

    await t.test('ожидание и результат через 24 часа завершают разные задания атомарно', async () => {
      await job(operation(3), { dealId: 43 });
      await persistResult(pool, { operation_id: operation(3), lease_token: leaseToken, deal_id: 43, _status: 'waiting_audio', audio_wait: audioWait });
      const waiting = (await db.query('SELECT state,silent FROM lost_audio_wait WHERE deal_id=43')).rows[0];
      assert.deepStrictEqual(waiting, { state: 'waiting', silent: true });
      await job(operation(4), { dealId: 43 });
      await persistResult(pool, {
        ...result, operation_id: operation(4), deal_id: 43, deal_data: { ...deal, deal_id: 43 },
        audio_wait: audioWait, audio_wait_expired: true, communications_with_transcripts: [],
        multi_agent_analysis: { ...result.multi_agent_analysis, verdict: 'недостаточно_данных' },
      });
      const after = (await db.query('SELECT state,checks FROM lost_audio_wait WHERE deal_id=43')).rows[0];
      assert.equal(after.state, 'expired');
      assert.equal(after.checks, 2);
      const history = (await db.query('SELECT ai_verdict FROM lost_deal_analyses WHERE pipeline_operation_id=$1', [operation(4)])).rows[0];
      assert.equal(history.ai_verdict, 'недостаточно_данных');
    });

    await t.test('ошибка SQL откатывает карточку, анализ и статус job', async () => {
      await job(operation(5), { dealId: 44 });
      await assert.rejects(persistResult(pool, {
        ...result, operation_id: operation(5), deal_id: 44, deal_data: { ...deal, deal_id: 44 },
        communications_with_transcripts: [{ ...comm, date: 'не дата' }],
      }));
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_deals WHERE deal_id=44')).rows[0].n, 0);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_deal_analyses WHERE deal_id=44')).rows[0].n, 0);
      assert.equal((await db.query('SELECT status FROM lost_processing_jobs WHERE id=$1', [operation(5)])).rows[0].status, 'processing');
    });

    await t.test('чужая аренда не даёт писать в БД', async () => {
      await job(operation(6), { dealId: 45 });
      await assert.rejects(persistResult(pool, {
        ...result, operation_id: operation(6), lease_token: operation(7), deal_id: 45, deal_data: { ...deal, deal_id: 45 },
      }), /аренда истекла/);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_deals WHERE deal_id=45')).rows[0].n, 0);
    });

    await t.test('технический сбой записывается без вердикта и завершает задание', async () => {
      await job(operation(8), { dealId: 46 });
      await persistResult(pool, {
        operation_id: operation(8), lease_token: leaseToken, deal_id: 46,
        _status: 'error', _error: 'Сбой https://site/rest/65/secretvalue/method',
      });
      const row = (await db.query('SELECT pipeline_error,ai_verdict FROM lost_deal_analyses WHERE pipeline_operation_id=$1', [operation(8)])).rows[0];
      assert.equal(row.pipeline_error.includes('secretvalue'), false);
      assert.equal(row.ai_verdict, null);
      assert.equal((await db.query('SELECT status FROM lost_processing_jobs WHERE id=$1', [operation(8)])).rows[0].status, 'done');
    });

    await t.test('сбой проверки аудио переназначает время по дедлайну и не меняет чужое ожидание', async () => {
      async function setupAudioCheck(dealId, deadlineExpression) {
        await db.query(`INSERT INTO lost_audio_wait
          (deal_id,lose_date,state,first_seen_at,deadline_at,next_check_at)
          VALUES ($1,'2026-11-02T00:00:00Z','waiting',now()-interval '1 hour',${deadlineExpression},now()-interval '1 minute')`, [dealId]);
        const jobs = await enqueueDueAudioChecks(pool);
        const enqueued = jobs.find((row) => Number(row.deal_id) === dealId);
        assert.ok(enqueued);
        await db.query("UPDATE lost_processing_jobs SET status='processing', lease_token=$2, lease_until=now()+interval '1 hour' WHERE id=$1", [enqueued.id, leaseToken]);
        return enqueued;
      }
      async function saveError(job, selectedPool = pool) {
        return persistResult(selectedPool, { operation_id: job.id, lease_token: leaseToken,
          deal_id: Number(job.deal_id), _status: 'error', _error: 'ошибка проверки' });
      }
      for (const [id, deadline, minimum, maximum] of [
        [50, "now()+interval '1 hour'", 299, 301],
        [51, "now()+interval '2 minutes'", 119, 121],
        [52, "now()-interval '1 minute'", 899, 901],
      ]) {
        const check = await setupAudioCheck(id, deadline);
        await saveError(check);
        const row = (await db.query(`SELECT next_check_at,deadline_at,
          'audio-wait:' || deal_id::text || ':' || (extract(epoch from lose_date)*1000000)::bigint::text || ':' ||
            (extract(epoch from next_check_at)*1000000)::bigint::text AS request_key,
          extract(epoch from next_check_at-clock_timestamp()) AS delay
          FROM lost_audio_wait WHERE deal_id=$1`, [id])).rows[0];
        assert.ok(Number(row.delay) >= minimum && Number(row.delay) <= maximum, `неверная задержка ${row.delay}`);
        assert.notEqual(row.request_key, check.request_key);
        if (id === 51) assert.equal(new Date(row.next_check_at).getTime(), new Date(row.deadline_at).getTime());
        assert.equal((await db.query('SELECT status FROM lost_processing_jobs WHERE id=$1', [check.id])).rows[0].status, 'done');
        assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_deal_analyses WHERE pipeline_operation_id=$1', [check.id])).rows[0].n, 1);
      }
      for (const [id, update] of [
        [53, "state='cancelled'"],
        [54, "lose_date=lose_date+interval '1 day'"],
        [55, "next_check_at=next_check_at+interval '10 seconds'"],
      ]) {
        const check = await setupAudioCheck(id, "now()+interval '1 hour'");
        await db.query(`UPDATE lost_audio_wait SET ${update} WHERE deal_id=$1`, [id]);
        const before = (await db.query('SELECT state,lose_date,next_check_at,updated_at FROM lost_audio_wait WHERE deal_id=$1', [id])).rows[0];
        await saveError(check);
        const after = (await db.query('SELECT state,lose_date,next_check_at,updated_at FROM lost_audio_wait WHERE deal_id=$1', [id])).rows[0];
        assert.deepStrictEqual(after, before);
      }
      const check = await setupAudioCheck(56, "now()+interval '1 hour'");
      const before = (await db.query('SELECT next_check_at FROM lost_audio_wait WHERE deal_id=56')).rows[0];
      const failingPool = { async connect() { const c = await pool.connect(); return {
        async query(query) { const res = await c.query(query); if (typeof query !== 'string' && query.text.includes("SET status='done'")) return { rowCount: 0, rows: [] }; return res; },
        release() { c.release(); },
      }; } };
      await assert.rejects(saveError(check, failingPool), /Аренда задачи истекла/);
      assert.deepStrictEqual((await db.query('SELECT next_check_at FROM lost_audio_wait WHERE deal_id=56')).rows[0], before);
      assert.equal((await db.query('SELECT status FROM lost_processing_jobs WHERE id=$1', [check.id])).rows[0].status, 'processing');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_deal_analyses WHERE pipeline_operation_id=$1', [check.id])).rows[0].n, 0);
    });

    await t.test('пропуск технического отказа записывает карточку без анализа', async () => {
      await job(operation(9), { dealId: 47 });
      await persistResult(pool, {
        operation_id: operation(9), lease_token: leaseToken, deal_id: 47,
        deal_data: { ...deal, deal_id: 47, lose_reason: 'Дубль' }, _status: 'skipped_by_reason',
      });
      const card = (await db.query('SELECT lose_reason, analysis_count FROM lost_deals WHERE deal_id=47')).rows[0];
      assert.deepStrictEqual(card, { lose_reason: 'Дубль', analysis_count: 0 });
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_deal_analyses WHERE deal_id=47')).rows[0].n, 0);
      assert.equal((await db.query('SELECT status FROM lost_processing_jobs WHERE id=$1', [operation(9)])).rows[0].status, 'done');
    });

    await t.test('потерянный ответ COMMIT разрешается только последующим чтением', async () => {
      await job(operation(10), { dealId: 48 });
      const droppedReplyPool = {
        async connect() {
          return {
            async query(query) {
              const text = typeof query === 'string' ? query : query.text;
              const response = typeof query === 'string' ? await db.query(query) : await db.query(query.text, query.values);
              if (text === 'COMMIT') throw new Error('Потерян ответ');
              return response;
            },
            release() {},
          };
        },
      };
      await assert.rejects(persistResult(droppedReplyPool, {
        ...result, operation_id: operation(10), deal_id: 48, deal_data: { ...deal, deal_id: 48 },
      }), (error) => error.code === 'COMMIT_OUTCOME_UNKNOWN' && error.operationId === operation(10));
      const status = await lookupOperation(pool, operation(10));
      assert.equal(status.jobStatus, 'done');
      assert.equal(status.analysisStatus, 'processed');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lost_deal_analyses WHERE pipeline_operation_id=$1', [operation(10)])).rows[0].n, 1);
    });

    await t.test('нетихий разбор остаётся в processing и читается для продолжения', async () => {
      await job(operation(11), { dealId: 49, silent: false });
      const saved = await persistResult(pool, {
        ...result, operation_id: operation(11), deal_id: 49, deal_data: { ...deal, deal_id: 49 },
      });
      assert.equal(saved.needsExternalActions, true);
      const state = (await db.query('SELECT status,lease_token FROM lost_processing_jobs WHERE id=$1', [operation(11)])).rows[0];
      assert.equal(state.status, 'processing');
      assert.equal(state.lease_token, leaseToken);
      const resumed = await loadResumableResult(pool, { operation_id: operation(11), lease_token: leaseToken });
      assert.equal(resumed.result.deal_id, 49);
      assert.equal(resumed.result.multi_agent_analysis.verdict, 'неправомерен');
      assert.equal(resumed.result.prompt_version, 'v2.8-sol');
      assert.equal(resumed.silent, false);
    });
  } finally {
    await db.close();
  }
});
