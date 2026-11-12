import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createJobQueue } from '../../app/src/queue/index.mjs';

const packagePath = resolve('tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js');
const migrationPath = resolve('db/proposals/worker-migration-fixtures/20261105052525_lost_processing_jobs.sql');

test('миграция и очередь на локальном движке PostgreSQL', { skip: !existsSync(packagePath) }, async t => {
  const { PGlite } = await import(pathToFileURL(packagePath).href);
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('create role anon; create role authenticated; create table public.lost_deal_analyses (id bigint primary key);');
  await db.exec(readFileSync(migrationPath, 'utf8'));
  const queue = createJobQueue(db);
  const request = { requestKey: 'bitrix24:deal-stage-history:1', dealId: 42, loseDate: '2026-11-01T00:00:00Z', triggerType: 'live' };
  const first = await queue.enqueue(request);
  assert.equal(first.created, true);
  assert.equal((await queue.enqueue(request)).created, false);
  await queue.enqueue({ ...request, requestKey: 'bitrix24:deal-stage-history:2' });
  const claimed = await queue.claim();
  assert.equal(claimed.status, 'processing');
  assert.equal(Number(claimed.deal_id), 42);
  assert.equal(await queue.claim(), null);
  assert.equal(await queue.renew(claimed.id, claimed.lease_token), true);

  await db.query("update public.lost_processing_jobs set lease_until = now() - interval '1 second' where id = $1", [claimed.id]);
  assert.equal(await queue.renew(claimed.id, claimed.lease_token), false);
  assert.equal(await queue.recoverExpired(), 1);
  const recovered = await queue.claim();
  assert.equal(recovered.id, claimed.id);
  assert.notEqual(recovered.lease_token, claimed.lease_token);
  assert.equal(await queue.renew(claimed.id, claimed.lease_token), false);

  await db.query("update public.lost_processing_jobs set status='needs_review', lease_token=null, lease_until=null where id=$1", [recovered.id]);
  assert.equal(await queue.claim(), null, 'нельзя повторно разбирать сделку до сверки доставки');
  await queue.enqueue({ ...request, dealId: 43, requestKey: 'bitrix24:deal-stage-history:3' });
  assert.equal(Number((await queue.claim()).deal_id), 43, 'другая сделка не блокируется');

  await db.query("insert into public.lost_deal_analyses (id, pipeline_operation_id) values (1, $1)", [claimed.id]);
  await assert.rejects(db.query("insert into public.lost_deal_analyses (id, pipeline_operation_id) values (2, $1)", [claimed.id]), { code: '23505' });
});

test('пилот не захватывает старые и ручные задания', {skip:!existsSync(packagePath)}, async t=>{
  const {PGlite}=await import(pathToFileURL(packagePath).href);const db=new PGlite();t.after(()=>db.close());
  await db.exec('create role anon; create role authenticated; create table public.lost_deal_analyses (id bigint primary key);');
  await db.exec(readFileSync(migrationPath,'utf8'));const ordinary=createJobQueue(db);
  await ordinary.enqueue({requestKey:'bitrix24:deal-stage-history:101',dealId:101,loseDate:'2026-11-10T00:00:00.000Z',triggerType:'live'});
  await ordinary.enqueue({requestKey:'manual:102',dealId:102,loseDate:'2026-11-12T01:00:00.000Z',triggerType:'manual'});
  await ordinary.enqueue({requestKey:'bitrix24:deal-stage-history:103',dealId:103,loseDate:'2026-11-12T01:00:00.000Z',triggerType:'live'});
  const pilot=createJobQueue(db,{pilotEnabledAt:'2026-11-12T00:00:00.000Z'});
  assert.equal(Number((await pilot.claim()).deal_id),103);assert.equal(await pilot.claim(),null);
});
