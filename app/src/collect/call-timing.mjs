import { chatMillisTimestamp } from '../time-precision.mjs';

const time = value => chatMillisTimestamp(value)?.getTime() ?? null;
const verified = new WeakMap();
export const hasCallRecording = call => Boolean(call?.SETTINGS?.RECORD_URL)
  || Object.keys(call?.FILES || {}).length > 0 || Object.values(call?.STORAGE_ELEMENT_IDS || {}).length > 0;
const fileIds = call => [...new Set(Object.entries(call?.FILES || {}).map(([key, file]) =>
  String(file?.id ?? file?.ID ?? (Array.isArray(call.FILES) ? '' : key)))
  .concat(Object.values(call?.STORAGE_ELEMENT_IDS || {}).map(String)).filter(id => /^[1-9]\d*$/.test(id)))].sort();
const binding = call => JSON.stringify([String(call.ID), call.ORIGIN_ID ?? null,
  call.CREATED ?? null, call.START_TIME ?? null, call.END_TIME ?? null, fileIds(call)]);

/** У выполненного планового дела START_TIME/END_TIME могут остаться сроками задачи. */
export function needsVerifiedCallTiming(call) {
  if (!hasCallRecording(call)) return false;
  const created = time(call.CREATED), start = time(call.START_TIME), end = time(call.END_TIME);
  return created === null || start === null || end === null || end < start || Math.abs(start - created) > 600000;
}

/** Только статистика именно этой активности/записи подтверждает фактические даты. */
export function attachVerifiedCallTiming(call, rows) {
  if (!Array.isArray(rows)) throw new Error('Некорректная статистика звонка');
  const origin = String(call.ORIGIN_ID || '').replace(/^VI_/, '');
  const files = fileIds(call);
  const matches = rows.filter(row => String(row?.CRM_ACTIVITY_ID) === String(call.ID)
    && (!origin || String(row.CALL_ID) === origin)
    && (!files.length || !row.RECORD_FILE_ID || String(row.RECORD_FILE_ID) === '0' || files.includes(String(row.RECORD_FILE_ID))));
  if (matches.length !== 1) throw new Error('Не подтверждена единственная запись статистики звонка');
  const row = matches[0], start = time(row.CALL_START_DATE);
  if (!origin && !files.includes(String(row.RECORD_FILE_ID))) {
    throw new Error('Статистика не связана с текущей записью');
  }
  const duration = typeof row.CALL_DURATION === 'string' && /^\d+$/.test(row.CALL_DURATION)
    ? Number(row.CALL_DURATION) : row.CALL_DURATION;
  const end = start === null ? NaN : start + duration * 1000;
  if (start === null || !Number.isSafeInteger(duration) || duration <= 0 || !Number.isFinite(new Date(end).getTime())) {
    throw new Error('Не подтверждены время и длительность записанного звонка');
  }
  const proof = Object.freeze({ source: 'voximplant.statistic.get', activity_id: String(call.ID),
    statistic_id: String(row.ID ?? ''), call_id: String(row.CALL_ID ?? ''),
    start: new Date(start).toISOString(), end: new Date(end).toISOString(), duration_seconds: duration,
    record_file_id: row.RECORD_FILE_ID ? String(row.RECORD_FILE_ID) : null });
  verified.set(proof, binding(call));
  return { ...call, _call_timing: proof };
}

export function verifiedCallTiming(call) {
  const proof = call?._call_timing;
  return proof && verified.get(proof) === binding(call) ? proof : null;
}
