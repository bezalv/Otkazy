import assert from 'node:assert/strict';
import { test } from 'node:test';
import { awAssess, awCandidate, awHasAudio, awTime, planAudioWait, queueStateAfterAnalysis } from '../../app/src/audio-wait/index.mjs';

const now = Date.parse('2026-11-01T10:00:00Z');
const iso = ms => new Date(ms).toISOString();
const loseDate = iso(now - 60000);
const enabledAt = iso(now - 3600000);
const call = {
  ID: '123', PROVIDER_ID: 'VOXIMPLANT_CALL', COMPLETED: 'Y',
  CREATED: iso(now - 180000), START_TIME: iso(now - 180000),
  END_TIME: iso(now - 120000), FILES: [],
};
const assess = (calls = [call], saved = null, at = now, lost = loseDate) =>
  awAssess(calls, lost, enabledAt, saved, at);
const first = assess();
const saved = { ...first.queue, state: 'waiting' };
const input = { stageId: 'C23:LOSE', callsComplete: true, calls: [call], loseDate, enabledAt, saved, nowMs: now };

test('даты драйвера PostgreSQL сохраняют миллисекунды', () => {
  assert.equal(awTime(new Date('2026-11-01T10:00:00.123Z')), now + 123);
});

test('включается только для отказов после даты активации', () => {
  assert.equal(assess([call], null, now, iso(now - 7200000)).state, 'disabled');
  assert.equal(assess([call], null, now, null).state, 'disabled');
  assert.equal(assess([call], null, now, enabledAt).state, 'waiting');
  assert.equal(assess([]).state, 'ready');
});

test('наступление каждого срока планирует следующую проверку относительно первой', () => {
  assert.equal(first.state, 'waiting');
  assert.equal(first.queue.next_check_at, iso(now + 5 * 60000));
  for (const [elapsed, next] of [[5, 15], [15, 30], [30, 60], [60, 120], [120, 180], [420, 480], [480, 1440]]) {
    assert.equal(assess([call], saved, now + elapsed * 60000).queue.next_check_at, iso(now + next * 60000));
  }
});

test('повторная проверка сохраняет дату начала, дедлайн и первое обнаружение', () => {
  const snapshot = structuredClone(saved);
  const repeated = assess([call], saved, now + 10 * 60000);
  assert.equal(repeated.queue.first_seen_at, iso(now));
  assert.equal(repeated.queue.deadline_at, iso(now + 86400000));
  assert.equal(repeated.queue.observations['123'].first_missing_at, iso(now));
  assert.deepEqual(saved, snapshot);
});

test('для доступности нужен RECORD_URL или URL файла, одного ID недостаточно', () => {
  assert.equal(awHasAudio({ FILES: [{ id: 7 }] }), false);
  assert.equal(awHasAudio({ FILES: [{ urlDownload: 'https://example.test/audio' }] }), true);
  assert.equal(awHasAudio({ SETTINGS: { RECORD_URL: 'https://example.test/audio' } }), true);
  assert.equal(assess([{ ...call, FILES: [{ id: 7 }] }]).state, 'waiting');
  assert.equal(assess([{ ...call, SETTINGS: { RECORD_URL: 'https://example.test/audio' } }]).state, 'ready');
});

test('учитываются завершённые реальные звонки в пределах суток и после отказа', () => {
  assert.equal(awCandidate(call, Date.parse(loseDate), now), true);
  assert.equal(awCandidate({ ...call, PROVIDER_ID: 'other' }, Date.parse(loseDate), now), false);
  assert.equal(awCandidate({ ...call, COMPLETED: 'N' }, Date.parse(loseDate), now), false);
  assert.equal(awCandidate({ ...call, END_TIME: call.START_TIME }, Date.parse(loseDate), now), false);
  assert.equal(awCandidate({ ...call, CREATED: iso(now - 7200000) }, Date.parse(loseDate), now), false);
  const old = { ...call, CREATED: iso(now - 2 * 86400000), START_TIME: iso(now - 2 * 86400000), END_TIME: iso(now - 2 * 86400000 + 1000) };
  assert.equal(assess([old]).state, 'ready');
  const after = { ...call, CREATED: iso(now - 30000), START_TIME: iso(now - 30000), END_TIME: iso(now - 10000) };
  assert.equal(assess([after]).state, 'waiting');
});

test('все ожидаемые записи должны появиться, в том числе исчезнувшая из ответа', () => {
  const file = { ...call, FILES: [{ url: 'https://example.test/audio' }] };
  assert.equal(assess([], saved).state, 'waiting');
  assert.equal(assess([file, { ...call, ID: '456' }], saved).state, 'waiting');
  const ready = assess([file], saved, now + 1000000);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.queue.observations['123'].first_audio_seen_at, iso(now + 1000000));
});

test('при достижении суток запись проверяется до решения о нехватке данных', () => {
  const file = { ...call, FILES: [{ url: 'https://example.test/audio' }] };
  assert.equal(assess([call], saved, now + 86400000 - 1).state, 'waiting');
  assert.equal(assess([call], saved, now + 86400000).state, 'expired');
  assert.equal(assess([file], saved, now + 86400000).state, 'ready');
});

test('завершённые ожидания не перерассчитываются, новый отказ начинает новую очередь', () => {
  const file = { ...call, FILES: [{ url: 'https://example.test/audio' }] };
  for (const state of ['done', 'expired', 'cancelled']) {
    assert.equal(assess([file], { ...saved, state }).state, 'terminal');
  }
  const oldQueue = { ...saved, state: 'expired', lose_date: iso(now - 1800000) };
  const next = assess([call], oldQueue, now + 1000);
  assert.equal(next.state, 'waiting');
  assert.equal(next.queue.first_seen_at, iso(now + 1000));
});

test('ручной повтор использует позднюю запись без открытия завершённой очереди', () => {
  const file = { ...call, FILES: [{ url: 'https://example.test/audio' }] };
  for (const state of ['done', 'expired', 'cancelled']) {
    const terminal = { ...structuredClone(saved), state, _recheck_terminal: true };
    const snapshot = structuredClone(terminal);
    assert.deepEqual(planAudioWait({ ...input, saved: terminal, calls: [file], nowMs: now + 2 * 86400000 }),
      { action: 'analyze', queue: null });
    assert.deepEqual(terminal, snapshot);
    assert.deepEqual(planAudioWait({ ...input, saved: terminal, nowMs: now + 2 * 86400000 }),
      { action: 'skip', reason: 'audio_wait_terminal_recordings_missing', queueChange: null });
    assert.deepEqual(planAudioWait({ ...input, saved: terminal, calls: [], nowMs: now + 2 * 86400000 }),
      { action: 'skip', reason: 'audio_wait_terminal_recordings_missing', queueChange: null });
    assert.equal(planAudioWait({ ...input, saved: { ...terminal, _recheck_terminal: false }, calls: [file] }).reason,
      'audio_wait_terminal');
  }
});

test('в повторе нужна актуальная ссылка даже для прежде доступной записи', () => {
  const file = { ...call, FILES: [{ url: 'https://example.test/audio' }] };
  const terminal = { ...structuredClone(saved), state: 'done', _recheck_terminal: true };
  terminal.observations['123'].first_audio_seen_at = iso(now + 1000);
  for (const calls of [[], [call]]) {
    assert.deepEqual(planAudioWait({ ...input, saved: terminal, calls, nowMs: now + 2 * 86400000 }),
      { action: 'skip', reason: 'audio_wait_terminal_recordings_missing', queueChange: null });
  }
  assert.deepEqual(planAudioWait({ ...input, saved: terminal, calls: [file], nowMs: now + 2 * 86400000 }),
    { action: 'analyze', queue: null });
});

test('ожидание и истечение сохраняют silent и screenshots', () => {
  const waiting = planAudioWait({ ...input, silent: true, screenshots: true });
  assert.equal(waiting.action, 'waiting');
  assert.equal(waiting.silent, true);
  assert.equal(waiting.screenshots, true);
  const expired = planAudioWait({ ...input, nowMs: now + 86400000, silent: true, screenshots: false });
  assert.equal(expired.action, 'expired');
  assert.equal(expired.silent, true);
  assert.equal(expired.screenshots, false);
  assert.equal(expired.multi_agent_analysis.verdict, 'недостаточно_данных');
  assert.equal(expired.multi_agent_analysis.judge_model, 'none (audio-wait gate)');
  assert.deepEqual(expired.multi_agent_analysis.manager_mistakes, []);
  assert.equal(expired.multi_agent_analysis.audio_wait, expired.queue);
});

test('смена стадии отменяет только ожидающую очередь', () => {
  assert.deepEqual(planAudioWait({ ...input, stageId: 'C23:WON' }), {
    action: 'skip', reason: 'not_in_lost_stage', cancelWaitingQueue: true,
  });
  assert.equal(planAudioWait({ ...input, stageId: 'C23:WON', saved: { ...saved, state: 'done' } }).cancelWaitingQueue, false);
  assert.throws(() => planAudioWait({ ...input, stageId: null }), /стадия/);
});

test('ошибка сбора звонков не превращается в истечение ожидания или разрешение судьи', () => {
  assert.deepEqual(planAudioWait({ ...input, callsComplete: false, nowMs: now + 86400000 }), {
    action: 'source_incomplete', queueChange: null,
  });
  assert.throws(() => planAudioWait({ ...input, calls: null }), /список звонков/);
});

test('отсутствующие даты отказа или настройки блокируют анализ', () => {
  for (const overrides of [
    { loseDate: null }, { loseDate: 'invalid' }, { enabledAt: null }, { enabledAt: 'invalid' },
  ]) {
    assert.deepEqual(planAudioWait({ ...input, ...overrides }), {
      action: 'source_incomplete', reason: 'audio_wait_dates_missing', queueChange: null,
    });
  }
  assert.equal(planAudioWait({ ...input, loseDate: iso(now - 7200000) }).action, 'analyze');
});

test('кандидат ожидания без достоверного ID блокирует анализ', () => {
  for (const id of [undefined, null, '', 0, 'неизвестно']) {
    assert.deepEqual(planAudioWait({ ...input, calls: [{ ...call, ID: id }] }), {
      action: 'source_incomplete', reason: 'audio_wait_call_data_incomplete', queueChange: null,
    });
  }
});

test('недостающие даты завершённого звонка не дают преждевременного вердикта', () => {
  for (const field of ['START_TIME', 'END_TIME']) {
    assert.equal(planAudioWait({ ...input, calls: [{ ...call, [field]: null }] }).action, 'source_incomplete');
  }
  const older = { ...call, CREATED: iso(now - 3 * 86400000), START_TIME: null };
  assert.equal(planAudioWait({ ...input, calls: [older], saved: null }).action, 'analyze');
  assert.equal(planAudioWait({ ...input, calls: [{ ...call, COMPLETED: 'N', END_TIME: null }], saved: null }).action, 'analyze');
});

test('доступная запись открывает анализ, очередь завершается только при успешной записи', () => {
  const file = { ...call, FILES: [{ url: 'https://example.test/audio' }] };
  const plan = planAudioWait({ ...input, calls: [file] });
  assert.equal(plan.action, 'analyze');
  assert.equal(queueStateAfterAnalysis(plan, 'processed'), 'done');
  assert.equal(queueStateAfterAnalysis(plan, 'error'), null);
  assert.equal(queueStateAfterAnalysis({ action: 'analyze', queue: null }, 'processed'), null);
  assert.equal(queueStateAfterAnalysis({ action: 'expired', queue: saved }, 'processed'), null);
});
