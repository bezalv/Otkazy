import assert from 'node:assert/strict';
import { pgDecide, pgInitMarks, pgMarkComplete } from '../../app/src/rules/pipeline-gate.mjs';
import { dsEvaluate, dsInsufficientJudge } from '../../app/src/rules/data-sufficiency.mjs';

const sources = pgInitMarks();
assert.equal(pgDecide({ sources }).block, true);
for (const key of Object.keys(sources)) pgMarkComplete(sources, key, 1);
assert.equal(pgDecide({ sources }).block, false);
assert.equal(pgDecide({ sources, recognition: { calls: [{ technical_failure: true, retryable: false, error: 'bad_audio' }] } }).block, true);
assert.equal(pgDecide({ sources, recognition: { voices: [{ unsupported: true, technical_failure: true }] } }).block, false);
const insufficient = dsEvaluate([]);
assert.equal(insufficient.enough, false);
assert.equal(dsInsufficientJudge(insufficient).verdict, 'недостаточно_данных');
console.log('Правила полноты и достаточности проверены');
