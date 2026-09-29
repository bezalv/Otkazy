// Моки к задаче «b4.5: метрики хода продажи на дату отказа».
// Код нод берётся из резервной копии воркфлоу, патчи — из patches.json (те же уйдут в n8n).
var fs = require('fs');
var path = require('path');
var fixtures = require('./fixtures.js');

var BACKUP_DIR = path.join(__dirname, '..', '..', 'tmp', 'backup', 'GLQ2iuzRaCQZM7QU');
var PATCHES = path.join(__dirname, 'patches.json');
// Код нод лежит рядом отдельными файлами: так в копии нечему сломаться при экранировании.
var NODE_FILES = {
  'b4.5 Comm Analytics': 'b45-comm-analytics.js',
  'Пропуск (нет аудио)': 'propusk-net-audio.js',
  'agent-judge-parse': 'agent-judge-parse.js'
};

var pass = 0, fail = 0;
function check(name, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       получил: ' + JSON.stringify(got) + '\n       ожидал:  ' + JSON.stringify(want)); }
}

// ── загрузка кода нод ────────────────────────────────────────
function nodeCode(_wf, name) {
  var file = NODE_FILES[name];
  if (!file) throw new Error('нет файла для ноды: ' + name);
  var full = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full)) {
    console.error('Нет резервной копии ноды: ' + full);
    process.exit(2);
  }
  var text = fs.readFileSync(full, 'utf8').split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
  if (text.charAt(text.length - 1) === String.fromCharCode(10)) text = text.slice(0, -1);
  return text;
}
function applyPatches(code, patches, nodeName) {
  var applied = [];
  patches.filter(function (p) { return p.node === nodeName; }).forEach(function (p) {
    var count = code.split(p.find).length - 1;
    if (count !== 1) throw new Error('патч ' + p.id + ': find встречается ' + count + ' раз (нужно ровно 1)');
    code = code.replace(p.find, p.replace);
    applied.push(p.id);
  });
  return { code: code, applied: applied };
}

// ── запуск кода ноды с подменой «сегодня» ────────────────────
function runNode(code, input, fakeNowIso) {
  var RealDate = Date;
  function FakeDate(a, b, c, d, e, f, g) {
    if (!(this instanceof FakeDate)) return new RealDate(fakeNowIso).toString();
    if (arguments.length === 0) return new RealDate(fakeNowIso);
    if (arguments.length === 1) return new RealDate(a);
    return new RealDate(a, b, c, d, e, f, g);
  }
  FakeDate.now = function () { return new RealDate(fakeNowIso).getTime(); };
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;

  var fn = new Function('$input', 'Date', '"use strict";' + code);
  var items = [{ json: input }];
  return fn({ first: function () { return items[0]; }, all: function () { return items; } }, FakeDate)[0].json;
}

var wf = null;
var patches = JSON.parse(fs.readFileSync(PATCHES, 'utf8'));

console.log('=== Патчи применяются, find уникален ===');
var b45before = nodeCode(wf, 'b4.5 Comm Analytics');
var b45res;
try {
  b45res = applyPatches(b45before, patches, 'b4.5 Comm Analytics');
  pass++; console.log('  ok   b4.5: ' + b45res.applied.length + ' патчей (' + b45res.applied.join(', ') + ')');
} catch (e) { fail++; console.log('  FAIL b4.5: ' + e.message); process.exit(1); }
var b45after = b45res.code;

try {
  var skipRes = applyPatches(nodeCode(wf, 'Пропуск (нет аудио)'), patches, 'Пропуск (нет аудио)');
  pass++; console.log('  ok   Пропуск (нет аудио): ' + skipRes.applied.join(', '));
  var hasLose = skipRes.code.indexOf("'lose_date'") !== -1;
  check('    в passFields «Пропуска» появился lose_date', hasLose, true);
} catch (e) { fail++; console.log('  FAIL Пропуск: ' + e.message); }

try {
  var jpRes = applyPatches(nodeCode(wf, 'agent-judge-parse'), patches, 'agent-judge-parse');
  pass++; console.log('  ok   agent-judge-parse: ' + jpRes.applied.join(', '));
  check('    в writer_input появился блок now', jpRes.code.indexOf('days_since_last_contact') !== -1, true);
  check('    в facts_packet Judge блок now не попал', jpRes.code.indexOf('facts_packet.now') === -1, true);
} catch (e) { fail++; console.log('  FAIL agent-judge-parse: ' + e.message); }

// ── 1. Стабильность во времени ───────────────────────────────
var DAY_OF_LOSE = { deal124101: '2026-09-13T05:00:00Z', deal122693: '2026-08-26T08:00:00Z' };
var PLUS_30 = { deal124101: '2026-10-13T05:00:00Z', deal122693: '2026-09-25T08:00:00Z' };

console.log('\n=== 1. Два разных «сегодня»: метрики Judge не должны меняться ===');
Object.keys(fixtures.real).forEach(function (key) {
  var input = fixtures.real[key];
  var a = runNode(b45after, input, DAY_OF_LOSE[key]);
  var b = runNode(b45after, input, PLUS_30[key]);
  check(key + ': comm_analytics совпал целиком', JSON.stringify(a.comm_analytics) === JSON.stringify(b.comm_analytics), true);
  var diffKeys = Object.keys(a.comm_analytics).filter(function (k) {
    return JSON.stringify(a.comm_analytics[k]) !== JSON.stringify(b.comm_analytics[k]);
  });
  check(key + ': полей, меняющихся со временем, нет', diffKeys, []);
  check(key + ': days_since_lose в metrics отсутствует', a.comm_analytics.days_since_lose === undefined, true);

  // старый код для сравнения — доказательство проблемы
  var oa = runNode(b45before, input, DAY_OF_LOSE[key]);
  var ob = runNode(b45before, input, PLUS_30[key]);
  var oldDiff = Object.keys(oa.comm_analytics).filter(function (k) {
    return JSON.stringify(oa.comm_analytics[k]) !== JSON.stringify(ob.comm_analytics[k]);
  });
  console.log('       (старый код на тех же данных плыл по полям: ' + oldDiff.join(', ') + ')');
});

// ── 2. Ожидания задания по 124101 и 122693 ───────────────────
console.log('\n=== 2. Ожидания из задания ===');
var m124 = runNode(b45after, fixtures.real.deal124101, DAY_OF_LOSE.deal124101).comm_analytics;
check('124101: cutoff_source = lose_date', m124.cutoff_source, 'lose_date');
check('124101: cutoff_at = последнее событие 13.09 04:31:10', m124.cutoff_at, '2026-09-13T04:31:10.000Z');
check('124101: days_in_funnel_until_lose = 5', m124.days_in_funnel_until_lose, 5);
check('124101: last_contact_days_before_lose = 0', m124.last_contact_days_before_lose, 0);
check('124101: старых имён нет', [m124.days_in_funnel, m124.last_contact_days_ago], [undefined, undefined]);

var m122 = runNode(b45after, fixtures.real.deal122693, DAY_OF_LOSE.deal122693).comm_analytics;
check('122693: cutoff_source = lose_date', m122.cutoff_source, 'lose_date');
check('122693: отсечка не сдвинута (события раньше отказа)', m122.cutoff_at, '2026-08-26T07:14:24.000Z');
check('122693: days_in_funnel_until_lose = 7', m122.days_in_funnel_until_lose, 7);
check('122693: last_contact_days_before_lose = 2', m122.last_contact_days_before_lose, 2);

// ── 3. Крайние случаи ────────────────────────────────────────
console.log('\n=== 3. Крайние случаи ===');
var e = fixtures.edge;
var r1 = runNode(b45after, e.noLoseDate, '2026-09-20T10:00:00Z').comm_analytics;
check('нет lose_date → cutoff_source = last_event', r1.cutoff_source, 'last_event');
check('нет lose_date → отсечка = последнее событие', r1.cutoff_at, '2026-09-04T10:00:00.000Z');
check('нет lose_date → предупреждение в data_quality_warnings', r1.data_quality_warnings.some(function (w) { return w.indexOf('Cutoff by last_event') === 0; }), true);

var r2 = runNode(b45after, e.loseBeforeLastEvent, '2026-09-20T10:00:00Z').comm_analytics;
check('отказ раньше события → отсечка сдвинута на событие', r2.cutoff_at, '2026-09-08T12:00:00.000Z');
check('отказ раньше события → source остался lose_date', r2.cutoff_source, 'lose_date');
check('отказ раньше события → отрицательных дней нет', r2.last_contact_days_before_lose >= 0, true);

var r3 = runNode(b45after, e.noEvents, '2026-09-20T10:00:00Z').comm_analytics;
check('без событий → отсечка = lose_date', r3.cutoff_at, '2026-09-05T10:00:00.000Z');
check('без событий → last_contact null', r3.last_contact_days_before_lose, null);

var r4 = runNode(b45after, e.noEventsNoLose, '2026-09-20T10:00:00Z').comm_analytics;
check('без событий и без отказа → date_modify', r4.cutoff_source, 'date_modify');

var r5 = runNode(b45after, e.nothingAtAll, '2026-09-20T10:00:00Z').comm_analytics;
check('совсем пусто → now', r5.cutoff_source, 'now');
check('совсем пусто → предупреждение есть', r5.data_quality_warnings.some(function (w) { return w.indexOf('Cutoff by now') === 0; }), true);

var r6 = runNode(b45after, e.singleEvent, '2026-09-20T10:00:00Z').comm_analytics;
check('одно событие → считается', r6.cutoff_source, 'lose_date');
check('одно событие → funnel = 2', r6.days_in_funnel_until_lose, 2);

// ── 4. Регресс: что изменилось против старого кода ───────────
console.log('\n=== 4. Регресс на одном «сегодня» ===');
['deal124101', 'deal122693'].forEach(function (key) {
  var input = fixtures.real[key];
  var day = DAY_OF_LOSE[key];
  var oldA = runNode(b45before, input, day).comm_analytics;
  var newA = runNode(b45after, input, day).comm_analytics;
  var removed = Object.keys(oldA).filter(function (k) { return !(k in newA); });
  var added = Object.keys(newA).filter(function (k) { return !(k in oldA); });
  var changed = Object.keys(oldA).filter(function (k) {
    return (k in newA) && JSON.stringify(oldA[k]) !== JSON.stringify(newA[k]);
  });
  check(key + ': убраны ровно старые имена', removed.sort(), ['calls_last_successful_days_ago', 'chats_last_client_days_ago', 'chats_last_manager_days_ago', 'days_in_funnel', 'last_contact_days_ago'].sort());
  check(key + ': добавлены ровно новые', added.sort(), ['calls_last_successful_days_before_lose', 'chats_last_client_days_before_lose', 'chats_last_manager_days_before_lose', 'cutoff_at', 'cutoff_source', 'days_in_funnel_until_lose', 'last_contact_days_before_lose'].sort());
  check(key + ': прочие поля не тронуты', changed, []);
});

// ── 5. Блок now для Writer ───────────────────────────────────
console.log('\n=== 5. Блок now для Writer ===');
function writerNow(metrics, todayIso) {
  var cutoffTsW = metrics && metrics.cutoff_at ? new Date(metrics.cutoff_at).getTime() : null;
  var daysSinceLoseW = (cutoffTsW !== null && !isNaN(cutoffTsW)) ? Math.max(0, Math.round((new Date(todayIso).getTime() - cutoffTsW) / 86400000)) : null;
  var lastBeforeLoseW = (metrics && typeof metrics.last_contact_days_before_lose === 'number') ? metrics.last_contact_days_before_lose : null;
  var daysSinceLastContactW = (daysSinceLoseW !== null && lastBeforeLoseW !== null) ? daysSinceLoseW + lastBeforeLoseW : daysSinceLoseW;
  return { days_since_lose: daysSinceLoseW, days_since_last_contact: daysSinceLastContactW };
}
check('124101 в день отказа: 0 дней с отказа', writerNow(m124, '2026-09-13T05:00:00Z').days_since_lose, 0);
check('124101 через 30 дней: 30', writerNow(m124, '2026-10-13T05:00:00Z').days_since_lose, 30);
check('122693 через 30 дней: тишина 32 дня (30 + 2 до отказа)', writerNow(m122, '2026-09-25T08:00:00Z').days_since_last_contact, 32);
check('без last_contact → days_since_last_contact = days_since_lose', writerNow(r3, '2026-09-20T10:00:00Z').days_since_last_contact, writerNow(r3, '2026-09-20T10:00:00Z').days_since_lose);

// ── 6. analytics_text ────────────────────────────────────────
console.log('\n=== 6. Текст аналитики (для человека) ===');
var text124 = runNode(b45after, fixtures.real.deal124101, DAY_OF_LOSE.deal124101).analytics_text;
check('нет старой подписи "days ago"', text124.indexOf('days ago'), -1);
check('есть "days before lose"', text124.indexOf('days before lose') > 0, true);
check('есть строка Cutoff', text124.indexOf('Cutoff (deal closed):') > 0, true);
check('есть Days since lose', text124.indexOf('Days since lose (as of today):') > 0, true);

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
