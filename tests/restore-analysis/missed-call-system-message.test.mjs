import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCommunications } from '../../app/src/collect/normalize.mjs';
import { buildCommunicationAnalytics } from '../../app/src/analysis/communication-analytics.mjs';
import { assembleFacts } from '../../app/src/analysis/facts-assembler.mjs';

const notice = '[СИСТЕМНОЕ СООБЩЕНИЕ] - Пропущенный звонок';
const at = '2026-10-18T11:00:00Z';
const cutoff = '2026-10-19T10:00:00Z';
const normal = text => ({ type: 'chat', date: at, role: 'Клиент', direction: 'incoming', text });

async function normalize(connector, senderid, text, withFile = false) {
  const message = { id: 7, date: at, text, ...(senderid === undefined ? {} : { senderid }),
    ...(withFile ? { params: { FILE_ID: [101] } } : {}) };
  const collection = { deal_id: 42, silent: true, _status: 'pending_normalization',
    _sources: Object.fromEntries(['calls','openlines','comments','tasks'].map(key => [key,{complete:true}])),
    deal_data: { deal_id: 42 }, raw: { calls: [], comments: [], tasks: [],
      chats: [{ CHAT_ID: 2, CONNECTOR_ID: connector }], sessions: [{ session_id: 1, history: {
        chat: { 2: {} }, users: { 55: { connector: true } }, message: { 7: message },
        files: withFile ? { 101: { id: 101, name: 'image.png', type: 'image' } } : {},
      } }] } };
  return (await normalizeCommunications({ collection })).deal_data.communications;
}

for (const connector of ['wappi', 'wz_test']) {
  for (const sender of [0, 55, undefined]) {
    test(`${connector}: служебный маркер исключён при sender=${sender}`, async () => {
      assert.deepEqual(await normalize(connector, sender, notice), []);
    });
  }
  for (const sender of [0, 55, undefined]) {
    test(`${connector}: маркер с файлом сохраняется при sender=${sender}`, async () => {
      const events = await normalize(connector, sender, notice, true);
      assert.equal(events.length, 1);
      assert.equal(events[0]._has_files, true);
      const input = { lose_date: cutoff, communications: events };
      assert.equal(buildCommunicationAnalytics(input, new Date(cutoff)).comm_analytics.chats_total, 1);
      assert.equal(assembleFacts(input, 'Тест').facts_packet.facts.length, 1);
    });
  }
}

test('варианты пробелов и тире отсекаются на всех трёх этапах', async () => {
  const variant = '  [ Системное  сообщение ] —  Пропущенный  звонок  ';
  assert.deepEqual(await normalize('wappi', 55, variant), []);
  const input = { lose_date: cutoff, communications: [normal(variant)] };
  assert.equal(buildCommunicationAnalytics(input, new Date(cutoff)).comm_analytics.chats_total, 0);
  assert.equal(assembleFacts(input, 'Тест').facts_packet.facts.length, 0);
});

test('упоминание пропущенного звонка и цитата маркера внутри текста остаются', async () => {
  for (const text of ['У меня пропущенный звонок, кто звонил?', `Уведомление: ${notice}`]) {
    const events = await normalize('wappi', 55, text);
    assert.equal(events.length, 1);
    const input = { lose_date: cutoff, communications: events };
    assert.equal(buildCommunicationAnalytics(input, new Date(cutoff)).comm_analytics.chats_total, 1);
    assert.equal(assembleFacts(input, 'Тест').facts_packet.facts.length, 1);
  }
});

test('прямые формы файлов сохраняются на стадиях аналитики и фактов', () => {
  for (const extra of [{ files: [{ id: 101 }] }, { attachments: { 101: { id: 101 } } },
    { file_id: 101 }, { FILE_ID: [101] }, { params: { FILE_ID: [101] } }, { params: { fileId: 101 } }]) {
    const input = { lose_date: cutoff, communications: [{ ...normal(notice), ...extra }] };
    assert.equal(buildCommunicationAnalytics(input, new Date(cutoff)).comm_analytics.chats_total, 1);
    assert.equal(assembleFacts(input, 'Тест').facts_packet.facts.length, 1);
  }
});

test('пустые коллекции файлов не превращают системный маркер в сообщение', () => {
  const input = { lose_date: cutoff, communications: [{ ...normal(notice), files: [], attachments: {}, params: { FILE_ID: [] } }] };
  assert.equal(buildCommunicationAnalytics(input, new Date(cutoff)).comm_analytics.chats_total, 0);
  assert.equal(assembleFacts(input, 'Тест').facts_packet.facts.length, 0);
});
