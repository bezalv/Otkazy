import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const schema = readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8');
const proposal = readFileSync('db/proposals/20261108_chat_identity_guard.sql', 'utf8');
const preflight = readFileSync('db/proposals/20261108_chat_identity_preflight.sql', 'utf8');

test('проект индекса защищает обе формы сообщения без объединения содержимого', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(schema);
    // PGlite исполняет синхронную версию того же DDL на изолированной базе.
    await db.exec(proposal.replace('CREATE UNIQUE INDEX CONCURRENTLY', 'CREATE UNIQUE INDEX'));
    const insert = (deal, type, chat, event) => db.query(
      'INSERT INTO public.lost_deal_communications (deal_id,event_type,chat_id,event_id) VALUES ($1,$2,$3,$4)',
      [deal, type, chat, event]);
    await insert(42, 'chat', '12', 'chat_12_56');
    await assert.rejects(insert(42, 'chat', '12', '34_56'), error => error.code === '23505');
    await insert(42, 'chat', '12', '34_57');
    await assert.rejects(insert(42, 'chat', '12', 'chat_12_57'), error => error.code === '23505');
    // Другой чат/сделка, звонки и отдельные вложения не склеиваются.
    await insert(42, 'chat', '13', '34_56');
    await insert(43, 'chat', '12', '34_56');
    await insert(42, 'call', '12', '34_56');
    await insert(42, 'chat', '12', 'chat_12_file_56');
    // Некорректная/неизвестная привязка остаётся вне охвата и видна в аудите.
    await insert(42, 'chat', '12', 'chat_13_58');
    await insert(42, 'chat', null, '34_59');
    const first = preflight.split('\n\n-- Если')[0];
    const rows = (await db.query(first)).rows;
    assert.deepEqual(rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]))),
      [{chat_rows: 7, covered_rows: 4, uncovered_rows: 3, candidate_collision_groups: 0, candidate_collision_rows: 0}]);
  } finally { await db.close(); }
});

test('аудит находит обе формы до создания индекса и не меняет строки', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.query("INSERT INTO public.lost_deal_communications (deal_id,event_type,chat_id,event_id) VALUES (42,'chat','12','chat_12_56'),(42,'chat','12','34_56')");
    const result = (await db.query(preflight.split('\n\n-- Если')[0])).rows[0];
    assert.equal(Number(result.candidate_collision_groups), 1);
    assert.equal(Number(result.candidate_collision_rows), 2);
    await assert.rejects(db.exec(proposal.replace('CREATE UNIQUE INDEX CONCURRENTLY', 'CREATE UNIQUE INDEX')),
      error => error.code === '23505');
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM public.lost_deal_communications')).rows[0].n), 2);
  } finally { await db.close(); }
});
