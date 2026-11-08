import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCommunications } from '../../app/src/collect/normalize.mjs';
import { pgDecide } from '../../app/src/rules/pipeline-gate.mjs';

const sources = Object.fromEntries(['calls', 'openlines', 'comments', 'tasks'].map(key => [key, { complete: true }]));
const collection = {
  _status: 'pending_normalization', _sources: sources, deal_id: 42,
  deal_data: { deal_id: 42, lose_date: '2026-11-04T02:00:00Z' },
  raw: { calls: [], comments: [], tasks: [], chats: [{ CHAT_ID: 25, CONNECTOR_ID: 'wz_example' }],
    sessions: [{ session_id: 99, chat_id: 25, history: {
      sessionId: 99, chatId: 25, chat: { 25: { entityId: 'wz_example|2|chat|user' } }, users: {},
      message: { 1: { id: 1, senderid: 0, text: '', date: '2026-11-04T01:00:00Z', params: { FILE_ID: [7] } } },
      files: { 7: { id: 7, type: 'audio', name: 'voice.ogg' } },
    } }] },
};
const phrase = 'Пожалуйста, подождите завершения обработки.';
async function normalize(response) {
  return normalizeCommunications({ collection: structuredClone(collection), screenshots: false,
    resolveFile: async () => ({ result: { NAME: 'voice.ogg', DOWNLOAD_URL: 'https://example.invalid/voice.ogg' } }),
    transcribeVoice: async () => response });
}

test('голосовое с одной фразой ожидания требует перепроверки, не считается речью или тишиной', async () => {
  for (const prefix of ['Участник чата', 'client']) {
    const out = await normalize({ success: true, formatted_dialog: `${prefix}: ${phrase}`,
      manager_text: '', client_text: '', conversation: [{ text: phrase }] });
    assert.equal(out.voice_failures.length, 1);
    assert.equal(out.voice_failures[0].retryable, true);
    assert.equal(pgDecide({ sources, recognition: { voices: out.voice_failures } }).block, true);
    assert.equal(out.deal_data.communications.find(x => x.type === 'chat')._has_audio_transcript, undefined);
  }
});

test('в голосовом фраза в составе осмысленного текста не отбрасывается', async () => {
  const text = `${phrase} Я пришлю документы завтра.`;
  const out = await normalize({ success: true, formatted_dialog: `Участник чата: ${text}`,
    manager_text: '', client_text: '', conversation: [{ text }] });
  assert.equal(out.voice_failures.length, 0);
  assert.equal(out.deal_data.communications.find(x => x.type === 'chat')._has_audio_transcript, true);
});
