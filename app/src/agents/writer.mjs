function firstSentence(text, limit) {
  if (!text) return '';
  let result = String(text).replace(/\s+/g, ' ').trim();
  const end = result.search(/[.!?](\s|$)/);
  if (end > 20) result = result.slice(0, end + 1);
  if (result.length > limit) result = result.slice(0, limit).replace(/\s+\S*$/, '') + '…';
  return result;
}

// Источник формулировок — prototype/lib/skip-writer-comment.js.
export function skipWriterComment(judge) {
  const short = (judge?.verdict_reason_short || '').trim();
  const exact = firstSentence(judge?.exact_reason, 220);
  if (judge?.verdict === 'недостаточно_данных') {
    return 'Недостаточно данных для оценки: '
      + (exact || short || 'в материалах сделки нет содержательных диалогов с клиентом');
  }
  if (judge?.verdict === 'правомерен') return short ? `Отказ правомерен: ${short}` : 'Отказ правомерен.';
  if (judge?.verdict === 'неправомерен') {
    return short
      ? `Отказ неправомерен: ${short}. Подробный разбор не сформирован.`
      : 'Отказ неправомерен. Подробный разбор не сформирован.';
  }
  return 'Разбор не сформирован: вердикт не получен.';
}

// Это условия IF «verdict-router» из выгрузки n8n, включая случаи с низким
// потенциалом возврата или ошибками менеджера при других вердиктах.
export function shouldRunWriter(judge) {
  return judge.verdict === 'неправомерен'
    || judge.manager_mistakes.length > 0
    || judge.recoverable_level === 'низкий';
}

export function parseWriterResponse(response, previous) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) return null;
  return {
    ...previous,
    final_comment: content.trim(),
    writer_model: response.model || 'openai/gpt-6-sol',
    writer_usage: response.usage || {},
    _block: 'writer_done',
  };
}
