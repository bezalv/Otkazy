import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFinalOutput } from '../../app/src/agents/final-output.mjs';
import { processedRows } from '../../app/src/persistence/rows.mjs';

test('неполнота распознавания сохраняется в JSON разбора без лишних данных', () => {
  const stats = { calls_with_unrecognized_fragments: 2, unrecognized_fragments: 6,
    calls_without_selected_fragments: 1, calls_with_unknown_coverage: 0,
    unexpected: 'не сохранять' };
  const input = { judge: { verdict: 'неправомерен', recoverable_level: null },
    transcription_stats: stats, facts_packet: { facts: [] } };
  const output = buildFinalOutput(input, {}, null);
  assert.deepEqual(output.multi_agent_analysis.transcription_coverage, {
    calls_with_unrecognized_fragments: 2, unrecognized_fragments: 6,
    calls_without_selected_fragments: 1, calls_with_unknown_coverage: 0,
  });
  const rows = processedRows(output, { ID: 42 }, []);
  assert.deepEqual(JSON.parse(rows.analysis.ai_judge_json).transcription_coverage,
    output.multi_agent_analysis.transcription_coverage);
});

test('некорректные счётчики не сохраняются как подтверждённые', () => {
  const output = buildFinalOutput({ judge: { verdict: 'неправомерен' },
    transcription_stats: { calls_with_unrecognized_fragments: -1 } }, {}, null);
  assert.equal(output.multi_agent_analysis.transcription_coverage, undefined);
});
