import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildBitrixComment } from '../../app/src/delivery/comment.mjs';

test('формат комментария совпадает с нодой n8n для разных вердиктов', async () => {
  // Исходник в локальном бэкапе: если его нет, остаются автономные проверки ниже.
  let source;
  try { source = await readFile(new URL('../../tmp/backup/BhPWB9S6W5dlMUvV/собрать-ai-комментарий-2026-10-19.js', import.meta.url), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  const now = Date.parse('2026-11-05T18:05:00Z');
  for (const ma of [
    { verdict: 'неправомерен', closure_reason_class: 'price', final_comment: ' Результат ', recoverable_level: 'высокий', misplaced: true, correct_stage: 'Другая', judge_model: 'sol', writer_model: 'writer', judge_usage: { total_tokens: 2400 } },
    { verdict: 'правомерен', exact_reason: 'Причина' },
    { verdict: 'недостаточно_данных' },
  ]) {
    const result = { deal_id: 123, prompt_version: 'v2.8-sol', multi_agent_analysis: ma };
    class FixedDate extends Date { static now() { return now; } }
    const original = vm.runInNewContext(`(function(){ ${source} })()`, { $: () => ({ first: () => ({ json: result }) }), Date: FixedDate });
    assert.deepEqual(JSON.parse(JSON.stringify(original[0].json.b24_comment_body)), buildBitrixComment(result, now));
  }
});

test('время в карточке — Новосибирск и переход через сутки', () => {
  const body = buildBitrixComment({ deal_id: 42, multi_agent_analysis: {} }, Date.parse('2026-11-05T18:05:00Z'));
  assert.match(body.fields.COMMENT, /06\.11\.2026 01:05/);
  assert.throws(() => buildBitrixComment({ deal_id: 0 }), /deal_id/);
});
