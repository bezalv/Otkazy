// Моки на пропуск сделок-дублей (prototype/lib/duplicate-skip.js).
//
// Проверяется распознавание причины «Дубль» по идентификатору значения и по тексту,
// плюс что остальные причины из справочника Битрикса под правило не попадают.
//
// Запуск: node tests/duplicate-skip/run.js
var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '..', '..', 'prototype', 'lib', 'duplicate-skip.js'), 'utf8');
var L = new Function(src + '\nreturn { isDuplicateReason: isDuplicateReason, DUPLICATE_REASON_ID: DUPLICATE_REASON_ID, DUPLICATE_REASON_TEXT: DUPLICATE_REASON_TEXT };')();

var pass = 0, fail = 0;
function check(name, cond, hint) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (hint ? '\n       ' + hint : '')); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    'получил: ' + JSON.stringify(got) + '\n       ожидал:  ' + JSON.stringify(want));
}

console.log('=== По тексту причины ===');
check('«Дубль» как в справочнике', L.isDuplicateReason(null, 'Дубль'));
check('«дубль» строчными', L.isDuplicateReason(null, 'дубль'));
check('«ДУБЛЬ» прописными', L.isDuplicateReason(null, 'ДУБЛЬ'));
check('с пробелами по краям', L.isDuplicateReason(null, '  Дубль  '));
check('с переводом строки', L.isDuplicateReason(null, 'Дубль\n'));
check('с табуляцией', L.isDuplicateReason(null, '\tДубль\t'));

console.log('\n=== По идентификатору значения ===');
eq('идентификатор вынесен константой', L.DUPLICATE_REASON_ID, '3297');
check('строкой', L.isDuplicateReason('3297', ''));
check('числом', L.isDuplicateReason(3297, ''));
check('с пробелами', L.isDuplicateReason(' 3297 ', ''));
check('идентификатор есть, текста нет — всё равно дубль', L.isDuplicateReason('3297', null));
check('идентификатор дубля при чужом тексте — дубль',
  L.isDuplicateReason('3297', 'Переименовали значение'));
check('чужой идентификатор при тексте «Дубль» — всё равно дубль (значение пересоздали)',
  L.isDuplicateReason('9999', 'Дубль'));

console.log('\n=== Другие причины из справочника не трогаем ===');
// Весь список причин отказа, кроме «Дубль» — взят из crm.deal.userfield.list 06.10.2026.
var PROCHIE = [
  ['3991', 'Поиск застройщиков'], ['3957', 'Потенциальный дилер'], ['3419', 'Дорого'],
  ['3677', 'Отказ от замера'], ['3113', 'Не производим'], ['3115', 'Передумал/не актуально'],
  ['3415', 'Заявку не оставлял, остекление не интересует'], ['3119', 'Спам (банки, реклама, поставщики)'],
  ['3121', 'Не дозвонились/ не выходит на связь/игнор'], ['3123', 'Отказано заводом'],
  ['3125', 'Не устроили условия/сроки'], ['3127', 'Ошибся номером'],
  ['3129', 'Узнать информацию по заказу/ внести изменения в расчет'], ['3131', 'Дополнительный контакт'],
  ['3133', 'Сотрудник'], ['3173', 'Сервис'], ['3265', 'Готовые окна'], ['3357', 'Заказал у других'],
  ['3447', 'Бросает трубку'], ['3687', 'Потенциальный агент (сделок нет)'], ['3967', 'Передано в другой отдел']
];
var lozhnyh = 0;
PROCHIE.forEach(function (p) {
  if (L.isDuplicateReason(p[0], p[1])) { lozhnyh++; console.log('       ложное срабатывание: ' + p[1]); }
});
check('ни одна из 21 прочей причины не считается дублем', lozhnyh === 0);
eq('причин в проверке', PROCHIE.length, 21);

console.log('\n=== Пустая причина ===');
check('пустая строка', !L.isDuplicateReason(null, ''));
check('пробелы', !L.isDuplicateReason(null, '   '));
check('null и null', !L.isDuplicateReason(null, null));
check('undefined и undefined', !L.isDuplicateReason(undefined, undefined));
check('причины нет вовсе — сделку разбираем как обычно', !L.isDuplicateReason());

console.log('\n=== Похожие тексты дублем не считаются ===');
check('«Дубликат»', !L.isDuplicateReason(null, 'Дубликат'));
check('«Дубль сделки»', !L.isDuplicateReason(null, 'Дубль сделки'));
check('«не дубль»', !L.isDuplicateReason(null, 'не дубль'));
check('«Дублирование»', !L.isDuplicateReason(null, 'Дублирование'));
check('идентификатор как часть другого числа', !L.isDuplicateReason('32970', ''));
check('идентификатор с лишним символом', !L.isDuplicateReason('3297a', ''));

console.log('\n=== Что происходит со сделкой-дублем ===');
// Слепок развилки из «Обработать 1 сделку»: дубль не идёт ни в транскрипцию, ни в анализ.
function obrabotka(deal) {
  if (L.isDuplicateReason(deal.lose_reason_id, deal.lose_reason)) {
    return { status: 'skipped_duplicate', vyzyvali_analiz: false, pishem_kartochku: true, pishem_razbor: false };
  }
  return { status: 'processed', vyzyvali_analiz: true, pishem_kartochku: true, pishem_razbor: true };
}
var dubl = obrabotka({ lose_reason_id: '3297', lose_reason: 'Дубль' });
eq('статус', dubl.status, 'skipped_duplicate');
check('анализ не вызывается — денег не тратим', dubl.vyzyvali_analiz === false);
check('карточка в lost_deals пишется — видно, что сделка была', dubl.pishem_kartochku === true);
check('в lost_deal_analyses не пишем', dubl.pishem_razbor === false);
check('значит в lost_pipeline_attention не попадёт и ночной повтор не возьмёт', dubl.pishem_razbor === false);

var obychnaya = obrabotka({ lose_reason_id: '3419', lose_reason: 'Дорого' });
eq('обычная сделка разбирается как раньше', obychnaya.status, 'processed');
check('и анализ вызывается', obychnaya.vyzyvali_analiz === true);

console.log('\n=== Карточка дубля должна быть полной ===');
// Регрессия 06.10: первая версия отсечки стояла выше присвоения lose_date, поэтому в карточку
// уходил NULL и затирал уже записанную дату (так вышло на 125424). Теперь отсечка стоит после
// заполнения даты, а в SQL дата, days_in_lost и lead_id пишутся через COALESCE.
function kartochkaDublya(dealData) {
  // Слепок возврата из «Обработать 1 сделку» для дубля.
  return {
    _status: 'skipped_duplicate',
    deal_data: dealData,
    comm_stats: { total_events: 0, calls: 0, chat_messages: 0, tasks: 0 }
  };
}
var polnaya = kartochkaDublya({
  deal_id: 125424, title: 'Сделка', lose_reason_id: '3297', lose_reason: 'Дубль',
  lose_date: '2026-10-06T10:00:00+03:00', days_in_lost: 0,
  previous_stage_id: 'C23:EXECUTING', previous_stage_name: 'Расчет стоимости', stage_history_count: 5
});
check('в карточке есть lose_date', !!polnaya.deal_data.lose_date);
check('есть days_in_lost', polnaya.deal_data.days_in_lost !== undefined);
check('есть предыдущая стадия', polnaya.deal_data.previous_stage_name === 'Расчет стоимости');
check('есть история стадий', polnaya.deal_data.stage_history_count === 5);
check('коммуникации пустые — их не собирали', polnaya.comm_stats.total_events === 0);

// Слепок защиты в SQL: пустое значение не затирает заполненное.
function coalesce(novoe, staroe) { return (novoe === null || novoe === undefined) ? staroe : novoe; }
eq('пустая дата не затирает записанную', coalesce(null, '2026-10-06'), '2026-10-06');
eq('новая дата перезаписывает', coalesce('2026-10-07', '2026-10-06'), '2026-10-07');
eq('пустой days_in_lost не затирает', coalesce(undefined, 3), 3);
eq('пустой lead_id не затирает', coalesce(null, 308695), 308695);
eq('обе пустые — остаётся пусто', coalesce(null, null), null);

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
if (fail > 0) process.exit(1);
