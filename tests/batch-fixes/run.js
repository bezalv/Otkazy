// Моки на мелочи пакетного прогона (prototype/lib/batch-fixes.js), этап 4.
//
// П.12: предыдущая стадия — перед переходом в отказ, а не перед «Приостановленными».
// П.12.11: дата в комментарии по Новосибирску.
// Истории стадий взяты из реальных сделок 123975, 124927, 122231.
//
// Запуск: node tests/batch-fixes/run.js
var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '..', '..', 'prototype', 'lib', 'batch-fixes.js'), 'utf8');
var L = new Function(src + '\nreturn { prevStageBeforeLose: prevStageBeforeLose, nskDateStr: nskDateStr, STAGE_NAMES: STAGE_NAMES };')();

var pass = 0, fail = 0;
function check(name, cond, hint) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (hint ? '\n       ' + hint : '')); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    'получил: ' + JSON.stringify(got) + '\n       ожидал:  ' + JSON.stringify(want));
}

function st(stage, time) { return { STAGE_ID: stage, CREATED_TIME: time }; }

// Старая логика — для сравнения, какой результат был до правки.
function staraya(hist) {
  var pauseDate = null, prevStageId = null;
  for (var h = 0; h < hist.length; h++) {
    if (hist[h].STAGE_ID === 'C23:UC_F0XO84') { if (!pauseDate) pauseDate = hist[h].CREATED_TIME; continue; }
    if (pauseDate && !prevStageId) { prevStageId = hist[h].STAGE_ID; break; }
  }
  return prevStageId;
}

console.log('=== Сделка 123975: паузы не было, перед отказом — подписание договора ===');
var h123975 = [
  st('C23:LOSE', '2026-09-23T12:00:08+03:00'),
  st('C23:UC_GDK5HI', '2026-09-18T15:36:20+03:00'),
  st('C23:FINAL_INVOICE', '2026-09-11T16:31:24+03:00'),
  st('C23:EXECUTING', '2026-09-10T05:00:04+03:00'),
  st('C23:PREPAYMENT_INVOIC', '2026-09-07T10:09:53+03:00'),
  st('C23:PREPARATION', '2026-09-07T10:09:37+03:00'),
  st('C23:NEW', '2026-09-07T10:09:35+03:00')
];
var r1 = L.prevStageBeforeLose(h123975);
eq('стадия перед отказом', r1.previous_stage_id, 'C23:UC_GDK5HI');
eq('и её название из словаря', r1.previous_stage_name, 'Подписание договора и оплата');
eq('дата отказа', r1.lose_date, '2026-09-23T12:00:08+03:00');
eq('паузы не было', r1.pause_date, null);
eq('записей истории', r1.stage_history_count, 7);
eq('до правки было пусто', staraya(h123975), null);

console.log('\n=== Сделка 122231: возврат на стадию, перед отказом — согласование КП ===');
var h122231 = [
  st('C23:LOSE', '2026-09-07T07:33:45+03:00'),
  st('C23:FINAL_INVOICE', '2026-08-19T09:17:54+03:00'),
  st('C23:EXECUTING', '2026-08-19T05:00:04+03:00'),
  st('C23:PREPAYMENT_INVOIC', '2026-08-11T13:53:44+03:00'),
  st('C23:FINAL_INVOICE', '2026-08-11T13:21:12+03:00'),
  st('C23:PREPARATION', '2026-08-11T12:01:34+03:00'),
  st('C23:NEW', '2026-08-11T12:01:33+03:00')
];
var r2 = L.prevStageBeforeLose(h122231);
eq('стадия перед отказом', r2.previous_stage_id, 'C23:FINAL_INVOICE');
eq('название', r2.previous_stage_name, 'Презентация и согласование КП');
eq('до правки было пусто', staraya(h122231), null);

console.log('\n=== Сделка с паузой: берём стадию перед отказом, не перед паузой ===');
var hPauza = [
  st('C23:LOSE', '2026-09-20T10:00:00+03:00'),
  st('C23:PREPAYMENT_INVOIC', '2026-09-15T10:00:00+03:00'),
  st('C23:UC_F0XO84', '2026-08-01T10:00:00+03:00'),
  st('C23:FINAL_INVOICE', '2026-07-20T10:00:00+03:00'),
  st('C23:NEW', '2026-07-01T10:00:00+03:00')
];
var r3 = L.prevStageBeforeLose(hPauza);
eq('перед отказом — замер', r3.previous_stage_id, 'C23:PREPAYMENT_INVOIC');
eq('дата паузы по-прежнему считается', r3.pause_date, '2026-08-01T10:00:00+03:00');
eq('старая логика дала бы стадию перед паузой', staraya(hPauza), 'C23:FINAL_INVOICE');

console.log('\n=== Пограничные ===');
eq('история пуста', L.prevStageBeforeLose([]).previous_stage_id, null);
eq('null вместо истории', L.prevStageBeforeLose(null).stage_history_count, 0);
eq('отказа в истории нет — стадии нет',
  L.prevStageBeforeLose([st('C23:NEW', '2026-01-01T00:00:00+03:00')]).previous_stage_id, null);
eq('только отказ, до него ничего',
  L.prevStageBeforeLose([st('C23:LOSE', '2026-01-01T00:00:00+03:00')]).previous_stage_id, null);

// Повторный уход в отказ: берём стадию перед ПОСЛЕДНИМ переходом.
var hDvaOtkaza = [
  st('C23:LOSE', '2026-09-20T10:00:00+03:00'),
  st('C23:EXECUTING', '2026-09-10T10:00:00+03:00'),
  st('C23:LOSE', '2026-08-01T10:00:00+03:00'),
  st('C23:NEW', '2026-07-01T10:00:00+03:00')
];
var r4 = L.prevStageBeforeLose(hDvaOtkaza);
eq('стадия перед последним отказом', r4.previous_stage_id, 'C23:EXECUTING');
eq('дата отказа — последняя', r4.lose_date, '2026-09-20T10:00:00+03:00');

eq('неизвестная стадия отдаётся кодом как есть',
  L.prevStageBeforeLose([st('C23:LOSE', 'x'), st('C23:UC_NEWSTAGE', 'y')]).previous_stage_name, 'C23:UC_NEWSTAGE');
eq('словарь стадий полный', Object.keys(L.STAGE_NAMES).length, 9);

console.log('\n=== П.13: сборка UTM на реальных значениях из Битрикса ===');
// Слепок двух звеньев цепочки: как «Обработать 1 сделку» кладёт поля сделки и как
// «Подготовить SQL» их экранирует. Значения взяты из crm.deal.get по сделкам в отказе.
function sborDealData(deal) {
  return {
    utm_source: deal.UTM_SOURCE || null,
    utm_medium: deal.UTM_MEDIUM || null,
    utm_campaign: deal.UTM_CAMPAIGN || null
  };
}
function esc(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number') return String(val);
  return "'" + String(val).replace(/'/g, "''").replace(/\0/g, '') + "'";
}
function escOrNull(val) {
  if (val === null || val === undefined || val === '' || val === 'null' || val === 'undefined') return 'NULL';
  return esc(val);
}
function utmFragment(deal) {
  var dd = sborDealData(deal);
  return escOrNull(dd.utm_source) + ', ' + escOrNull(dd.utm_medium) + ', ' + escOrNull(dd.utm_campaign);
}

// 125484: источник 2gis, карточка организации.
eq('2gis / organic / kartochka',
  utmFragment({ UTM_SOURCE: '2gis', UTM_MEDIUM: 'organic', UTM_CAMPAIGN: 'kartochka' }),
  "'2gis', 'organic', 'kartochka'");
// 125219: платный поиск Яндекса.
eq('yandex / cpc / poisk-brand',
  utmFragment({ UTM_SOURCE: 'yandex', UTM_MEDIUM: 'cpc', UTM_CAMPAIGN: 'poisk-brand' }),
  "'yandex', 'cpc', 'poisk-brand'");
// 125348: кампания приходит строкой «(undefined)» — это значение, а не отсутствие данных.
eq('«(undefined)» сохраняется как есть',
  utmFragment({ UTM_SOURCE: '2gis', UTM_MEDIUM: '2Gis', UTM_CAMPAIGN: '(undefined)' }),
  "'2gis', '2Gis', '(undefined)'");
// 125384: «(none)» — тоже значение.
eq('«(none)» сохраняется',
  utmFragment({ UTM_SOURCE: 'yandex', UTM_MEDIUM: 'organic', UTM_CAMPAIGN: '(none)' }),
  "'yandex', 'organic', '(none)'");
// 124927: в Битриксе UTM пустые (обратный звонок с сайта) — в базу идут NULL, и это верно.
eq('все поля null — три NULL',
  utmFragment({ UTM_SOURCE: null, UTM_MEDIUM: null, UTM_CAMPAIGN: null }), 'NULL, NULL, NULL');
eq('полей нет вовсе', utmFragment({}), 'NULL, NULL, NULL');
eq('пустые строки — тоже NULL',
  utmFragment({ UTM_SOURCE: '', UTM_MEDIUM: '', UTM_CAMPAIGN: '' }), 'NULL, NULL, NULL');
eq('частично заполнено',
  utmFragment({ UTM_SOURCE: 'vk', UTM_MEDIUM: null, UTM_CAMPAIGN: 'autumn' }), "'vk', NULL, 'autumn'");
// Апостроф в метке не должен ломать SQL.
eq('апостроф экранируется',
  utmFragment({ UTM_SOURCE: "o'key", UTM_MEDIUM: 'cpc', UTM_CAMPAIGN: 'x' }), "'o''key', 'cpc', 'x'");
check('строка «null» от Битрикса трактуется как отсутствие',
  utmFragment({ UTM_SOURCE: 'null', UTM_MEDIUM: 'cpc', UTM_CAMPAIGN: 'x' }).indexOf('NULL,') === 0);

console.log('\n=== П.12.11: дата по Новосибирску ===');
// 02.10.2026 23:30 UTC — это уже 03.10 в Новосибирске.
eq('ночь по UTC — следующий день в НСК',
  L.nskDateStr(Date.UTC(2026, 9, 2, 23, 30)), '03.10.2026 06:30');
eq('полдень по UTC', L.nskDateStr(Date.UTC(2026, 9, 3, 12, 0)), '03.10.2026 19:00');
eq('ровно полночь НСК', L.nskDateStr(Date.UTC(2026, 9, 2, 17, 0)), '03.10.2026 00:00');
eq('переход через месяц', L.nskDateStr(Date.UTC(2026, 8, 30, 18, 15)), '01.10.2026 01:15');
eq('переход через год', L.nskDateStr(Date.UTC(2026, 11, 31, 20, 5)), '01.01.2027 03:05');
eq('минуты и часы с ведущим нулём', L.nskDateStr(Date.UTC(2026, 9, 3, 1, 5)), '03.10.2026 08:05');
check('формат ДД.ММ.ГГГГ ЧЧ:ММ', /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/.test(L.nskDateStr(Date.UTC(2026, 9, 3, 12, 0))));

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
if (fail > 0) process.exit(1);
