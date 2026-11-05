import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createLiveInbox } from '../../app/src/live/index.mjs';
import { createLiveHttpHandler } from '../../app/src/live/http.mjs';

const config = { applicationToken: 'test-token', domain: 'portal.example', memberId: 'm1', liveEnabledAt: '2026-11-01T00:00:00Z' };
const form = new URLSearchParams({ event: 'ONCRMDEALUPDATE', 'data[FIELDS][ID]': '42', 'auth[domain]': config.domain,
  'auth[member_id]': config.memberId, 'auth[application_token]': config.applicationToken }).toString();

async function start(t, inbox, options = {}) {
  const server = createServer(createLiveHttpHandler({ inbox, ...options }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('2xx появляется только после подтверждённой записи в БД', async t => {
  let release, inserted = false;
  const gate = new Promise(resolve => { release = resolve; });
  const inbox = createLiveInbox({ async query(sql) { if (sql.startsWith('SELECT enabled_at')) return { rows: [{ matches: true }] }; await gate; inserted = true; return { rows: [] }; }, connect() {} }, config);
  const address = await start(t, inbox);
  let done = false;
  const request = fetch(address, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form }).then(response => { done = true; return response; });
  await delay(50);
  assert.equal(done, false);
  release();
  assert.equal((await request).status, 204);
  assert.equal(inserted, true);
});

test('неверный секрет и сбой БД не получают 2xx и не раскрывают текст ошибки', async t => {
  const inbox = createLiveInbox({ async query(sql) { if (sql.startsWith('SELECT enabled_at')) return { rows: [{ matches: true }] }; throw new Error('sensitive'); }, connect() {} }, config);
  const address = await start(t, inbox);
  const send = body => fetch(address, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  assert.equal((await send(form.replace('test-token', 'wrong'))).status, 403);
  const result = await send(form);
  assert.equal(result.status, 503);
  assert.equal(await result.text(), '');
});

test('проверяет метод, тип и размер тела до приёма события', async t => {
  let accepted = 0;
  const address = await start(t, { async acceptForm() { accepted++; return { status: 'accepted' }; } }, { maxBytes: 256 });
  assert.equal((await fetch(address)).status, 405);
  assert.equal((await fetch(address, { method: 'POST', body: form })).status, 415);
  assert.equal((await fetch(address, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x'.repeat(257) })).status, 413);
  assert.equal(accepted, 0);
});

test('абсолютный срок обрывает тело даже при постоянной отправке маленьких частей', async t => {
  let accepted = 0;
  const address = await start(t, { async acceptForm() { accepted++; return { status: 'accepted' }; } }, { bodyTimeoutMs: 200 });
  const result = new Promise((resolve, reject) => {
    const req = httpRequest(address, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.write('x');
    const timer = setInterval(() => { if (!req.destroyed) req.write('x'); }, 40);
    req.once('close', () => clearInterval(timer));
  });
  assert.equal(await result, 408);
  assert.equal(accepted, 0);
});
