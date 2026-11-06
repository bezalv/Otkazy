import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exactMillisTimestamp } from '../../app/src/time-precision.mjs';

test('даты и смещения проверяются до нормализации Date', () => {
  for (const value of [
    '2026-02-30T12:00:00Z', '2026-02-30T12:00:00+07:00',
    '2026-02-29T12:00:00Z', '1900-02-29T12:00:00-03:00',
    '2026-04-31T12:00:00Z', '2026-00-10T12:00:00Z', '2026-13-01T12:00:00Z',
    '2026-01-00T12:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T12:60:00Z',
    '2026-01-01T12:00:60Z', '2026-01-01T12:00:00+24:00', '2026-01-01T12:00:00+07:60',
    '0000-01-01T00:00:00Z', '2026-01-01T00:00:00.000500Z',
  ]) assert.equal(exactMillisTimestamp(value), null, value);
  assert.equal(exactMillisTimestamp('2024-02-29T07:00:00+07:00').toISOString(), '2024-02-29T00:00:00.000Z');
  assert.equal(exactMillisTimestamp('2000-02-29T12:00:00-03:30').toISOString(), '2000-02-29T15:30:00.000Z');
  assert.equal(exactMillisTimestamp('2026-11-01T00:00:00.123000Z').toISOString(), '2026-11-01T00:00:00.123Z');
  assert.equal(exactMillisTimestamp('2026-11-01T00:00:00.000000+07:00').toISOString(), '2026-10-31T17:00:00.000Z');
});
