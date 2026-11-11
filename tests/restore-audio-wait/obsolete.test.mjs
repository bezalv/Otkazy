import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { enqueueDueAudioChecks } from '../../app/src/audio-wait/scheduler.mjs';
import { createJobQueue } from '../../app/src/queue/index.mjs';

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
test('устаревший переход отменяет только своё старое ожидание аудио', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8'));
    await db.exec(readFileSync('db/proposals/worker-migration-fixtures/20261105052525_lost_processing_jobs.sql', 'utf8'));
    await db.exec(readFileSync('db/proposals/worker-migration-fixtures/20261106031734_lost_audio_wait_origins.sql', 'utf8'));
    await db.exec(`INSERT INTO lost_audio_wait
      (deal_id,lose_date,state,first_seen_at,deadline_at,next_check_at,origin_stage_history_id)
      VALUES (42,'2026-10-01','waiting','2026-10-01','2026-10-02','2026-10-01','101')`);
    const pool = { query: (q, values) => db.query(q, values) };
    const queue = createJobQueue(pool);
    await enqueueDueAudioChecks(pool);
    const first = await queue.claim();
    assert.equal(await queue.finishObsoleteTransition(first.id, first.lease_token, '101'), true);
    assert.equal((await db.query('SELECT state FROM lost_audio_wait')).rows[0].state, 'cancelled');

    await db.exec("UPDATE lost_audio_wait SET state='waiting', lose_date='2026-10-03', next_check_at='2026-10-03'");
    await enqueueDueAudioChecks(pool);
    const second = await queue.claim();
    await db.exec("UPDATE lost_audio_wait SET lose_date='2026-10-04', next_check_at='2026-10-04'");
    assert.equal(await queue.finishObsoleteTransition(second.id, second.lease_token, '101'), true);
    assert.equal((await db.query('SELECT state FROM lost_audio_wait')).rows[0].state, 'waiting');
  } finally { await db.close(); }
});
