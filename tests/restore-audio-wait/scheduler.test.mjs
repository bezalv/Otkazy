import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { enqueueDueAudioChecks, loadAudioWait, loadAudioWaitEnabledAt } from '../../app/src/audio-wait/scheduler.mjs';
import { createJobQueue } from '../../app/src/queue/index.mjs';
import { runJob } from '../../app/src/worker/run-job.mjs';

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
test('ожидающие записи ставятся в очередь один раз и сохраняют параметры', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8'));
    await db.exec(readFileSync('supabase/migrations/20261105052525_lost_processing_jobs.sql', 'utf8'));
    await db.query(`INSERT INTO public.lost_audio_wait
      (deal_id,lose_date,state,first_seen_at,deadline_at,next_check_at,silent,screenshots)
      VALUES (42,'2026-10-01T00:00:00Z','waiting','2026-10-01T00:00:00Z','2026-10-02T00:00:00Z','2026-10-01T00:05:00Z',true,true)`);
    await db.query("INSERT INTO public.lost_audio_wait_config (id,enabled_at) VALUES (true,'2026-09-01T00:00:00Z')");
    assert.equal(await loadAudioWaitEnabledAt(db), '2026-09-01T00:00:00.000Z');
    assert.equal((await loadAudioWait(db, { deal_id: 42 })).state, 'waiting');
    assert.equal((await enqueueDueAudioChecks(db)).length, 1);
    assert.equal((await enqueueDueAudioChecks(db)).length, 0);
    const row = (await db.query('SELECT * FROM public.lost_processing_jobs')).rows[0];
    assert.equal(row.silent, true);
    assert.equal(row.screenshots, true);
    assert.equal(row.trigger_type, 'audio_wait');
    await db.query("UPDATE public.lost_audio_wait SET next_check_at='2026-10-01T00:10:00Z'");
    const pool = { query: (text, values) => db.query(text, values) };
    const queue = createJobQueue(pool);
    const oldJob = await queue.claim();
    const outcome = await runJob({ job: oldJob, queue, loadAudioWait: job => loadAudioWait(pool, job),
      store: { async loadResumableResult() { return null; }, async persistResult() { assert.fail('устаревшая проверка не должна сохранять разбор'); } },
      process: async () => assert.fail('устаревшая проверка не должна собирать сделку') });
    assert.equal(outcome.status, 'obsolete');
    assert.equal((await loadAudioWait(pool, { deal_id: 42 })).state, 'waiting');
    assert.equal((await enqueueDueAudioChecks(db)).length, 1);
    await db.query("UPDATE public.lost_audio_wait SET state='done'");
    assert.equal((await enqueueDueAudioChecks(db)).length, 0);
  } finally { await db.close(); }
});
