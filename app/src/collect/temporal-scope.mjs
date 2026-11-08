import { chatMillisTimestamp } from '../time-precision.mjs';

const time = value => chatMillisTimestamp(value)?.getTime() ?? null;

/**
 * Ограничивает известные события границей перехода, не меняя исходные данные.
 * Это не исторический снимок: содержимое и роли могли измениться позже.
 * При неопределённой принадлежности события не объявляем источник полным.
 */
export function scopeCollectionAtLose(collection, { screenshots = true } = {}) {
  const cutoff = time(collection?.deal_data?.lose_date);
  if (cutoff === null) return { error: { source: 'calls', reason: 'Не подтверждена точная дата отказа' } };
  const raw = collection?.raw;
  if (!raw || !['calls', 'comments', 'tasks', 'sessions'].every(key => Array.isArray(raw[key]))) {
    return { error: { source: 'calls', reason: 'Не подтверждён состав коммуникаций' } };
  }
  const scoped = { ...raw, calls: [], comments: [], tasks: [] };
  const counts = { calls: 0, comments: 0, tasks: 0 };
  for (const call of raw.calls) {
    const created = time(call?.CREATED);
    const start = time(call?.START_TIME);
    const end = time(call?.END_TIME);
    const hasAudio = Boolean(call?.SETTINGS?.RECORD_URL) || (call?.FILES && typeof call.FILES === 'object' && Object.keys(call.FILES).length > 0);
    const actual = start !== null;
    if ((hasAudio || call?.PROVIDER_ID === 'VOXIMPLANT_CALL') && start === null) {
      return { error: { source: 'calls', reason: 'Неизвестно время начала звонка' } };
    }
    // Активность может появиться и после разговора. При наличии START_TIME
    // границу проверяем по нему; поздний запланированный звонок не выдаём за
    // попытку до отказа. Историческую редакцию плана API не подтверждает.
    const eventTime = actual && start !== null ? start : created;
    if (eventTime === null) return { error: { source: 'calls', reason: 'Неизвестно время звонка' } };
    if (eventTime === cutoff) return { error: { source: 'calls', reason: 'Порядок звонка и отказа не подтверждён' } };
    if (eventTime > cutoff) {
      counts.calls++;
      // CRM-дело, созданное до отказа существенно раньше планового старта,
      // сохраняется как план без аудио и без утверждения, что звонок был.
      if (created !== null && created < cutoff && start !== null && start - created > 600000) {
        scoped.calls.push({ ID: call.ID, CREATED: call.CREATED, START_TIME: call.START_TIME,
          SUBJECT: call.SUBJECT, RESPONSIBLE_ID: call.RESPONSIBLE_ID, _historical_plan_only: true });
      }
      continue;
    }
    if (actual && ((hasAudio && end === null) || (end !== null && end < start))) {
      return { error: { source: 'calls', reason: 'Не подтверждено время окончания записи' } };
    }
    if (actual && start !== null && end !== null && end >= cutoff) {
      return { error: { source: 'calls', reason: 'Звонок пересекает момент отказа' } };
    }
    // CREATED сохраняется для распознавания планируемой CRM-активности;
    // дата события передаётся отдельно, не меняя исходную активность.
    scoped.calls.push(actual ? { ...call, _historical_event_time: call.START_TIME } : call);
  }
  for (const [key, field, source] of [['comments', 'CREATED', 'comments'], ['tasks', null, 'tasks']]) {
    for (const item of raw[key]) {
      const value = field ? item?.[field] : (item?.createdDate || item?.CREATED_DATE);
      const eventTime = time(value);
      if (eventTime === null) return { error: { source, reason: 'Неизвестно время события' } };
      if (eventTime === cutoff) return { error: { source, reason: 'Порядок события и отказа не подтверждён' } };
      if (eventTime > cutoff) { counts[key]++; continue; }
      if (key === 'comments' && screenshots && item?.FILES && typeof item.FILES === 'object') {
        for (const file of Object.values(item.FILES)) {
          if (String(file?.type) !== 'image') continue;
          const fileTime = time(file?.date || file?.DATE || null);
          if (fileTime === null || fileTime >= cutoff) {
            return { error: { source, reason: 'Дата изображения не подтверждает его наличие до отказа' } };
          }
        }
      }
      scoped[key].push(item);
    }
  }
  return { collection: { ...collection, raw: scoped }, cutoff, excluded: counts };
}
