// Формат карточки повторяет ноду «Собрать AI-комментарий» от 19.10.2026.
const verdicts = { 'правомерен': 'Правомерен', 'неправомерен': 'Неправомерен' };
const classes = {
  manager_dropped: 'Менеджер бросил сделку', competitor: 'Ушёл к конкуренту', price: 'Цена',
  no_need: 'Нет потребности', no_money: 'Нет бюджета', timing: 'Не время',
  customer_unreachable: 'Клиент не отвечает', regulatory: 'Регуляторные ограничения', other: 'Прочее',
};
const recovery = { 'высокий': 'высокий шанс (≈80%)', 'средний': 'средний шанс (≈50%)', 'низкий': 'низкий шанс (≈25%)' };

export function buildBitrixComment(result, now = Date.now()) {
  const id = Number(result?.deal_id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('Некорректный deal_id');
  const ma = result.multi_agent_analysis || result.classification || {};
  const verdict = ma.verdict || 'неизвестно';
  const reasonClass = ma.closure_reason_class || 'other';
  const date = new Date(now + 7 * 60 * 60 * 1000);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Некорректное время');
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  const lines = [
    `[B]🔍 AI-анализ отказа[/B] (${dateStr})`, '',
    `[B]Вердикт:[/B] ${verdicts[verdict] || verdict}${ma.verdict_reason_short ? ' — ' + ma.verdict_reason_short : ''}`,
    `[B]Класс причины:[/B] ${classes[reasonClass] || reasonClass} (${reasonClass})`,
  ];
  if (verdict === 'неправомерен') {
    if (recovery[ma.recoverable_level]) lines.push(`[B]Возврат сделки:[/B] ${recovery[ma.recoverable_level]}`);
    if (ma.misplaced === true && ma.correct_stage) lines.push(`[B]Корректная стадия:[/B] ${ma.correct_stage} (сделка в неправильной стадии)`);
  } else if (verdict === 'правомерен') lines.push('[B]Возврат сделки:[/B] не требуется');
  lines.push('─────────────────────────────────────', '');
  if (ma.final_comment && ma.final_comment.trim() && ma.final_comment.trim() !== 'Отказ правомерен') lines.push(ma.final_comment.trim());
  else if (ma.exact_reason) lines.push(`[B]Причина отказа:[/B] ${ma.exact_reason}`);
  else lines.push('(детальный анализ недоступен)');
  lines.push('', '─────────────────────────────────────');
  const judge = ma.judge_model || 'не задано', writer = ma.writer_model || '—';
  const tokens = (ma.judge_usage?.total_tokens || 0) + (ma.writer_usage?.total_tokens || 0);
  lines.push(`[I]Модель: ${judge}${writer !== '—' && writer !== judge ? ' + ' + writer : ''} | Промпт ${result.prompt_version || 'v2.8-sol'}${tokens ? ' | Токены: ~' + Math.round(tokens / 1000) + 'k' : ''}[/I]`);
  return { fields: { ENTITY_TYPE: 'deal', ENTITY_ID: id, COMMENT: lines.join('\n') } };
}
