// Чистая логика ожидания. Встраивается в ноды скриптом bench/build-audio-wait.mjs.
// Окно кандидатов относительно перехода в отказ: сутки, поскольку более старые
// отсутствующие файлы уже не объясняются обнаруженной задержкой в несколько часов.
var AW_DAY_MS = 86400000;
var AW_CHECK_MINUTES = [5, 15, 30, 60, 120, 180, 240, 300, 360, 420, 480, 1440];
function awTime(value) {
  var t = value ? Date.parse(value) : NaN;
  return isFinite(t) ? t : null;
}
function awHasAudio(call) {
  if (call.SETTINGS && call.SETTINGS.RECORD_URL) return true;
  return Object.values(call.FILES || {}).some(function (f) {
    return !!(f && (f.urlDownload || f.URL_DOWNLOAD || f.url));
  });
}
function awCandidate(call, loseMs, nowMs) {
  if (String(call.PROVIDER_ID) !== 'VOXIMPLANT_CALL' || String(call.COMPLETED) !== 'Y') return false;
  var start = awTime(call.START_TIME), end = awTime(call.END_TIME), created = awTime(call.CREATED);
  if (start === null || end === null || end <= start || end > nowMs + 60000) return false;
  // Запланированное CRM-дело с напоминанием не является записью реального звонка.
  if (created !== null && Math.abs(start - created) > 600000) return false;
  return end >= loseMs - AW_DAY_MS;
}
function awAssess(calls, loseDate, enabledAt, saved, nowMs) {
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
function awQueueSql(result, state) {
  var q = result.audio_wait;
  if (!q || !q.first_seen_at) return '';
  function quote(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }
  var id = Number(result.deal_id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Некорректная сделка очереди');
  return 'INSERT INTO public.lost_audio_wait (deal_id, lose_date, state, first_seen_at, deadline_at, next_check_at, pending_calls, observations, silent, screenshots, checks, updated_at) VALUES ('
    + id + ', ' + quote(q.lose_date) + ', ' + quote(state) + ', ' + quote(q.first_seen_at) + ', ' + quote(q.deadline_at) + ', ' + quote(q.next_check_at)
    + ', ' + quote(JSON.stringify(q.pending_calls)) + '::jsonb, ' + quote(JSON.stringify(q.observations)) + '::jsonb, '
    + (result.silent === true ? 'TRUE' : 'FALSE') + ', ' + (result.audio_wait_screenshots === true ? 'TRUE' : 'FALSE') + ', 1, NOW()) '
    + 'ON CONFLICT (deal_id) DO UPDATE SET lose_date=EXCLUDED.lose_date, state=EXCLUDED.state, '
    + 'first_seen_at=EXCLUDED.first_seen_at, deadline_at=EXCLUDED.deadline_at, next_check_at=EXCLUDED.next_check_at, '
    + 'pending_calls=EXCLUDED.pending_calls, observations=EXCLUDED.observations, silent=EXCLUDED.silent, screenshots=EXCLUDED.screenshots, '
    + 'checks=lost_audio_wait.checks+1, lease_until=NULL, updated_at=NOW();';
}
