import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJobQueue } from '../../app/src/queue/index.mjs';
import { persistResult, loadResumableResult } from '../../app/src/persistence/index.mjs';
import { runJob } from '../../app/src/worker/run-job.mjs';

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
test('тихий разбор проходит конвейер и сохраняется в изолированном PostgreSQL', { skip: !existsSync(pglitePath) }, async () => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8'));
    await db.exec(readFileSync('supabase/migrations/20261105052525_lost_processing_jobs.sql', 'utf8'));
    const query = (q, values) => typeof q === 'string' ? db.query(q, values) : db.query(q.text, q.values);
    const pool = { query, async connect() { return { query, release() {} }; } };
    const queue = createJobQueue(pool);
    await queue.enqueue({ requestKey: 'fixture-1', dealId: 42, loseDate: '2026-11-04T00:00:00Z', triggerType: 'batch', silent: true, screenshots: false });
    const job = await queue.claim();
    const bitrix = { async request(method, body) {
      if (method === 'crm.deal.userfield.list') return { result: [{ LIST: [{ ID: '1', VALUE: 'Другая' }] }] };
      if (method === 'crm.deal.get') return { result: { ID: '42', TITLE: 'Тест', STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: '65', UF_CRM_1584703948317: '1' } };
      if (method === 'crm.stagehistory.list') return { result: { items: [{ STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] } };
      if (method === 'crm.activity.list' || method === 'imopenlines.crm.chat.get' || method === 'crm.timeline.comment.list') return { result: [] };
      if (method === 'tasks.task.list') return { result: { tasks: [] } };
      throw new Error('unexpected method');
    } };
    const result = await runJob({ job, queue,
      store: { loadResumableResult: args => loadResumableResult(pool, args), persistResult: data => persistResult(pool, data) },
      loadAudioWait: async () => null,
      processOptions: { bitrix, nowMs: Date.parse('2026-11-05T00:00:00Z'), audioWaitEnabledAt: '2026-11-01T00:00:00Z',
        wait: async () => {}, judgeSystemPrompt: 'Промпт судьи', writerSystemPrompt: 'Промпт писателя',
        llm: { async complete() { assert.fail('пустую сделку не нужно отправлять в модель'); } } },
    });
    assert.equal(result.status, 'processed');
    const analysis = (await db.query('SELECT ai_verdict,pipeline_error FROM lost_deal_analyses WHERE deal_id=42')).rows[0];
    assert.equal(analysis.ai_verdict, 'недостаточно_данных');
    assert.equal(analysis.pipeline_error, null);
    assert.equal((await db.query('SELECT status FROM lost_processing_jobs WHERE id=$1', [job.id])).rows[0].status, 'done');
  } finally { await db.close(); }
});
