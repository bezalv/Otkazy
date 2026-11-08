import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pgDecide, pgInitMarks, pgMarkComplete } from '../../app/src/rules/pipeline-gate.mjs';
import { dsEvaluate } from '../../app/src/rules/data-sufficiency.mjs';
import { trustNeutralReaction } from '../../app/src/analysis/chat-role-trust.mjs';

function marks() {
  const sources = pgInitMarks();
  for (const key of Object.keys(sources)) pgMarkComplete(sources, key, 1);
  return sources;
}
const neutral = () => ({ type: 'chat', connector_id: 'wazzup', role: 'unknown', direction: 'unknown',
  text: '👍', _wazzup_author_ambiguous: true, _unknown_role_nonmaterial: 'semantic_inference' });

test('разрешение неопределённого автора доступно только в явном эксперименте', () => {
  const communications = [trustNeutralReaction(neutral()), trustNeutralReaction({ ...neutral(), text: 'Спасибо!' })];
  assert.equal(pgDecide({ sources: marks(), communications }).kind, 'author_ambiguous');
  assert.equal(pgDecide({ sources: marks(), communications, allowNonmaterialUnknown: true }).block, false);
  const cloned = JSON.parse(JSON.stringify(communications));
  assert.equal(pgDecide({ sources: marks(), communications: cloned, allowNonmaterialUnknown: true }).kind, 'author_ambiguous');
});

test('маркер не ослабляет защиту для содержательных или неверных записей', () => {
  const variants = [
    { text: 'да' }, { text: '👍 согласен' }, { text: '👎' }, { text: '' },
    { _unknown_role_nonmaterial: 'unknown' }, { _unknown_role_nonmaterial: null },
    { _chat_connector_unknown: true }, { connector_id: 'wappi' }, { role: 'Клиент' },
    { direction: 'incoming' }, { type: 'call' }, { _has_files: true },
    { _has_audio: true }, { _has_audio_transcript: true }, { transcript: 'распознано' },
    { file_id: '7' }, { files: [] },
  ];
  for (const changes of variants) {
    const item = trustNeutralReaction({ ...neutral(), ...changes });
    assert.equal(pgDecide({ sources: marks(), communications: [item], allowNonmaterialUnknown: true }).block, true, JSON.stringify(changes));
  }
});

test('разрешённая реплика не отменяет неполные источники, сбой распознавания или неизвестный коннектор', () => {
  assert.equal(pgDecide({ sources: pgInitMarks(), communications: [trustNeutralReaction(neutral())], allowNonmaterialUnknown: true }).kind, 'collect');
  assert.equal(pgDecide({ sources: marks(), communications: [trustNeutralReaction(neutral())], allowNonmaterialUnknown: true,
    recognition: { calls: [{ technical_failure: true, error: 'error' }] } }).kind, 'recognition');
  assert.equal(pgDecide({ sources: marks(), communications: [trustNeutralReaction(neutral()), { _chat_connector_unknown: true }],
    allowNonmaterialUnknown: true }).kind, 'chat_connector_unknown');
});

test('неизвестная реакция не становится содержательной репликой клиента', () => {
  const facts = [{ source: 'chat', actor: 'unknown', content: '👍', unknown_role_nonmaterial: 'semantic_inference' }];
  assert.equal(dsEvaluate(facts).enough, false);
  assert.equal(dsEvaluate([...facts, { source: 'chat', actor: 'client', content: 'Спасибо, мы уже заказали окна у другого поставщика' }]).enough, true);
});
