import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createDelivery } from '../../app/src/delivery/index.mjs';
import { createJobQueue } from '../../app/src/queue/index.mjs';
import { createHash } from 'node:crypto';
import { createBitrixClient } from '../../app/src/bitrix-client.mjs';
import { createBitrixLimiter } from '../../app/src/bitrix-limiter.mjs';

const pglite = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const migration = readFileSync('db/proposals/worker-migration-fixtures/20261105052525_lost_processing_jobs.sql', 'utf8');
const lease = '00000000-0000-4000-8000-000000000099';
const jobId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('состояния доставки после транзакции результата', { skip: !existsSync(pglite) }, async t => {
  const { PGlite } = await import(pathToFileURL(pglite).href);
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE lost_deals (deal_id bigint primary key, title text);
    CREATE TABLE lost_deal_analyses (id bigint primary key, deal_id bigint, ai_verdict text,
      ai_judge_json jsonb, pipeline_error text, prompt_version text);`);
  await db.exec(migration);
  const pool = { async connect() { return { query: (sql, args) => db.query(sql, args), release() {} }; } };
  async function add(n, { deal = n, verdict = 'неправомерен', closure = 'other', silent = false, state = 'pending' } = {}) {
    await db.query('INSERT INTO lost_deals VALUES ($1,$2) ON CONFLICT DO NOTHING', [deal, 'Тест']);
    await db.query(`INSERT INTO lost_processing_jobs
      (id,request_key,deal_id,lose_date,trigger_type,status,lease_token,lease_until,silent,comment_state)
      VALUES ($1,$2,$3,now(),'live','processing',$4,now()+interval '1 hour',$5,$6)`, [jobId(n), `job-${n}`, deal, lease, silent, state]);
    await db.query('INSERT INTO lost_deal_analyses (id,deal_id,ai_verdict,ai_judge_json,pipeline_operation_id) VALUES ($1,$2,$3,$4,$5)',
      [n, deal, verdict, JSON.stringify({ verdict, closure_reason_class: closure, verdict_reason_short: 'Причина', final_comment: 'Текст' }), jobId(n)]);
  }
  const row = async n => (await db.query(`SELECT status, comment_state, comment_id, notify_state FROM lost_processing_jobs WHERE id=$1`, [jobId(n)])).rows[0];
  const events = [];
  const client = { async request(method, body) {
    events.push({ method, body });
    if (method === 'crm.timeline.comment.add') {
      const current = (await db.query('SELECT comment_state, comment_sha256, comment_attempted_at FROM lost_processing_jobs WHERE deal_id=$1 AND status=\'processing\'', [body.fields.ENTITY_ID])).rows[0];
      assert.equal(current.comment_state, 'sending');
      assert.equal(current.comment_sha256, createHash('sha256').update(body.fields.COMMENT, 'utf8').digest('hex'));
      assert.ok(current.comment_attempted_at);
    }
    return { result: method === 'crm.timeline.comment.add' ? 77 : 98 };
  } };
  const delivery = createDelivery(pool, client, { now: () => Date.parse('2026-11-05T00:00:00Z') });

  await t.test('комментарий и уведомления отправлены один раз', async () => {
    await add(1);
    assert.deepEqual(await delivery.deliver(jobId(1), lease), { state: 'done' });
    assert.deepEqual(await row(1), { status: 'done', comment_state: 'ok', comment_id: '77', notify_state: 'ok' });
    assert.deepEqual(events.map(e => e.method), ['crm.timeline.comment.add', 'im.notify.system.add', 'im.notify.system.add', 'im.notify.system.add']);
    const sentText = events[0].body.fields.COMMENT;
    const check = (await db.query('SELECT comment_sha256, comment_attempted_at, row_to_json(j) AS job FROM lost_processing_jobs j WHERE id=$1', [jobId(1)])).rows[0];
    assert.equal(check.comment_sha256, createHash('sha256').update(sentText, 'utf8').digest('hex'));
    assert.ok(Number.isFinite(new Date(check.comment_attempted_at).getTime()));
    assert.ok(!JSON.stringify(check.job).includes(sentText));
    assert.ok(!JSON.stringify(check.job).includes('Текст'));
    const n = (await db.query('SELECT ai_judge_json->\'notification\' AS n FROM lost_deal_analyses WHERE id=1')).rows[0].n;
    assert.equal(n.status, 'ok'); assert.deepEqual(n.delivered, [65, 26175, 19601]);
    await assert.rejects(delivery.deliver(jobId(1), lease));
  });
  await t.test('тихий запуск ничего не отправляет', async () => {
    await add(2, { silent: true }); const before = events.length;
    assert.equal((await delivery.deliver(jobId(2), lease)).state, 'done');
    assert.equal(events.length, before); assert.equal((await row(2)).notify_state, 'skipped');
  });
  await t.test('после неоднозначного ответа комментарий не повторяется', async () => {
    await add(3); let attempts = 0, sentText;
    await db.query(`UPDATE lost_deal_analyses SET ai_judge_json=jsonb_set(ai_judge_json, '{final_comment}', $1::jsonb) WHERE id=3`, [JSON.stringify('конфиденциальный тестовый комментарий')]);
    const d = createDelivery(pool, { async request(method, body) { attempts++; sentText = body.fields.COMMENT; throw new Error('timeout секретный-тестовый-токен'); } });
    assert.deepEqual(await d.deliver(jobId(3), lease), { state: 'unknown', action: 'comment' });
    await assert.rejects(d.deliver(jobId(3), lease), /аренда/);
    assert.equal(attempts, 1); assert.equal((await row(3)).comment_state, 'unknown');
    assert.equal((await row(3)).status, 'needs_review');
    const saved = (await db.query('SELECT row_to_json(j) AS job FROM lost_processing_jobs j WHERE id=$1', [jobId(3)])).rows[0].job;
    assert.equal(saved.comment_sha256, createHash('sha256').update(sentText, 'utf8').digest('hex'));
    assert.ok(saved.comment_attempted_at);
    assert.doesNotMatch(JSON.stringify(saved), /конфиденциальный тестовый комментарий|секретный-тестовый-токен/);
  });
  await t.test('потеря процесса после sending требует сверки', async () => {
    await add(4, { state: 'sending' }); const before = events.length;
    assert.equal((await delivery.deliver(jobId(4), lease)).state, 'unknown');
    assert.equal(events.length, before); assert.equal((await row(4)).comment_state, 'unknown');
  });
  await t.test('совпадающий прежний вердикт suppress повторных уведомлений', async () => {
    await add(5, { deal: 1 }); const before = events.length;
    assert.equal((await delivery.deliver(jobId(5), lease)).state, 'done');
    assert.deepEqual(events.slice(before).map(e => e.method), ['crm.timeline.comment.add']);
    assert.equal((await row(5)).notify_state, 'skipped');
  });
  await t.test('одна подтверждённая доставка достаточна, остальные не повторяются', async () => {
    await add(6); let sends = 0;
    const d = createDelivery(pool, { async request(method) { if (method === 'crm.timeline.comment.add') return { result: 10 }; sends++; if (sends > 1) throw new Error('timeout'); return { result: 10 }; } });
    assert.equal((await d.deliver(jobId(6), lease)).state, 'done');
    assert.equal(sends, 3); assert.equal((await row(6)).notify_state, 'ok');
  });
  await t.test('все неоднозначные уведомления не повторяются', async () => {
    await add(7); let sends = 0;
    const d = createDelivery(pool, { async request(method) { if (method === 'crm.timeline.comment.add') return { result: 10 }; sends++; throw new Error('timeout'); } });
    assert.equal((await d.deliver(jobId(7), lease)).state, 'unknown');
    await assert.rejects(d.deliver(jobId(7), lease), /аренда/);
    assert.equal(sends, 3);
    assert.equal((await row(7)).status, 'needs_review');
  });
  await t.test('утеряв аренду, обработчик не отправляет следующим получателям', async () => {
    await add(8); let sends = 0;
    const d = createDelivery(pool, { async request(method) {
      if (method === 'crm.timeline.comment.add') return { result: 10 };
      sends++;
      await db.query("UPDATE lost_processing_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [jobId(8)]);
      return { result: 10 };
    } });
    await assert.rejects(d.deliver(jobId(8), lease), /аренда/);
    assert.equal(sends, 1);
    assert.equal((await row(8)).notify_state, 'sending');
  });
  await t.test('потеря ответа COMMIT не запускает сетевой вызов', async () => {
    await add(9); let failCommit = true, sends = 0;
    let releasedWithError = false;
    const flaky = { async connect() { return { async query(sql, args) {
      const result = await db.query(sql, args);
      if (sql === 'COMMIT' && failCommit) { failCommit = false; throw new Error('потерян ответ'); }
      return result;
    }, release(error) { if (error) releasedWithError = true; } }; } };
    const d = createDelivery(flaky, { async request() { sends++; return { result: 10 }; } });
    await assert.rejects(d.deliver(jobId(9), lease), /DELIVERY_COMMIT_OUTCOME_UNKNOWN/);
    assert.equal(releasedWithError, true);
    assert.equal(sends, 0);
    assert.equal((await d.deliver(jobId(9), lease)).state, 'unknown');
    assert.equal(sends, 0);
  });
  await t.test('после первого подтверждения продолжает отправку тем, кому ещё не начинал', async () => {
    await add(10); let sends = 0, checks = 0;
    const flaky = { async connect() { return { async query(sql, args) {
      if (String(sql).includes("notify_state='sending'") && String(sql).includes('SELECT id FROM') && ++checks === 2) throw new Error('процесс остановился');
      return db.query(sql, args);
    }, release() {} }; } };
    const d = createDelivery(flaky, { async request(method) {
      if (method === 'crm.timeline.comment.add') return { result: 10 };
      sends++; return { result: 10 };
    } });
    await assert.rejects(d.deliver(jobId(10), lease), /остановился/);
    assert.equal(sends, 1);
    const saved = (await db.query("SELECT ai_judge_json->'notification' AS n FROM lost_deal_analyses WHERE id=10")).rows[0].n;
    assert.deepEqual(saved.delivered, [65]);
    assert.equal(saved.status, 'sending');
    assert.deepEqual(saved.recipient_states, { 65: 'ok', 26175: 'pending', 19601: 'pending' });
    assert.equal((await d.deliver(jobId(10), lease)).state, 'done');
    assert.equal(sends, 3);
    const after = (await db.query("SELECT ai_judge_json->'notification' AS n FROM lost_deal_analyses WHERE id=10")).rows[0].n;
    assert.equal(after.status, 'ok'); assert.deepEqual(after.delivered, [65, 26175, 19601]);
  });
  await t.test('ошибка отката исключает соединение из пула', async () => {
    let released;
    const flaky = { async connect() { return { async query(sql, args) {
      if (sql === 'ROLLBACK') { await db.query(sql, args); throw new Error('откат без подтверждения'); }
      return db.query(sql, args);
    }, release(error) { released = error; } }; } };
    const d = createDelivery(flaky, client);
    await assert.rejects(d.deliver(jobId(99), lease), /аренда/);
    assert.ok(released instanceof Error);
  });
  await t.test('неподтверждённый вызов не повторяется, прочие получатели обрабатываются', async () => {
    await add(11); let fail = false, sends = 0;
    const flaky = { async connect() { return { async query(sql, args) {
      if (fail && String(sql).includes('SELECT j.*')) { fail = false; throw new Error('БД недоступна'); }
      return db.query(sql, args);
    }, release() {} }; } };
    const d = createDelivery(flaky, { async request(method) {
      if (method === 'crm.timeline.comment.add') return { result: 10 };
      sends++; fail = true; return { result: 10 };
    } });
    await assert.rejects(d.deliver(jobId(11), lease), /БД недоступна/);
    assert.equal(sends, 1);
    const continued = createDelivery(pool, { async request(method) { assert.equal(method, 'im.notify.system.add'); sends++; return { result: 10 }; } });
    assert.equal((await continued.deliver(jobId(11), lease)).state, 'done');
    assert.equal((await row(11)).status, 'done');
    assert.equal(sends, 3);
    const notification = (await db.query("SELECT ai_judge_json->'notification' AS n FROM lost_deal_analyses WHERE id=11")).rows[0].n;
    assert.deepEqual(notification.delivered, [26175, 19601]);
    assert.equal(notification.recipient_states['65'], 'unknown');
    const queue = createJobQueue(db);
    await queue.recoverExpired();
    assert.equal((await row(7)).status, 'needs_review');
  });
  for (const [n, state, method, action] of [
    [12, 'pending', 'crm.timeline.comment.add', 'comment'],
    [13, 'ok', 'im.notify.system.add', 'notification'],
  ]) {
    await t.test(`аренда потеряна в очереди: ${action} не уходит в Битрикс`, async () => {
      await add(n, { state });
      let release, ready, queued;
      const held = new Promise(resolve => { release = resolve; });
      const waiting = new Promise(resolve => { queued = resolve; });
      const started = new Promise(resolve => { ready = resolve; });
      const limiter = createBitrixLimiter({ intervalMs: 1, maxWaitMs: 5000 });
      const schedule = limiter.schedule.bind(limiter);
      const blocker = schedule('blocker', async () => { ready(); await held; });
      await started;
      limiter.schedule = (name, task, options) => {
        const result = schedule(name, task, options);
        if (name === method) queued();
        return result;
      };
      let sends = 0;
      const client = createBitrixClient({ baseUrl: 'https://example.invalid/rest/1/token/', limiter,
        fetchImpl: async () => { sends++; return { ok: true, json: async () => ({ result: 1 }) }; } });
      const delivery = createDelivery(pool, client);
      const work = delivery.deliver(jobId(n), lease);
      await waiting;
      await db.query("UPDATE lost_processing_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [jobId(n)]);
      release();
      await blocker;
      assert.deepEqual(await work, { state: 'unknown', action });
      assert.equal(sends, 0);
      limiter.close();
    });
  }
  for (const [n, state, action] of [[14, 'pending', 'comment'], [15, 'ok', 'notification']]) {
    await t.test(`недоступная проверка ${action} запрещает вызов и переводит задание на сверку`, async () => {
      await add(n, { state });
      const failingPool = { async connect() { return { async query(sql, args) {
        if (String(sql).includes(action === 'comment' ? "AND comment_state='sending'" : 'SELECT j.id FROM public.lost_processing_jobs j')) throw new Error('секретный тест');
        return db.query(sql, args);
      }, release() {} }; } };
      let sends = 0;
      const limiter = createBitrixLimiter({ intervalMs: 1 });
      const client = createBitrixClient({ baseUrl: 'https://example.invalid/rest/1/token/', limiter,
        fetchImpl: async () => { sends++; return { ok: true, json: async () => ({ result: 1 }) }; } });
      assert.deepEqual(await createDelivery(failingPool, client).deliver(jobId(n), lease), { state: 'unknown', action });
      assert.equal(sends, 0);
      assert.equal((await row(n)).status, 'needs_review');
      limiter.close();
    });
  }
  await t.test('проверки действующей аренды разрешают полный цикл через настоящий клиент', async () => {
    await add(16);
    let sends = 0;
    const limiter = createBitrixLimiter({ intervalMs: 1 });
    const client = createBitrixClient({ baseUrl: 'https://example.invalid/rest/1/token/', limiter,
      fetchImpl: async () => { sends++; return { ok: true, json: async () => ({ result: sends }) }; } });
    assert.deepEqual(await createDelivery(pool, client).deliver(jobId(16), lease), { state: 'done' });
    assert.equal(sends, 4);
    limiter.close();
  });
  await t.test('после доставки первому таймаут очереди второго сохраняет ok и не мешает третьему', async () => {
    await add(17, { state: 'ok' });
    let release, blocker, notificationCalls = 0;
    const held = new Promise(resolve => { release = resolve; });
    const limiter = createBitrixLimiter({ intervalMs: 1, maxWaitMs: 80 });
    const schedule = limiter.schedule.bind(limiter);
    limiter.schedule = (method, task, options) => {
      if (method === 'im.notify.system.add' && ++notificationCalls === 2) {
        blocker = schedule('blocker', () => held);
        return schedule(method, task, options).catch(error => { release(); throw error; });
      }
      return schedule(method, task, options);
    };
    const sent = [];
    const client = createBitrixClient({ baseUrl: 'https://example.invalid/rest/1/token/', limiter,
      fetchImpl: async (_url, options) => {
        sent.push(JSON.parse(options.body).USER_ID);
        return { ok: true, json: async () => ({ result: 10 }) };
      } });
    assert.deepEqual(await createDelivery(pool, client).deliver(jobId(17), lease), { state: 'done' });
    await blocker;
    assert.deepEqual(sent, [65, 19601]);
    const notification = (await db.query("SELECT ai_judge_json->'notification' AS n FROM lost_deal_analyses WHERE id=17")).rows[0].n;
    assert.equal(notification.status, 'ok');
    assert.deepEqual(notification.delivered, [65, 19601]);
    assert.deepEqual(notification.recipient_states, { 65: 'ok', 26175: 'unknown', 19601: 'ok' });
    assert.deepEqual(notification.failed, [{ user_id: 26175, error: 'запрос не был отправлен' }]);
    assert.equal((await row(17)).notify_state, 'ok');
    limiter.close();
  });
  await t.test('потеря аренды в очереди второго сохраняет подтверждение первого и pending третьего', async () => {
    await add(18, { state: 'ok' });
    let release, queued, blocker, notificationCalls = 0;
    const held = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { queued = resolve; });
    const limiter = createBitrixLimiter({ intervalMs: 1, maxWaitMs: 5000 });
    const schedule = limiter.schedule.bind(limiter);
    limiter.schedule = (method, task, options) => {
      if (method === 'im.notify.system.add' && ++notificationCalls === 2) {
        blocker = schedule('blocker', () => held);
        const result = schedule(method, task, options);
        queued();
        return result;
      }
      return schedule(method, task, options);
    };
    const sent = [];
    const client = createBitrixClient({ baseUrl: 'https://example.invalid/rest/1/token/', limiter,
      fetchImpl: async (_url, options) => {
        sent.push(JSON.parse(options.body).USER_ID);
        return { ok: true, json: async () => ({ result: 10 }) };
      } });
    const work = createDelivery(pool, client).deliver(jobId(18), lease);
    await waiting;
    await db.query("UPDATE lost_processing_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [jobId(18)]);
    release();
    await blocker;
    assert.deepEqual(await work, { state: 'unknown', action: 'notification' });
    assert.deepEqual(sent, [65]);
    const notification = (await db.query("SELECT ai_judge_json->'notification' AS n FROM lost_deal_analyses WHERE id=18")).rows[0].n;
    assert.deepEqual(notification.delivered, [65]);
    assert.deepEqual(notification.recipient_states, { 65: 'ok', 26175: 'sending', 19601: 'pending' });
    limiter.close();
  });
  await t.test('пилот доставляет все вердикты только 65 и не пишет комментарий', async () => {
    const sent=[];
    const pilot=createDelivery(pool,{async request(method, body, options){
      assert.equal(method,'im.notify.system.add');
      assert.equal(body.USER_ID,65);assert.equal(await options.beforeSend(),true);
      sent.push(body);return {result:42};
    }},{mode:'pilot65'});
    for (const [n,verdict] of [[21,'правомерен'],[22,'неправомерен'],[23,'недостаточно_данных']]) {
      await add(n,{verdict,closure:'other'});
      if(n===21)await db.query("UPDATE lost_deal_analyses SET ai_judge_json=jsonb_set(ai_judge_json,'{transcription_coverage}',$1::jsonb) WHERE id=21",[JSON.stringify({unrecognized_fragments:2,calls_with_unknown_coverage:0})]);
      assert.deepEqual(await pilot.deliver(jobId(n),lease),{state:'done'});
      assert.equal((await row(n)).comment_state,'skipped');
      const q=await db.query("SELECT ai_judge_json->'pilot_notification' AS pilot,ai_judge_json->'notification' AS production FROM lost_deal_analyses WHERE id=$1",[n]);
      assert.deepEqual(q.rows[0].pilot.delivered,[65]);assert.equal(q.rows[0].production,null);
    }
    assert.equal(sent.length,3);
    assert.match(sent[0].MESSAGE,/правомерен/);assert.match(sent[0].MESSAGE,/не распознано фрагментов — 2/);assert.match(sent[2].MESSAGE,/недостаточно_данных/);
    await add(24,{silent:true});assert.deepEqual(await pilot.deliver(jobId(24),lease),{state:'done'});assert.equal(sent.length,3);
  });
  await t.test('ошибка пилота отправляется только 65 без вердикта или комментария', async () => {
    await add(25);await db.query("UPDATE lost_deal_analyses SET pipeline_error=$1,ai_judge_json=NULL,ai_verdict=NULL WHERE id=25",['технический сбой распознавания']);
    const sent=[];const pilot=createDelivery(pool,{async request(method,body,options){
      assert.equal(method,'im.notify.system.add');assert.equal(body.USER_ID,65);assert.equal(await options.beforeSend(),true);
      sent.push(body);return {result:42};
    }},{mode:'pilot65'});
    assert.deepEqual(await pilot.deliver(jobId(25),lease),{state:'done'});
    assert.equal(sent.length,1);assert.match(sent[0].MESSAGE,/разбор не завершён/);assert.match(sent[0].MESSAGE,/Вердикт не вынесен/);
    assert.deepEqual(await row(25),{status:'done',comment_state:'skipped',comment_id:null,notify_state:'ok'});
    const a=(await db.query("select pipeline_error,ai_judge_json->'pilot_notification' as notification from lost_deal_analyses where id=25")).rows[0];
    assert.equal(a.pipeline_error,'технический сбой распознавания');assert.deepEqual(a.notification.delivered,[65]);
    await add(26,{deal:25});await db.query("UPDATE lost_processing_jobs SET lose_date=(SELECT lose_date FROM lost_processing_jobs WHERE id=$1) WHERE id=$2",[jobId(25),jobId(26)]);
    await db.query("UPDATE lost_deal_analyses SET pipeline_error='повторная ошибка',ai_judge_json=NULL,ai_verdict=NULL WHERE id=26");
    assert.deepEqual(await pilot.deliver(jobId(26),lease),{state:'done'});assert.equal(sent.length,1);
    assert.equal((await row(26)).notify_state,'skipped');
  });
});
