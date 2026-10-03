// Моки на ночной повтор (prototype/lib/nightly-retry.js), часть А.
//
// Обе ветки: свежая сделка идёт живым разбором (silent: false), старая — тихим (silent: true).
// Плюс границы порога, отсутствие даты, деление по номеру попытки и реальная очередь на 03.10.
//
// Запуск: node tests/nightly-retry/run.js
var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '..', '..', 'prototype', 'lib', 'nightly-retry.js'), 'utf8');
var L = new Function(src + '\nreturn { nightlyIsFresh: nightlyIsFresh, nightlyBatches: nightlyBatches, NIGHTLY_FRESH_DAYS: NIGHTLY_FRESH_DAYS, NIGHTLY_MAX_DEALS: NIGHTLY_MAX_DEALS };')();

var pass = 0, fail = 0;
function check(name, cond, hint) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (hint ? '\n       ' + hint : '')); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    'получил: ' + JSON.stringify(got) + '\n       ожидал:  ' + JSON.stringify(want));
}

// Опорная точка: 03.10.2026, 04:00 по Новосибирску — время запуска повтора.
var NOW = new Date('2026-10-03T04:00:00+07:00').getTime();
function dnyNazad(d) { return new Date(NOW - d * 86400000).toISOString(); }

console.log('=== Порог свежести ===');
eq('порог вынесен константой', L.NIGHTLY_FRESH_DAYS, 7);
check('закрыта сегодня — свежая', L.nightlyIsFresh(dnyNazad(0), NOW));
check('закрыта вчера — свежая', L.nightlyIsFresh(dnyNazad(1), NOW));
check('шесть дней — свежая', L.nightlyIsFresh(dnyNazad(6), NOW));
check('ровно семь дней — ещё свежая', L.nightlyIsFresh(dnyNazad(7), NOW));
check('восемь дней — уже нет', !L.nightlyIsFresh(dnyNazad(8), NOW));
check('месяц — нет', !L.nightlyIsFresh(dnyNazad(30), NOW));

console.log('\n=== Даты нет или она битая — считаем старой ===');
check('null', !L.nightlyIsFresh(null, NOW));
check('пустая строка', !L.nightlyIsFresh('', NOW));
check('undefined', !L.nightlyIsFresh(undefined, NOW));
check('мусор вместо даты', !L.nightlyIsFresh('не дата', NOW));
// 120271: разбор упал по таймауту до записи в lost_deals, поэтому lose_date пустой.
check('сделка без записи в lost_deals уходит тихо',
  L.nightlyBatches([{ deal_id: 120271, lose_date: null, next_is_last: false }], NOW)[0].silent === true);

console.log('\n=== Свежая сделка: живой разбор ===');
var zhivaya = L.nightlyBatches([{ deal_id: 125900, lose_date: dnyNazad(2), next_is_last: false }], NOW);
eq('одна партия', zhivaya.length, 1);
check('silent выключен — уведомления уйдут', zhivaya[0].silent === false);
check('попытка не последняя', zhivaya[0].last_attempt === false);
eq('сделка в партии', zhivaya[0].deal_ids, [125900]);

console.log('\n=== Старая сделка: тихий разбор ===');
var staraya = L.nightlyBatches([{ deal_id: 115963, lose_date: '2026-07-24', next_is_last: false }], NOW);
check('silent включён — в карточку и РОПам ничего', staraya[0].silent === true);
check('разбор всё равно идёт', staraya[0].deal_ids.length === 1);

console.log('\n=== Деление по номеру попытки ===');
var smesh = L.nightlyBatches([
  { deal_id: 1, lose_date: dnyNazad(1), next_is_last: false },
  { deal_id: 2, lose_date: dnyNazad(3), next_is_last: true },
  { deal_id: 3, lose_date: dnyNazad(40), next_is_last: false },
  { deal_id: 4, lose_date: dnyNazad(90), next_is_last: true }
], NOW);
eq('четыре партии', smesh.length, 4);
eq('порядок: сначала живые', smesh.map(function (b) { return b._partiya; }),
  ['live-normal', 'live-last', 'quiet-normal', 'quiet-last']);
eq('живая обычная', [smesh[0].deal_ids, smesh[0].silent, smesh[0].last_attempt], [[1], false, false]);
eq('живая последняя', [smesh[1].deal_ids, smesh[1].silent, smesh[1].last_attempt], [[2], false, true]);
eq('тихая обычная', [smesh[2].deal_ids, smesh[2].silent, smesh[2].last_attempt], [[3], true, false]);
eq('тихая последняя', [smesh[3].deal_ids, smesh[3].silent, smesh[3].last_attempt], [[4], true, true]);

console.log('\n=== Пустые партии не отправляются ===');
eq('очередь пуста — ни одной партии', L.nightlyBatches([], NOW), []);
eq('null вместо строк', L.nightlyBatches(null, NOW), []);
eq('строка без deal_id пропускается', L.nightlyBatches([{ lose_date: dnyNazad(1) }], NOW), []);
eq('deal_id нулевой пропускается', L.nightlyBatches([{ deal_id: 0, lose_date: dnyNazad(1) }], NOW), []);
var tolkoTihie = L.nightlyBatches([
  { deal_id: 10, lose_date: dnyNazad(50), next_is_last: false },
  { deal_id: 11, lose_date: dnyNazad(60), next_is_last: false }
], NOW);
eq('только тихие — одна партия', tolkoTihie.length, 1);
eq('и обе сделки в ней', tolkoTihie[0].deal_ids, [10, 11]);

console.log('\n=== Реальная очередь на 03.10.2026 ===');
// Ровно то, что лежит в lost_pipeline_attention: все три сделки старше 7 дней.
var ochered = L.nightlyBatches([
  { deal_id: 120271, lose_date: null, next_is_last: false },
  { deal_id: 107325, lose_date: '2026-06-03', next_is_last: false },
  { deal_id: 115963, lose_date: '2026-07-24', next_is_last: false }
], NOW);
eq('одна партия', ochered.length, 1);
check('и она тихая — уведомлений не будет', ochered[0].silent === true);
eq('все три сделки в ней', ochered[0].deal_ids, [120271, 107325, 115963]);
check('живых партий нет вовсе',
  ochered.filter(function (b) { return b.silent === false; }).length === 0);

console.log('\n=== Предохранитель на число сделок ===');
eq('лимит вынесен константой', L.NIGHTLY_MAX_DEALS, 20);

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
if (fail > 0) process.exit(1);
