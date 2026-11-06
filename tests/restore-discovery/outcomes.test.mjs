import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOutcomeComparator, scanLostTransitions } from '../../app/src/discovery/outcomes.mjs';

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const schema = readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8');
const queueMigration = readFileSync('supabase/migrations/20261105052525_lost_processing_jobs.sql', 'utf8');
const liveMigration = readFileSync('supabase/migrations/20261105065540_lost_bitrix_events.sql', 'utf8');
const date = '2026-11-04T00:00:00.000Z';
const event = (history, deal, occurred = date) => ({
  event_key: `bitrix24:deal-stage-history:${history}`, deal_id: deal, occurred_at: occurred,
});
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function poolFor(db) {
  return { async connect() { return {
    query(query, values) { return typeof query === 'string' ? db.query(query, values) : db.query(query.text, query.values); },
    release() {},
  }; } };
}

test('сверка не обрезает микросекунды до доступа к БД', async () => {
  let connected = false;
  const pool = { async connect() { connected = true; throw new Error('не должен подключаться'); } };
  await assert.rejects(createOutcomeComparator(pool)([event(1, 42, '2026-11-04T00:00:00.000700Z')]), /дата/);
  assert.equal(connected, false);
});

test('до установки новых миграций чистая сделка проверяется по старой схеме', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.query('INSERT INTO public.lost_deals (deal_id) VALUES (43)');
    const result = await createOutcomeComparator(poolFor(db))([event(1, 42), event(2, 43)]);
    assert.deepEqual(result, [
      { event_key: event(1, 42).event_key, status: 'not_found', complete: true },
      { event_key: event(2, 43).event_key, status: 'unknown' },
    ]);
  } finally { await db.close(); }
});

test('сверка различает историю n8n, ожидание и конкретные новые операции', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(queueMigration);
    await db.exec(liveMigration);
    await db.query('INSERT INTO public.lost_deals (deal_id) VALUES (43)');
    await db.query('INSERT INTO public.lost_deal_analyses (deal_id,ai_verdict) VALUES (44,$1)', ['неправомерен']);
    await db.query("INSERT INTO public.lost_deal_communications (deal_id,event_type,event_id) VALUES (45,'call','1')");
    for (const deal of [46, 53, 55, 59]) {
      await db.query(`INSERT INTO public.lost_audio_wait (deal_id,lose_date,state,first_seen_at,deadline_at,next_check_at)
        VALUES ($1,$2,$3,$2,$2,$2)`, [deal, date, deal === 53 ? 'done' : 'waiting']);
    }
    await db.query('INSERT INTO public.lost_bitrix_events (id,deal_id) VALUES ($1,47)', [uuid(47)]);
    async function job(deal, history, status = 'done', loseDate = date) {
      await db.query(`INSERT INTO public.lost_processing_jobs (id,request_key,deal_id,lose_date,trigger_type,status)
        VALUES ($1,$2,$3,$4,'live',$5)`, [uuid(deal), event(history, deal).event_key, deal, loseDate, status]);
    }
    await job(48, 8);
    await db.query('INSERT INTO public.lost_deal_analyses (deal_id,pipeline_operation_id,ai_verdict) VALUES (48,$1,$2)', [uuid(48), 'правомерен']);
    await job(49, 9);
    await db.query('INSERT INTO public.lost_deal_analyses (deal_id,pipeline_operation_id,pipeline_error) VALUES (49,$1,$2)', [uuid(49), 'сбор неполный']);
    await job(50, 10);
    await job(51, 11, 'needs_review');
    await db.query('INSERT INTO public.lost_deal_analyses (deal_id,pipeline_operation_id,ai_verdict) VALUES (51,$1,$2)', [uuid(51), 'неправомерен']);
    await job(52, 12, 'done', '2026-11-03T00:00:00Z');
    await job(54, 999, 'pending');
    await db.query("INSERT INTO public.lost_bitrix_events (id,deal_id,status,outcome) VALUES ($1,56,'done','ignored')", [uuid(56)]);
    await job(57, 18);
    await db.query('INSERT INTO public.lost_deal_analyses (deal_id,pipeline_operation_id,ai_verdict) VALUES (57,$1,$2)', [uuid(57), 'правомерен']);
    await db.query("INSERT INTO public.lost_processing_jobs (id,request_key,deal_id,lose_date,trigger_type,status) VALUES ($1,'manual-other',57,$2,'manual','pending')", [uuid(157), date]);
    await job(58, 19);
    await db.query("INSERT INTO public.lost_deal_analyses (deal_id,pipeline_operation_id,pipeline_error) VALUES (58,$1,'ошибка')", [uuid(58)]);
    await db.query("INSERT INTO public.lost_processing_jobs (id,request_key,deal_id,lose_date,trigger_type,status) VALUES ($1,'nightly-other',58,$2,'nightly','done')", [uuid(158), date]);
    await job(59, 20);
    await db.query('INSERT INTO public.lost_deal_analyses (deal_id,pipeline_operation_id,ai_verdict) VALUES (59,$1,$2)', [uuid(59), 'правомерен']);
    const input = [event(1, 42), event(2, 43), event(3, 44), event(4, 45), event(5, 46),
      event(6, 46, '2026-11-03T00:00:00Z'), event(7, 47), event(8, 48), event(9, 49), event(10, 50),
      event(11, 51), event(12, 52), event(13, 53), event(14, 54), event(15, 55), event(16, 55), event(17, 56), event(18, 57), event(19, 58), event(20, 59)];
    const result = await createOutcomeComparator(poolFor(db))(input);
    assert.deepEqual(result.map(item => item.status), [
      'not_found', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown',
      'processed', 'pipeline_error', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown',
    ]);
    assert.equal(result[4].reason, 'audio_wait_transition_unverified');
    assert.deepEqual(result[7].evidence, { event_key: event(8, 48).event_key });
    assert.deepEqual(result[8].evidence, { event_key: event(9, 49).event_key });
  } finally { await db.close(); }
});

test('одинаковое время отказа на разных страницах не подтверждает ожидание', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.query(`INSERT INTO public.lost_audio_wait (deal_id,lose_date,state,first_seen_at,deadline_at,next_check_at)
      VALUES (42,$1,'waiting',$1,$1,$1)`, [date]);
    const compare = createOutcomeComparator(poolFor(db));
    for (const item of [event(1, 42), event(2, 42)]) {
      assert.equal((await compare([item]))[0].status, 'unknown');
    }
  } finally { await db.close(); }
});

test('роль с активной RLS не может доказать отсутствие скрытых строк', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.query('INSERT INTO public.lost_deals (deal_id) VALUES (42)');
    await db.exec(`CREATE ROLE limited; GRANT USAGE ON SCHEMA public TO limited;
      GRANT SELECT ON public.lost_deals,public.lost_deal_analyses,public.lost_deal_communications,public.lost_audio_wait TO limited;
      ALTER TABLE public.lost_deals ENABLE ROW LEVEL SECURITY; SET ROLE limited`);
    await assert.rejects(createOutcomeComparator(poolFor(db))([event(1, 42)]), /Не удалось сверить/);
    await db.exec('RESET ROLE');
  } finally { await db.close(); }
});

test('повреждённый вход не обращается к БД', async () => {
  const compare = createOutcomeComparator({ async connect() { assert.fail('БД не должна вызываться'); } });
  for (const events of [[event(1, true)], [event(1, 2147483648)], [event(1, 1, '2026-11-04')], [event(1, 1), event(1, 2)], [{ ...event(1, 1), event_key: 'bad' }]]) {
    await assert.rejects(compare(events));
  }
});

test('ошибка БД не превращается в доказательство пропуска и не раскрывается', async () => {
  const compare = createOutcomeComparator({ async connect() { throw new Error('https://private.invalid/token'); } });
  await assert.rejects(compare([event(1, 1)]), error => !error.message.includes('private.invalid'));
});

test('сканирование не создаёт заданий и сохраняет предупреждение о полноте', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(schema);
    const client = { async request() { return { result: { items: [
      { ID: '1', OWNER_ID: '42', STAGE_ID: 'C23:LOSE', CREATED_TIME: date },
    ] }, total: 1 }; } };
    const result = await scanLostTransitions({ pool: poolFor(db), client, from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z' });
    assert.equal(result.events[0].disposition, 'unprocessed');
    assert.equal(result.coverage_guaranteed, false);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.lost_deal_analyses')).rows[0].count, 0);
  } finally { await db.close(); }
});
