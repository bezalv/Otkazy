import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nightlyDayIfDue, runDueNightly, resumeNightly, listPendingNightlies } from '../../app/src/retry/nightly.mjs';
import { createJobQueue } from '../../app/src/queue/index.mjs';

const pglitePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const day = '2026-11-05';
const due = Date.parse('2026-11-04T21:00:00.000Z');
const item = id => ({ requestKey: `nightly:${day}:${id}`, dealId: id, loseDate: '2026-11-04T00:00:00.000Z', triggerType: 'nightly', silent: true, screenshots: true });

test('новый ночной день начинается строго в 04:00 Новосибирска', () => {
  assert.equal(nightlyDayIfDue(due - 1), null);
  assert.equal(nightlyDayIfDue(due), day);
  assert.equal(nightlyDayIfDue(Date.parse('2026-11-05T16:59:59Z')), day);
  assert.equal(nightlyDayIfDue(Date.parse('2026-11-05T17:00:00Z')), null);
  assert.throws(() => nightlyDayIfDue(NaN), /время/i);
});

test('ночной план не может содержать больше 20 сделок или чужой requestKey', async () => {
  const pool = { async query() { return { rows: [] }; } };
  const queue = { async enqueueNightlyBudgeted() { assert.fail('невалидный план нельзя поставить в очередь'); } };
  await assert.rejects(runDueNightly({ pool, queue, nowMs: due,
    preparePlan: async () => ({ actions: Array.from({ length: 21 }, (_, i) => item(i + 1)), deferred: [] }) }), /план/i);
  await assert.rejects(runDueNightly({ pool, queue, nowMs: due,
    preparePlan: async () => ({ actions: [{ ...item(1), requestKey: 'bad' }], deferred: [] }) }), /задание/i);
});

test('план фиксируется и безопасно возобновляется в изолированной БД', { skip: !existsSync(pglitePath) }, async t => {
  const { PGlite } = await import(pathToFileURL(pglitePath).href);
  const db = new PGlite();
  try {
    await db.exec(readFileSync('tests/restore-persistence/synthetic-schema.sql', 'utf8'));
    await db.exec(readFileSync('db/proposals/worker-migration-fixtures/20261105052525_lost_processing_jobs.sql', 'utf8'));
    const pool = { query: (text, values) => db.query(text, values), transaction: fn => db.transaction(fn) };
    const jobs = new Map();
    const queue = { async enqueueNightlyBudgeted(action) { jobs.set(action.requestKey, action); return { created: true }; } };
    let prepared = 0;
    const preparePlan = async args => {
      prepared++;
      assert.equal(args.mode, 'nightly');
      assert.equal(args.runKey, day);
      return { actions: [item(1), item(2)], deferred: [{ dealId: 3, reason: 'lose_date_unavailable' }] };
    };

    await t.test('сбой одного enqueue не теряет снимок и не добавляет новых сделок', async () => {
      let fail = true;
      const flaky = { async enqueueNightlyBudgeted(action) {
        if (action.dealId === 2 && fail) { fail = false; throw new Error('connection lost'); }
        return queue.enqueueNightlyBudgeted(action);
      } };
      const first = await runDueNightly({ pool, queue: flaky, preparePlan, nowMs: due });
      assert.equal(first.status, 'planned');
      assert.deepEqual(first.failed, [{ dealId: 2, reason: 'enqueue_failed' }]);
      assert.deepEqual(await listPendingNightlies(pool), [day]);
      const second = await runDueNightly({ pool, queue: flaky, nowMs: due + 10000,
        preparePlan: async () => assert.fail('план уже зафиксирован') });
      assert.equal(second.status, 'enqueued');
      assert.equal(jobs.size, 2);
      assert.equal(prepared, 1);
      assert.deepEqual(await listPendingNightlies(pool), []);
    });

    await t.test('повтор того же дня не выполняет enqueue и не вызывает planner', async () => {
      const result = await runDueNightly({ pool, nowMs: due + 20000,
        queue: { async enqueueNightlyBudgeted() { assert.fail('план уже выполнен'); } },
        preparePlan: async () => assert.fail('план уже выполнен') });
      assert.equal(result.status, 'enqueued');
      assert.equal(result.actions.length, 2);
      assert.equal((await resumeNightly({ pool, queue, runDate: day })).status, 'enqueued');
    });

    await t.test('неизвестный исход INSERT не начинает enqueue и разрешается чтением', async () => {
      const anotherDay = '2026-11-06';
      const anotherDue = Date.parse('2026-11-05T21:00:00.000Z');
      let loseResponse = true;
      const uncertainPool = { async query(text, values) {
        const result = await db.query(text, values);
        if (loseResponse && text.includes('INSERT INTO public.lost_nightly_retry_runs')) {
          loseResponse = false;
          throw new Error('тест: ответ потерян после COMMIT');
        }
        return result;
      } };
      let sent = 0;
      const counted = { async enqueueNightlyBudgeted() { sent++; } };
      const plan = { actions: [{ ...item(4), requestKey: `nightly:${anotherDay}:4` }], deferred: [] };
      await assert.rejects(runDueNightly({ pool: uncertainPool, queue: counted, nowMs: anotherDue,
        preparePlan: async () => plan }), /потерян/);
      assert.equal(sent, 0);
      assert.deepEqual(await listPendingNightlies(pool), [anotherDay]);
      const resumed = await resumeNightly({ pool, queue: counted, runDate: anotherDay });
      assert.equal(resumed.status, 'enqueued');
      assert.equal(sent, 1);
    });

    await t.test('параллельные кандидаты используют один сохранённый план', async () => {
      const otherDay = '2026-11-07';
      const at = Date.parse('2026-11-06T21:00:00.000Z');
      const action = id => ({ ...item(id), requestKey: `nightly:${otherDay}:${id}` });
      const candidate = id => async () => ({ actions: [action(id)], deferred: [] });
      const received = new Set();
      const deduplicated = { async enqueueNightlyBudgeted(a) { received.add(a.requestKey); } };
      const results = await Promise.all([
        runDueNightly({ pool, queue: deduplicated, nowMs: at, preparePlan: candidate(5) }),
        runDueNightly({ pool, queue: deduplicated, nowMs: at, preparePlan: candidate(6) }),
      ]);
      assert.equal(results[0].actions[0].requestKey, results[1].actions[0].requestKey);
      assert.equal(received.size, 1);
    });

    await t.test('реальная очередь не дублирует задание после потери ответа enqueue', async () => {
      const localDay = '2026-11-08';
      const at = Date.parse('2026-11-07T21:00:00.000Z');
      const planned = { actions: [{ ...item(7), requestKey: `nightly:${localDay}:7` }], deferred: [] };
      const actualQueue = createJobQueue(pool);
      let loseResponse = true;
      const flaky = { async enqueueNightlyBudgeted(action) {
        const result = await actualQueue.enqueueNightlyBudgeted(action);
        if (loseResponse) { loseResponse = false; throw new Error('ответ потерян после постановки'); }
        return result;
      } };
      const first = await runDueNightly({ pool, queue: flaky, nowMs: at, preparePlan: async () => planned });
      assert.equal(first.status, 'planned');
      const recovered = await resumeNightly({ pool, queue: flaky, runDate: localDay });
      assert.equal(recovered.status, 'enqueued');
      const result = await db.query('SELECT count(*)::int AS count FROM public.lost_processing_jobs WHERE request_key=$1', [planned.actions[0].requestKey]);
      assert.equal(result.rows[0].count, 1);
    });

    await t.test('до 04:00 не создаётся план текущего дня и не планируется прошлая дата', async () => {
      const result = await runDueNightly({ pool, queue, nowMs: Date.parse('2026-11-08T19:00:00Z'),
        preparePlan: async () => assert.fail('ещё не 04:00') });
      assert.deepEqual(result, { status: 'not_due' });
      assert.deepEqual(await resumeNightly({ pool, queue, runDate: '2026-11-01' }), { status: 'not_found', day: '2026-11-01' });
    });
  } finally { await db.close(); }
});
