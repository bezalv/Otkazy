import assert from 'node:assert/strict';
import test from 'node:test';

import { buildJournal } from '../../app/src/analysis/journal.mjs';
import { communicationRow } from '../../app/src/persistence/rows.mjs';

const inferred = {
  type: 'chat', message_id: '1_101', date: '2026-10-28T10:00:00Z', channel: 'Wazzup',
  role: 'Клиент', direction: 'incoming', author_id: 12345, author_name: 'Клиент',
  text: 'Нам не надо менять окно', _role_source: 'semantic_inference',
};

test('плоская таблица не превращает предположительную роль сообщения в подтверждённую', () => {
  const row = communicationRow(10, inferred, 0);
  assert.equal(row.event_type, 'chat');
  assert.equal(row.direction, 'unknown');
  // ID источника остаётся для трассировки, но не назначает участника стороной.
  assert.equal(row.author_id, inferred.author_id);
  assert.equal(row.author_name, 'Участник чата');
  assert.equal(row.text_content, inferred.text);
  assert.equal(inferred.direction, 'incoming');
  assert.equal(inferred.author_id, 12345);
});

test('в журнале и полном тексте промпта роль явно отмечена как оценка по контексту', () => {
  const result = buildJournal({ deal_id: 10, communications: [inferred] });
  assert.match(result.journal_text, /Клиент: Клиент, предположительно, по контексту/);
  assert.match(result.full_prompt_text, /Клиент: Клиент, предположительно, по контексту/);
  assert.match(result.journal_text, /Нам не надо менять окно/);
});

test('обычный текст, голосовые, вложения и звонки сохраняют существующие поля и журнал', () => {
  const ordinary = { ...inferred, message_id: '1_102', _role_source: undefined };
  for (const record of [ordinary,
    { ...inferred, message_id: '1_103', _has_audio: true },
    { ...inferred, message_id: '1_104', _has_files: true },
    { ...inferred, message_id: '1_105', _has_audio_transcript: true },
    { ...inferred, message_id: '1_106', transcript: 'Говорящий: Добрый день' },
    { ...inferred, type: 'call', activity_id: '107' },
  ]) {
    const row = communicationRow(10, record, 0);
    assert.equal(row.direction, record.direction);
    assert.equal(row.author_id, record.author_id);
    assert.equal(row.author_name, record.author_name);
    assert.doesNotMatch(buildJournal({ communications: [record] }).journal_text, /предположительно, по контексту/);
  }
});
