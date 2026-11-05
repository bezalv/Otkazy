import { prepareScreenshotTasks } from './prepare.mjs';
import { collectScreenshotResults } from './results.mjs';

const COUNT_FIELDS = [
  'screenshots_total', 'screenshots_extracted', 'screenshots_failed', 'screenshots_downloaded',
  'comments_with_screenshots', 'comments_ok', 'comments_not_chat', 'comments_failed',
  'ui_notices_dropped', 'llm_calls', 'prompt_tokens', 'completion_tokens', 'cost_rub',
];

/** Обрабатывает скриншоты по одному комментарию, не удерживая все изображения в памяти. */
export async function processScreenshots({ base, resolveFile, downloadFile, client }) {
  let output = { ...base, communications: [...(base.communications || [])] };
  const comments = output.communications.filter(comment => comment?.type === 'comment' && comment.screenshots?.length);
  const commentIds = new Set();
  for (const comment of comments) {
    const id = String(comment.comment_id ?? '').trim();
    if (!id || commentIds.has(id)) throw new Error('Неоднозначный идентификатор комментария со скриншотами');
    commentIds.add(id);
  }
  const failures = [];
  const totals = Object.fromEntries(COUNT_FIELDS.map(key => [key, 0]));
  totals.model = null;
  totals.warnings = [];

  for (const comment of comments) {
    const prepared = await prepareScreenshotTasks({ communications: [comment], resolveFile, downloadFile });
    const task = prepared.tasks[0];
    const responses = [];
    if (task._has_images) {
      let response;
      try {
        response = await client.complete(task.polza_body, { role: 'screenshots' });
      } catch {
        response = { error: { message: 'Не удалось вызвать модель скриншотов' } };
      } finally {
        delete task.polza_body;
      }
      responses.push({ comment_id: task.comment_id, response });
    }
    const result = collectScreenshotResults({ base: output, tasks: prepared.tasks, responses, preparationFailures: prepared.failures });
    output = result.output;
    failures.push(...result.failures);
    const stats = output.screenshot_stats;
    for (const key of COUNT_FIELDS) totals[key] += Number(stats[key]) || 0;
    totals.model ||= stats.model || null;
    totals.warnings.push(...(stats.warnings || []));
  }

  totals.cost_rub = Math.round(totals.cost_rub * 10000) / 10000;
  output.screenshot_stats = totals;
  output._block = 'screenshots_extracted';
  return { output, failures };
}
