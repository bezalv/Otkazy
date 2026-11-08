import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditChatAliasCandidates } from '../../app/src/pilot/chat-alias-audit.mjs';

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
test('ручной аудит читает кандидатов без отождествления и учитывает только один чат', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8'));
    await db.query(`INSERT INTO public.lost_deal_communications (deal_id,event_type,chat_id,event_id) VALUES
      (42,'chat','12','chat_12_56'),(42,'chat','12','34_56'),(42,'chat','12','34_57'),
      (42,'chat','13','35_58'),(42,'chat','12','chat_13_58'),(42,'chat','12','chat_12_file_58'),
      (42,'call','12','34_58'),(43,'chat','12','34_58')`);
    const calls = [];
    const pool = { async connect() { return { query(q) {
      calls.push(typeof q === 'string' ? q : q.text);
      return typeof q === 'string' ? db.query(q) : db.query(q.text, q.values);
    }, release() {} }; } };
    assert.deepEqual(await auditChatAliasCandidates({pool, dealId:42, chatId:12, messageIds:[56,57,58]}), [
      {messageId:'56', candidateEventIds:['34_56','chat_12_56'], status:'multiple_candidates'},
      {messageId:'57', candidateEventIds:['34_57'], status:'one_unverified_candidate'},
      {messageId:'58', candidateEventIds:[], status:'none'},
    ]);
    assert.match(calls[0], /READ ONLY/);
    assert.equal(calls.at(-1), 'COMMIT');
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM public.lost_deal_communications')).rows[0].n), 8);
  } finally { await db.close(); }
});

test('пределы и непроверенный ответ БД не выдаются за подтверждение', async () => {
  let connected = false, released = false;
  const log = [];
  const pool = { async connect() { connected = true; return { async query(q) {
    log.push(typeof q === 'string' ? q : 'SELECT');
    return typeof q === 'string' ? {} : {rows:[{event_id:'chat_13_56'}]};
  }, release() { released = true; } }; } };
  for (const messageIds of [[], [1,1], Array.from({length:51}, (_,i) => i+1), ['01']]) {
    await assert.rejects(auditChatAliasCandidates({pool,dealId:42,chatId:12,messageIds}));
    assert.equal(connected, false);
  }
  await assert.rejects(auditChatAliasCandidates({pool,dealId:42,chatId:12,messageIds:[56]}), /Некорректный ответ/);
  assert.deepEqual(log, ['BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY','SELECT','ROLLBACK']);
  assert.equal(released, true);
});
