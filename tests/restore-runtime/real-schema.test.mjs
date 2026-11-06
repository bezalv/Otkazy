import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assertAudioOriginSchema } from '../../app/src/application.mjs';

const root = process.env.OTKAZY_ISOLATED_PG_ROOT;
const enabled = typeof root === 'string' && /^\/tmp\/otkazy-isolated-[a-zA-Z0-9]{8}$/.test(root);

test('настоящий PostgreSQL: active блокируется до миграции ожидания аудио', { skip: !enabled }, async () => {
  const { default: pg } = await import('../../app/node_modules/pg/lib/index.js');
  const pool = new pg.Pool({ host: `${root}/sock`, port: 55527, user: 'postgres', database: 'otkazy_schema_test_1', max: 1 });
  try {
    const identity = await pool.query("SELECT current_database() AS db, current_setting('data_directory') AS dir, inet_server_addr() AS addr");
    assert.deepEqual(identity.rows[0], { db: 'otkazy_schema_test_1', dir: `${root}/pgdata`, addr: null });
    await pool.query('CREATE TABLE public.lost_audio_wait (deal_id bigint PRIMARY KEY)');
    await assert.rejects(assertAudioOriginSchema(pool), /Схема ожидания аудио/);
    await pool.query(await readFile('supabase/migrations/20261106031734_lost_audio_wait_origins.sql', 'utf8'));
    await assert.doesNotReject(assertAudioOriginSchema(pool));
    await pool.query('ALTER TABLE public.lost_audio_wait DROP CONSTRAINT lost_audio_wait_origin_stage_history_id_check');
    await assert.rejects(assertAudioOriginSchema(pool), /Схема ожидания аудио/);
  } finally { await pool.end(); }
});
