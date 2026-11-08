import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runJob } from '../../app/src/worker/run-job.mjs';

const lose = '2026-11-04T00:00:00.000Z';
const job = { id: 'job', lease_token: 'lease', deal_id: 42, lose_date: lose,
  trigger_type: 'manual', request_key: 'manual:42:1', silent: true, screenshots: false };
const terminal = { state: 'cancelled', lose_date: lose, origin_stage_history_id: '101',
  first_seen_at: '2026-11-04T00:03:00.000Z', deadline_at: '2026-11-05T00:03:00.000Z',
  next_check_at: '2026-11-04T00:08:00.000Z', pending_calls: ['99'], observations: { 99: { activity_id: '99' } } };

function fixture(withAudio) {
  let sttCalls = 0;
  let stored;
  const bitrix = { async request(method, body) {
    if (method === 'crm.deal.userfield.list') return { result: [{ LIST: [{ ID: '1', VALUE: 'Другая' }] }] };
    if (method === 'crm.deal.get') return { result: { ID: '42', STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: '65', UF_CRM_1584703948317: '1' } };
    if (method === 'crm.stagehistory.list') return { result: { items: [{ ID: '101', STAGE_ID: 'C23:LOSE', CREATED_TIME: lose }] } };
    if (method === 'crm.activity.list' && body.filter.TYPE_ID) return { result: [{
      ID: '99', PROVIDER_ID: 'VOXIMPLANT_CALL', COMPLETED: 'Y', CREATED: '2026-11-04T00:01:00Z',
      START_TIME: '2026-11-04T00:01:00Z', END_TIME: '2026-11-04T00:02:00Z',
      FILES: withAudio ? [{ url: 'https://example.test/audio?fileId=99' }] : [],
    }] };
    if (method === 'crm.activity.list' && body.filter.PROVIDER_ID === 'IMOPENLINES_SESSION') return { result: [{ ASSOCIATED_ENTITY_ID: '80' }] };
    if (method === 'imopenlines.crm.chat.get') return { result: [{ CHAT_ID: 100, CONNECTOR_ID: 'wazzup' }] };
    if (method === 'imopenlines.session.history.get') return { result: {
      sessionId: 80, chatId: 100,
      chat: { 100: {} }, users: { 55: { connector: true } }, files: {},
      message: { 1: { id: 1, senderid: 55, text: '=== Исходящее сообщение ===\nХорошо' } },
    } };
    if (method === 'crm.activity.list' || method === 'crm.timeline.comment.list') return { result: [] };
    if (method === 'tasks.task.list') return { result: { tasks: [] } };
    throw new Error('Неожиданный метод');
  } };
  return { args: {
    job, queue: { async renew() { return true; } }, loadAudioWait: async () => structuredClone(terminal),
    store: { async loadResumableResult() { return null; }, async persistResult(result) { stored = result; return { status: result._status, needsExternalActions: false }; } },
    processOptions: { bitrix, nowMs: Date.parse('2026-11-05T00:00:00Z'), wait: async () => {},
      audioWaitEnabledAt: '2026-11-01T00:00:00Z', judgeSystemPrompt: 'Промпт судьи', writerSystemPrompt: 'Промпт писателя',
      llm: { async complete() { throw new Error('Модель не должна вызываться'); } },
      transcribe: async () => { sttCalls++; return { success: true, formatted_dialog: 'Менеджер: Алло', manager_text: 'Алло' }; },
    },
    delivery: async () => assert.fail('Тихий ручной тест не должен доставлять сообщения'),
  }, getStored: () => stored, getSttCalls: () => sttCalls };
}

test('ручной повтор после устранения неоднозначности требует актуальную запись и допускает анализ', async () => {
  const present = fixture(true);
  assert.equal((await runJob(present.args)).status, 'processed');
  assert.equal(present.getStored()._status, 'processed');
  assert.equal(present.getStored().audio_wait, null);
  assert.equal(present.getSttCalls(), 1);
  const missing = fixture(false);
  assert.equal((await runJob(missing.args)).status, 'skipped');
  assert.equal(missing.getSttCalls(), 0);
});
