import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mergeScreenshotResults } from '../../app/src/screenshots/parse.mjs';

const original = await readFile(new URL('./fixtures/screenshots-parse.n8n.txt', import.meta.url), 'utf8');
const executeOriginal = new Function('$', '$input', original);

function compare(base, tasks, runs) {
  const $ = name => {
    if (name === 'b4.5 Comm Analytics') return { first: () => ({ json: structuredClone(base) }) };
    if (name === 'screenshots-fetch') return { all: () => tasks.map(json => ({ json: structuredClone(json) })) };
    throw new Error('Неизвестный источник теста');
  };
  const expected = executeOriginal($, { all: () => runs.map(json => ({ json: structuredClone(json) })) })[0].json;
  assert.deepEqual(mergeScreenshotResults(structuredClone(base), structuredClone(tasks), structuredClone(runs)), expected);
}

compare({ communications: [] }, [{ _has_images: false }], []);
compare({ communications: [{ type: 'comment', comment_id: '1', screenshots: [{ file_id: 5 }] }] }, [{
  _has_images: true,
  comment_id: '1',
  files: [{ file_id: 5, name: 'test.png', date: '2026-01-02T00:00:00Z' }],
  stats: { screenshots_total: 1, screenshots_downloaded: 1, comments_with_screenshots: 1 },
}], [{ choices: [{ message: { content: '{"screenshots": []}' } }], model: 'test', usage: {} }]);
compare({ communications: [{ type: 'comment', comment_id: '1', screenshots: [{ file_id: 5 }] }] }, [{
  _has_images: true, comment_id: '1', files: [{ file_id: 5 }], stats: { screenshots_total: 1 },
}], [{ error: { message: 'test failure' } }]);
console.log('Разбор скриншотов совпадает с нодой на трёх сценариях');
