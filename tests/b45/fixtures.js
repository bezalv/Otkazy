// Входы для ноды b4.5 (= выход «Блок 4»). Реальные сделки восстановлены из lost_deal_communications.
// Тексты реплик не нужны — b4.5 считает только даты, направления и длительности.

function call(date, startEnd, opts) {
  var o = opts || {};
  return {
    type: 'call', date: date, direction: o.direction || 'outgoing',
    duration_start: startEnd[0], duration_end: startEnd[1],
    _needs_transcription: o.audio !== false,
    _transcribed: o.transcribed === true,
    transcript: o.transcribed ? 'Менеджер: ...\nКлиент: ...' : '',
    transcript_manager_text: o.transcribed ? '...' : '',
    transcript_client_text: o.transcribed ? '...' : ''
  };
}
function chat(date, dir, text, role) {
  return { type: 'chat', date: date, direction: dir, role: role || (dir === 'outgoing' ? 'Менеджер' : 'Клиент'),
           author_name: dir === 'outgoing' ? 'Юлия Тимкина' : 'Клиент', channel: 'WAZZUP: WhatsApp', text: text };
}
function comment(date, text) { return { type: 'comment', date: date, text: text }; }
function task(date, title) { return { type: 'task', date: date, title: title, status: '5' }; }

// ─────────────────────────────────────────────────────────────
// 124101 — ветка «Собрать итог» (есть звонок с аудио).
// Отказ 13.09 04:25:03, последнее событие — AI-комментарий 13.09 04:31:10 (на 6 минут позже).
var deal124101 = {
  deal_id: 124101,
  title: 'Сделка 124101',
  date_create: '2026-09-08T10:49:33Z',
  date_modify: '2026-09-13T04:25:03Z',
  lose_date: '2026-09-13T04:25:03Z',
  opportunity: 150000,
  pause_reason: 'Не указана',
  full_prompt_text: '=== КАРТОЧКА СДЕЛКИ ===\n\n=== ХРОНОЛОГИЧЕСКИЙ ЖУРНАЛ СОБЫТИЙ ===\n\n...',
  comm_stats: { total_events: 8, calls: 1, calls_with_audio: 1, comments: 3, chat_messages: 0, tasks: 4 },
  communications: [
    comment('2026-09-08T10:36:02Z', '2 окна теплые каркасный дом'),
    task('2026-09-08T10:49:35Z', 'Вам передана сделка'),
    comment('2026-09-08T13:14:45Z', '08.09 предварит.расчет'),
    task('2026-09-08T13:14:59Z', 'CRM: расчет'),
    call('2026-09-09T06:54:31Z', ['2026-09-09T06:54:31Z', '2026-09-09T06:56:34Z'], { transcribed: true }),
    task('2026-09-09T07:10:28Z', 'уточнить по решению'),
    task('2026-09-10T08:17:14Z', 'уточнить по решению'),
    comment('2026-09-13T04:31:10Z', '[B]:f09f948d: AI-анализ отказа[/B] (13.09.2026 11:31)')
  ]
};

// 122693 — ветка «Пропуск (нет аудио)»: звонков с записью нет, только чаты.
// Отказ 26.08 07:14:24, последнее событие 24.08 02:26:34 — отсечка НЕ сдвигается.
var deal122693 = {
  deal_id: 122693,
  title: 'Сделка 122693',
  date_create: '2026-08-19T06:12:29Z',
  date_modify: '2026-08-26T07:14:25Z',
  lose_date: '2026-08-26T07:14:24Z',
  opportunity: 48000,
  pause_reason: 'Не указана',
  full_prompt_text: '=== КАРТОЧКА СДЕЛКИ ===\n\n=== ХРОНОЛОГИЧЕСКИЙ ЖУРНАЛ СОБЫТИЙ ===\n\n...',
  comm_stats: { total_events: 17, calls: 0, calls_with_audio: 0, comments: 3, chat_messages: 10, tasks: 3 },
  communications: [
    comment('2026-08-19T06:11:22Z', '1 окно 1000*1400'),
    task('2026-08-19T06:45:21Z', 'CRM: сделать расчет'),
    chat('2026-08-20T03:06:08Z', 'outgoing', 'Марина, доброго дня! Отправляю расчет стоимости'),
    chat('2026-08-20T03:06:08Z', 'incoming', 'Обращение направлено на [USER=30213 REPLACE]Юлия[/USER]'),
    chat('2026-08-20T03:07:12Z', 'incoming', '[USER=30213 REPLACE]Юлия Тимкина[/USER] начал работу с диалогом'),
    comment('2026-08-20T03:07:35Z', '20.08 кп в чат'),
    task('2026-08-20T03:08:10Z', 'CRM: узнать что решила'),
    chat('2026-08-20T03:08:48Z', 'incoming', 'Обращение направлено на [USER=30213 REPLACE]Юлия[/USER]'),
    chat('2026-08-20T03:08:48Z', 'incoming', 'Здравствуйте. Спасибо.'),
    chat('2026-08-20T03:09:31Z', 'incoming', '[USER=30213 REPLACE]Юлия Тимкина[/USER] завершил диалог'),
    chat('2026-08-24T02:25:08Z', 'incoming', '[USER=30213 REPLACE]Юлия Тимкина[/USER] начал работу с диалогом'),
    chat('2026-08-24T02:25:58Z', 'outgoing', 'Марина, доброго дня! Ознакомились с расчетом?'),
    chat('2026-08-24T02:26:15Z', 'incoming', '[USER=30213 REPLACE]Юлия Тимкина[/USER] завершил диалог'),
    task('2026-08-24T02:26:34Z', 'CRM: записать на замер'),
    comment('2026-08-26T07:20:11Z', '[B]:f09f948d: AI-анализ отказа[/B] (26.08.2026 14:20)')
  ]
};

// ── крайние случаи ───────────────────────────────────────────
var noLoseDate = {
  deal_id: 900001, title: 'Без lose_date', date_create: '2026-09-01T08:00:00Z', date_modify: '2026-09-05T10:00:00Z',
  comm_stats: {}, full_prompt_text: '',
  communications: [
    call('2026-09-02T09:00:00Z', ['2026-09-02T09:00:00Z', '2026-09-02T09:03:00Z'], { transcribed: true }),
    chat('2026-09-04T10:00:00Z', 'incoming', 'Спасибо, подумаю')
  ]
};

var loseBeforeLastEvent = {
  deal_id: 900002, title: 'Отказ раньше последнего события', date_create: '2026-09-01T08:00:00Z',
  date_modify: '2026-09-10T10:00:00Z', lose_date: '2026-09-05T10:00:00Z',
  comm_stats: {}, full_prompt_text: '',
  communications: [
    chat('2026-09-02T09:00:00Z', 'outgoing', 'Расчёт во вложении'),
    chat('2026-09-03T09:00:00Z', 'incoming', 'Посмотрю'),
    comment('2026-09-08T12:00:00Z', 'клиент перезвонил после закрытия')
  ]
};

var noEvents = {
  deal_id: 900003, title: 'Без событий', date_create: '2026-09-01T08:00:00Z', date_modify: '2026-09-06T10:00:00Z',
  lose_date: '2026-09-05T10:00:00Z', comm_stats: {}, full_prompt_text: '', communications: []
};

var noEventsNoLose = {
  deal_id: 900004, title: 'Без событий и без отказа', date_create: '2026-09-01T08:00:00Z',
  date_modify: '2026-09-06T10:00:00Z', comm_stats: {}, full_prompt_text: '', communications: []
};

var nothingAtAll = {
  deal_id: 900005, title: 'Совсем пусто', comm_stats: {}, full_prompt_text: '', communications: []
};

var singleEvent = {
  deal_id: 900006, title: 'Одно событие', date_create: '2026-09-01T08:00:00Z', date_modify: '2026-09-03T10:00:00Z',
  lose_date: '2026-09-03T10:00:00Z', comm_stats: {}, full_prompt_text: '',
  communications: [call('2026-09-02T09:00:00Z', ['2026-09-02T09:00:00Z', '2026-09-02T09:00:03Z'], { audio: false })]
};

module.exports = {
  real: { deal124101: deal124101, deal122693: deal122693 },
  edge: {
    noLoseDate: noLoseDate, loseBeforeLastEvent: loseBeforeLastEvent, noEvents: noEvents,
    noEventsNoLose: noEventsNoLose, nothingAtAll: nothingAtAll, singleEvent: singleEvent
  }
};
