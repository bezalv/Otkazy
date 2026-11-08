// Эта фраза встречалась как единственное содержимое ответа резервного STT.
// Она может прозвучать и в самой записи: мы не считаем её доказанной тишиной,
// а только сигнализируем, что содержание нуждается в повторной проверке.
export function ambiguousProcessingOnly(result) {
  const isStatus = value => {
    if (typeof value !== 'string') return false;
    const text = value.replace(/(?:^|\n)[ \t]*(?:Говорящий|Менеджер|Клиент|Участник чата|client|manager)\s*:[ \t]*/giu, '\n').trim();
    return /^(?:пожалуйста\s*,\s*подождите\s+завершения\s+обработки\s*[.!…]*\s*)+$/iu.test(text);
  };
  if (!isStatus(result?.formatted_dialog)) return false;
  for (const value of [result.manager_text, result.client_text]) {
    if (value != null && typeof value !== 'string') return false;
    if (typeof value === 'string' && value.trim() && !isStatus(value)) return false;
  }
  if (result.conversation != null && !Array.isArray(result.conversation)) return false;
  if (Array.isArray(result.conversation) && result.conversation.some(item =>
    !item || typeof item !== 'object' || typeof item.text !== 'string' || (item.text.trim() && !isStatus(item.text)))) return false;
  return true;
}
