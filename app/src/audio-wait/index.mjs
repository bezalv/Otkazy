// Чистая логика ожидания. Встраивается в ноды скриптом bench/build-audio-wait.mjs.
// Окно кандидатов относительно перехода в отказ: сутки, поскольку более старые
// отсутствующие файлы уже не объясняются обнаруженной задержкой в несколько часов.
export const AW_DAY_MS = 86400000;
export const AW_CHECK_MINUTES = [5, 15, 30, 60, 120, 180, 240, 300, 360, 420, 480, 1440];
export function awTime(value) {
  // Драйвер PostgreSQL возвращает timestamptz как Date; строковое преобразование
  // Date теряет миллисекунды и незаметно смещает исходные сроки ожидания.
  var t = value instanceof Date ? value.getTime() : value ? Date.parse(value) : NaN;
  return isFinite(t) ? t : null;
}
export function awHasAudio(call) {
  if (call.SETTINGS && call.SETTINGS.RECORD_URL) return true;
  return Object.values(call.FILES || {}).some(function (f) {
    return !!(f && (f.urlDownload || f.URL_DOWNLOAD || f.url));
  });
}
export function awCandidate(call, loseMs, nowMs) {
  if (String(call.PROVIDER_ID) !== 'VOXIMPLANT_CALL' || String(call.COMPLETED) !== 'Y') return false;
  var start = awTime(call.START_TIME), end = awTime(call.END_TIME), created = awTime(call.CREATED);
  if (start === null || end === null || end <= start || end > nowMs + 60000) return false;
  // Запланированное CRM-дело с напоминанием не является записью реального звонка.
  if (created !== null && Math.abs(start - created) > 600000) return false;
  return end >= loseMs - AW_DAY_MS;
}
export function awAssess(calls, loseDate, enabledAt, saved, nowMs) {
  var loseMs = awTime(loseDate), enabledMs = awTime(enabledAt);
  if (loseMs === null || enabledMs === null || loseMs < enabledMs) return { state: 'disabled' };
  var q = saved && awTime(saved.lose_date) === loseMs ? saved : null;
  if (q && ['done', 'expired', 'cancelled'].indexOf(q.state) !== -1) return { state: 'terminal', queue: q };
  var first = q ? awTime(q.first_seen_at) : nowMs;
  var deadline = q ? awTime(q.deadline_at) : first + AW_DAY_MS;
  if (first === null || deadline === null) throw new Error('Некорректное время очереди аудио');
  var observations = JSON.parse(JSON.stringify((q && q.observations) || {}));
  var pending = [];
  for (var i = 0; i < (calls || []).length; i++) {
    var c = calls[i], id = String(c.ID);
    var tracked = observations[id];
    if (!tracked && !awCandidate(c, loseMs, nowMs)) continue;
    var available = awHasAudio(c);
    if (!available) {
      pending.push(id);
      if (!tracked) observations[id] = { activity_id: id, provider: c.PROVIDER_ID, ended_at: c.END_TIME, first_missing_at: new Date(nowMs).toISOString(), first_audio_seen_at: null };
    } else if (tracked && !tracked.first_audio_seen_at) {
      tracked.first_audio_seen_at = new Date(nowMs).toISOString();
    }
  }
  // Если ранее виденный звонок исчез из ответа, это не доказательство готовности.
  Object.keys(observations).forEach(function (id) {
    if (!(calls || []).some(function (c) { return String(c.ID) === id; }) && !observations[id].first_audio_seen_at) pending.push(id);
  });
  if (!pending.length && !q) return { state: 'ready' };
  var next = deadline;
  for (var j = 0; j < AW_CHECK_MINUTES.length; j++) {
    var target = first + AW_CHECK_MINUTES[j] * 60000;
    if (target > nowMs) { next = Math.min(target, deadline); break; }
  }
  var state = !pending.length ? 'ready' : nowMs >= deadline ? 'expired' : 'waiting';
  return { state: state, queue: { lose_date: loseDate, first_seen_at: new Date(first).toISOString(), deadline_at: new Date(deadline).toISOString(), next_check_at: new Date(next).toISOString(), pending_calls: pending, observations: observations } };
}

// Решение для внешнего конвейера. Сама постановка в очередь и запись анализа
// выполняются вызывающей стороной в базе, а не этой функцией.
export function planAudioWait({ stageId, callsComplete, calls, loseDate, enabledAt, saved, nowMs, silent, screenshots }) {
  if (typeof stageId !== 'string' || !stageId) throw new TypeError('Неизвестна стадия сделки');
  if (stageId !== 'C23:LOSE') {
    return { action: 'skip', reason: 'not_in_lost_stage', cancelWaitingQueue: saved?.state === 'waiting' };
  }
  if (callsComplete !== true) {
    return { action: 'source_incomplete', queueChange: null };
  }
  if (!Array.isArray(calls)) throw new TypeError('Не получен список звонков');
  if (!Number.isFinite(nowMs)) throw new TypeError('Некорректное время проверки');
  const loseMs = awTime(loseDate);
  const enabledMs = awTime(enabledAt);
  if (loseMs === null || enabledMs === null) {
    return { action: 'source_incomplete', reason: 'audio_wait_dates_missing', queueChange: null };
  }
  if (loseMs >= enabledMs && calls.some(call => {
    if (!call || typeof call !== 'object') return true;
    if (String(call.PROVIDER_ID) === 'VOXIMPLANT_CALL' && String(call.COMPLETED) === 'Y') {
      const created = awTime(call.CREATED);
      const tooOld = created !== null && created < loseMs - AW_DAY_MS - 600000;
      if (!tooOld && (awTime(call.START_TIME) === null || awTime(call.END_TIME) === null)) return true;
    }
    if (!awCandidate(call, loseMs, nowMs)) return false;
    const id = Number(call.ID);
    return !Number.isSafeInteger(id) || id <= 0;
  })) {
    return { action: 'source_incomplete', reason: 'audio_wait_call_data_incomplete', queueChange: null };
  }

  // Повторное задание не должно заново открывать завершённую очередь, но
  // запись могла появиться позже. Проверяем те же звонки и прежний срок;
  // результат передаём без queue, чтобы не изменять терминальную строку.
  const recheckTerminal = saved?._recheck_terminal === true
    && ['done', 'expired', 'cancelled'].includes(saved.state)
    && awTime(saved.lose_date) === loseMs;
  const assessment = awAssess(calls, loseDate, enabledAt,
    recheckTerminal ? { ...saved, state: 'waiting' } : saved, nowMs);
  if (recheckTerminal && assessment.state !== 'disabled') {
    // Ранее замеченная запись не гарантирует, что она доступна сейчас:
    // для нового анализа каждый отслеженный звонок должен присутствовать
    // в свежем ответе и содержать актуальную ссылку на файл.
    const trackedAvailable = Object.keys(saved.observations || {}).every(id =>
      calls.some(call => String(call.ID) === id && awHasAudio(call)));
    if (assessment.state === 'ready' && trackedAvailable) return { action: 'analyze', queue: null };
    // Повтор без новых записей не должен создавать ещё один pipeline_error
    // или заменять прежний вердикт: прежний цикл уже дал конечный результат.
    return { action: 'skip', reason: 'audio_wait_terminal_recordings_missing', queueChange: null };
  }
  if (assessment.state === 'terminal') {
    return { action: 'skip', reason: 'audio_wait_terminal', queueChange: null };
  }
  if (assessment.state === 'waiting') {
    return {
      action: 'waiting',
      queue: assessment.queue,
      silent: silent === true,
      screenshots: screenshots === true,
    };
  }
  if (assessment.state === 'expired') {
    const reason = 'Запись звонка не появилась в течение 24 часов ожидания. Содержание разговора неизвестно; оценка действий менеджера не выносилась.';
    return {
      action: 'expired',
      queue: assessment.queue,
      silent: silent === true,
      screenshots: screenshots === true,
      classification: { summary: reason, exact_reason: reason },
      multi_agent_analysis: {
        verdict: 'недостаточно_данных',
        verdict_reason_short: 'не получена запись звонка',
        exact_reason: reason,
        final_comment: reason,
        manager_mistakes: [],
        recoverable_level: null,
        judge_model: 'none (audio-wait gate)',
        audio_wait: assessment.queue,
      },
    };
  }
  return { action: 'analyze', queue: assessment.queue || null };
}

// Очередь закрывается только вместе с записью успешного анализа в одной транзакции.
export function queueStateAfterAnalysis(plan, analysisStatus) {
  if (plan.action !== 'analyze' || !plan.queue || analysisStatus !== 'processed') return null;
  return 'done';
}
