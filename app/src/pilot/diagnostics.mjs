// Только фиксированные обозначения: ни текст ошибки, ни тело ответа API,
// ни идентификаторы коммуникаций в диагностический отчёт не попадают.
export const DIAGNOSTIC_CATEGORIES = Object.freeze(['none', 'deal_or_history', 'history', 'collection',
  'recognition', 'judge', 'writer', 'audio_wait', 'audio_origin', 'processing_exception', 'other']);
export const DIAGNOSTIC_METHODS = Object.freeze(['crm.deal.userfield.list', 'crm.deal.get', 'crm.stagehistory.list',
  'crm.activity.list', 'crm.timeline.comment.list', 'imopenlines.crm.chat.get',
  'imopenlines.session.history.get', 'tasks.task.list', 'disk.file.get']);
export const DIAGNOSTIC_SOURCES = Object.freeze(['calls', 'openlines', 'comments', 'tasks']);
export const DIAGNOSTIC_MEDIA = Object.freeze(['calls', 'voices', 'screenshots', 'other']);

function statusCode(value) {
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : null;
}
function safeHttpReason(value) {
  if (typeof value !== 'string') return null;
  const match = /^(?:HTTP |Сбой (?:судьи|писателя): Polza HTTP )([45]\d\d)$/.exec(value);
  return match ? statusCode(Number(match[1])) : null;
}

export function diagnoseOutcome(result, trace = {}) {
  const status = result?.status;
  let category = 'other';
  if (status === 'processed') category = 'none';
  else if (status === 'unverified') category = 'audio_origin';
  else if (status === 'source_incomplete' || status === 'waiting' || status === 'expired') category = 'audio_wait';
  else if (result?.pipelineGate?.kind === 'recognition') category = 'recognition';
  else if (result?.pipelineGate?.kind === 'collect' || result?.collection?._step === 'collect_incomplete') category = 'collection';
  else if (result?.collection?._step === 'deal_or_history') category = trace.lastMethod === 'crm.stagehistory.list' ? 'history' : 'deal_or_history';
  else if (result?.collection?._step === 'fresh_deal_wait') category = 'history';
  else if (result?.collection?._step === 'check_stage') category = 'deal_or_history';
  else if (typeof result?.analysis?.pipeline_error === 'string' && result.analysis.pipeline_error.startsWith('Сбой судьи:')) category = 'judge';
  else if (typeof result?.analysis?.pipeline_error === 'string' && result.analysis.pipeline_error.startsWith('Сбой писателя:')) category = 'writer';
  else if (result?.status === 'exception') category = 'processing_exception';
  // Эти сообщения созданы самим processDeal и не содержат данных сделки.
  else if (['Неизвестна дата отказа', 'История стадий ещё не подтверждает дату отказа'].includes(result?.collection?._error)) category = 'history';

  const failedSources = category === 'collection' ? DIAGNOSTIC_SOURCES.filter(name => result?.collection?._sources?.[name]?.complete === false) : [];
  const media = { calls: 0, voices: 0, screenshots: 0, other: 0 };
  if (category === 'recognition' && Array.isArray(result?.pipelineGate?.failures)) {
    for (const item of result.pipelineGate.failures.slice(0, 10000)) {
      const key = item?.kind === 'звонок' ? 'calls' : item?.kind === 'голосовое' ? 'voices'
        : item?.kind === 'скриншот' ? 'screenshots' : 'other';
      media[key]++;
    }
  }
  const method = ['history', 'deal_or_history'].includes(category) && DIAGNOSTIC_METHODS.includes(trace.lastMethod) ? trace.lastMethod : null;
  const http = safeHttpReason(result?.analysis?.pipeline_error) || safeHttpReason(result?.collection?._error)
    || (category === 'collection' ? failedSources.map(name => safeHttpReason(result.collection._sources[name]?.error)).find(Boolean) : null)
    || (method ? statusCode(trace.httpStatus) : null);
  return { category, last_bitrix_method: method, http_status: http || null, failed_sources: failedSources, recognition_failures: media };
}
