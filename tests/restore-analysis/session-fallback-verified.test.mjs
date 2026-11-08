import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCommunications } from '../../app/src/collect/normalize.mjs';
import { inferChatRoles } from '../../app/src/analysis/chat-role-inference.mjs';
import { communicationRow } from '../../app/src/persistence/rows.mjs';

const cutoff = '2026-11-05T00:00:00Z';
function sample({connector = 'wz_test', chat = 12, session = 34, messageId = 50} = {}) {
  return { _status: 'pending_normalization', deal_id: '123', silent: true, deal_data: { lose_date: cutoff },
    _sources: Object.fromEntries(['calls', 'openlines', 'comments', 'tasks'].map(x => [x, { complete: true }])),
    raw: { calls: [], comments: [], tasks: [], chats: [{ CHAT_ID: chat, CONNECTOR_ID: connector }],
      sessions: [{ chat_id: chat, history: { chatId: chat, sessionId: session,
        chat: { [chat]: { entityId: `wz_test|9|client|external` } }, users: {}, files: {},
        message: { [messageId]: { id: messageId, text: 'Есть ли у вас двери?', date: '2026-11-04T00:00:00Z' } } } }] } };
}
function proof(input, changes = {}) {
  return { kind: 'verified_fallback_session_v1', ...input, history: undefined,
    session_created_at: '2026-11-01T00:00:00Z',
    checks: { chat_bound_to_deal: true, session_matches_chat: true, session_matches_line: true,
      session_crm_matches_deal: true, direct_session_history_matches: true, current_chat_history_matches: true }, ...changes };
}
async function normalize(collection, verifyFallbackSession) {
  return (await normalizeCommunications({ collection, verifyFallbackSession })).deal_data.communications;
}
function client(calls) { return { async complete(body) {
  calls.push(body);
  const messages = JSON.parse(body.messages[1].content).messages;
  return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ roles: messages.map(m =>
    ({ id: m.id, role: 'client', impact: 'not_applicable' })) }) } }] };
} }; }
async function infer(communications, options = {}) {
  const calls = [];
  const result = await inferChatRoles({ communications, dealId: '123', cutoff, client: client(calls), ...options });
  return { ...result, calls };
}

test('неподтверждённая сессия блокируется; подтверждение не меняет legacy ID и event_id', async () => {
  const collection = sample();
  const legacy = await normalize(collection);
  assert.equal((await infer(legacy)).calls.length, 0);
  const verified = await normalize(collection, async input => proof(input));
  assert.equal(verified[0].inference_session_id, '34');
  assert.equal(verified[0].session_id, legacy[0].session_id);
  assert.equal(verified[0].message_id, legacy[0].message_id);
  assert.equal(communicationRow('123', verified[0], 0).event_id, communicationRow('123', legacy[0], 0).event_id);
  const result = await infer(verified);
  assert.equal(result.calls.length, 1);
  assert.equal(result.communications[0].role, 'Клиент');
  assert.equal(result.communications[0].message_id, 'chat_12_50');
});

test('только silent и явный callback; boolean, ошибочные или неполные подтверждения не работают', async () => {
  for (const callback of [async () => true, async () => null, async () => { throw Error('failure'); },
    async i => proof(i, { deal_id: '124' }), async i => proof(i, { chat_id: '13' }),
    async i => proof(i, { session_id: '35' }), async i => proof(i, { line_id: '10' }),
    async i => proof(i, { cutoff: '2026-11-06T00:00:00Z' }), async i => proof(i, { history_sha256: '0'.repeat(64) }),
    async i => proof(i, { session_created_at: '2026-11-06T00:00:00Z' }),
    async i => proof(i, { checks: { chat_bound_to_deal: true } })]) {
    const messages = await normalize(sample(), callback);
    assert.equal(messages[0].inference_session_id, undefined);
    assert.equal((await infer(messages)).calls.length, 0);
  }
  let invoked = false; const c = sample(); c.silent = false;
  await normalize(c, async i => { invoked = true; return proof(i); });
  assert.equal(invoked, false);
});

test('дата, привязки, изменение снимка и подмена события не дают использовать подтверждение', async () => {
  for (const change of [c => c.raw.sessions[0].history.chatId = 13,
    c => c.raw.sessions[0].history.sessionId = 0,
    c => c.raw.sessions[0].history.chat[12].entityId = 'invalid',
    c => c.deal_data.lose_date = '2026-11-05', c => c.raw.chats.push({...c.raw.chats[0]})]) {
    const c = sample(); change(c); let calls = 0;
    const messages = await normalize(c, async i => { calls++; return proof(i); });
    assert.equal(calls, 0); assert.equal((await infer(messages)).calls.length, 0);
  }
  const c = sample();
  const stale = await normalize(c, async i => { c.raw.sessions[0].history.message[50].text = 'изменённый текст'; return proof(i); });
  assert.equal((await infer(stale)).calls.length, 0);
  const d = sample(), verified = await normalize(d, async i => proof(i));
  assert.equal((await infer(verified, { dealId: '124' })).calls.length, 0);
  assert.equal((await infer(verified, { cutoff: '2026-11-06T00:00:00Z' })).calls.length, 0);
  assert.equal((await infer(structuredClone(verified))).calls.length, 0);
  verified[0].text = 'другая реплика';
  assert.equal((await infer(verified)).calls.length, 0);
  const e = sample(), original = await normalize(e, async i => proof(i));
  e.raw.sessions[0].history.message[50].text = 'изменено после нормализации';
  assert.equal((await infer(original)).calls.length, 0);
});

test('разные сессии не объединяются; Wappi и вложения не обрабатываются классификатором', async () => {
  const c = sample(); const other = sample({chat: 13, session: 35, messageId: 51});
  c.raw.chats.push(...other.raw.chats); c.raw.sessions.push(...other.raw.sessions);
  const messages = await normalize(c, async i => proof(i));
  const result = await infer(messages);
  assert.equal(result.calls.length, 2);
  assert.ok(result.calls.every(call => JSON.parse(call.messages[1].content).messages.length === 1));
  let checks = 0; const wappi = await normalize(sample({connector: 'wappi'}), async i => { checks++; return proof(i); });
  assert.equal(checks, 0); assert.equal(wappi[0].inference_session_id, undefined);
  const voice = sample(); voice.raw.sessions[0].history.message[50].params = { FILE_ID: [77] };
  voice.raw.sessions[0].history.files = { 77: { id: 77, name: 'voice.ogg', type: 'audio' } };
  voice.raw.sessions[0].history.message[51] = { id: 51, text: 'Текст рядом с голосовым', date: '2026-11-04T00:01:00Z' };
  const v = await normalize(voice, async i => proof(i));
  assert.equal((await infer(v)).calls.length, 0);
  const orphan = sample();
  orphan.raw.sessions[0].history.files = { 77: { id: 77, name: 'voice.ogg', type: 'audio', date: '2026-11-04T00:01:00Z' } };
  const withOrphan = await normalize(orphan, async i => proof(i));
  assert.equal(withOrphan.length, 2);
  assert.equal((await infer(withOrphan)).calls.length, 0);
});
