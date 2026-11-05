import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processScreenshots } from '../../app/src/screenshots/process.mjs';
import { pgDecide, pgInitMarks, pgMarkComplete } from '../../app/src/rules/pipeline-gate.mjs';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
const base = { communications: [1, 2, 3].map(id => ({
  type: 'comment', comment_id: id, screenshots: [{ file_id: id, date: '2026-01-01T00:00:00Z' }],
})) };

test('ошибка первого комментария сохраняется при успешной обработке следующих', async () => {
  let active = 0;
  let maxActive = 0;
  const result = await processScreenshots({
    base,
    resolveFile: async id => {
      if (id === 1) throw new Error('private-token');
      return { DOWNLOAD_URL: `https://example.test/${id}` };
    },
    downloadFile: async () => png,
    client: { complete: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return { choices: [{ message: { content: JSON.stringify({ screenshots: [{ file_id: 0, is_chat_screenshot: false }], turns: [] }) } }] };
    } },
  });
  assert.equal(maxActive, 1);
  assert.equal(result.output.screenshot_stats.screenshots_total, 3);
  assert.equal(result.output.screenshot_stats.screenshots_failed, 1);
  assert.equal(result.output.screenshot_stats.comments_failed, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
  const sources = pgInitMarks();
  for (const key of Object.keys(sources)) pgMarkComplete(sources, key, 1);
  assert.equal(pgDecide({ sources, recognition: { screenshots: result.failures } }).block, true);
});

test('два комментария с одним ID не получают чужой результат', async () => {
  const duplicated = { communications: [base.communications[0], base.communications[0]] };
  await assert.rejects(processScreenshots({ base: duplicated }), /Неоднозначный идентификатор/);
});
