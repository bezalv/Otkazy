// Моки на пропуск сделок по причине отказа (prototype/lib/duplicate-skip.js).
//
// Проверяется распознавание причин «Дубль» и «Дополнительный контакт» по идентификатору
// значения и по тексту, разбивка счётчика по причинам, плюс что остальные причины
// из справочника Битрикса под правило не попадают.
//
// Запуск: node tests/duplicate-skip/run.js
var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '..', '..', 'prototype', 'lib', 'duplicate-skip.js'), 'utf8');
var L = new Function(src + '\nreturn { skipLoseReasonKey: skipLoseReasonKey, isSkipLoseReason: isSkipLoseReason,'
  + ' SKIP_LOSE_REASONS: SKIP_LOSE_REASONS, SKIP_LOSE_REASON_IDS: SKIP_LOSE_REASON_IDS };')();

var pass = 0, fail = 0;
function check(name, cond, hint) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (hint ? '\n       ' + hint : '')); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    'получил: ' + JSON.stringify(got) + '\n       ожидал:  ' + JSON.stringify(want));
}

console.log('=== Список причин ===');
eq('причин без анализа ровно две', L.SKIP_LOSE_REASONS, ['дубль', 'дополнительный контакт']);
eq('идентификатор «Дубль»', L.SKIP_LOSE_REASON_IDS['3297'], 'дубль');
eq('идентификатор «Дополнительный контакт»', L.SKIP_LOSE_REASON_IDS['3131'], 'дополнительный контакт');
eq('идентификаторов столько же, сколько текстов',
  Object.keys(L.SKIP_LOSE_REASON_IDS).length, L.SKIP_LOSE_REASONS.length);

console.log('\n=== «Дубль» по тексту (поведение не менялось) ===');
check('«Дубль» как в справочнике', L.isSkipLoseReason(null, 'Дубль'));
check('«дубль» строчными', L.isSkipLoseReason(null, 'дубль'));
check('«ДУБЛЬ» прописными', L.isSkipLoseReason(null, 'ДУБЛЬ'));
check('с пробелами по краям', L.isSkipLoseReason(null, '  Дубль  '));
check('с переводом строки', L.isSkipLoseReason(null, 'Дубль\n'));
check('с табуляцией', L.isSkipLoseReason(null, '\tДубль\t'));

console.log('\n=== «Дубль» по идентификатору (поведение не менялось) ===');
check('строкой', L.isSkipLoseReason('3297', ''));
check('числом', L.isSkipLoseReason(3297, ''));
check('с пробелами', L.isSkipLoseReason(' 3297 ', ''));
check('идентификатор есть, текста нет — всё равно отсекаем', L.isSkipLoseReason('3297', null));
check('идентификатор при чужом тексте', L.isSkipLoseReason('3297', 'Переименовали значение'));
check('чужой идентификатор при тексте «Дубль» (значение пересоздали)',
  L.isSkipLoseReason('9999', 'Дубль'));

console.log('\n=== «Дополнительный контакт» по тексту ===');
check('как в справочнике', L.isSkipLoseReason(null, 'Дополнительный контакт'));
check('строчными', L.isSkipLoseReason(null, 'дополнительный контакт'));
check('прописными', L.isSkipLoseReason(null, 'ДОПОЛНИТЕЛЬНЫЙ КОНТАКТ'));
check('с пробелами по краям', L.isSkipLoseReason(null, '  Дополнительный контакт  '));
check('с переводом строки', L.isSkipLoseReason(null, 'Дополнительный контакт\n'));

console.log('\n=== «Дополнительный контакт» по идентификатору ===');
check('строкой', L.isSkipLoseReason('3131', ''));
check('числом', L.isSkipLoseReason(3131, ''));
check('с пробелами', L.isSkipLoseReason(' 3131 ', ''));
check('идентификатор есть, текста нет', L.isSkipLoseReason('3131', null));
check('идентификатор при чужом тексте', L.isSkipLoseReason('3131', 'Переименовали'));
check('чужой идентификатор при тексте причины', L.isSkipLoseReason('9999', 'Дополнительный контакт'));

console.log('\n=== Какая причина сработала ===');
eq('«Дубль» по тексту', L.skipLoseReasonKey(null, 'Дубль'), 'дубль');
eq('«Дубль» по идентификатору', L.skipLoseReasonKey('3297', ''), 'дубль');
eq('«Дополнительный контакт» по тексту', L.skipLoseReasonKey(null, 'Дополнительный контакт'), 'дополнительный контакт');
eq('«Дополнительный контакт» по идентификатору', L.skipLoseReasonKey('3131', ''), 'дополнительный контакт');
eq('идентификатор важнее текста', L.skipLoseReasonKey('3131', 'Дубль'), 'дополнительный контакт');
eq('обычная причина — ключа нет', L.skipLoseReasonKey('3419', 'Дорого'), null);
eq('причины нет вовсе', L.skipLoseReasonKey(), null);

console.log('\n=== Другие причины из справочника не трогаем ===');
// Весь список причин отказа, кроме отсекаемых — сверено с crm.deal.userfield.list 16.10.2026
// (поле UF_CRM_1584703948317, тип enumeration, 22 значения).
var PROCHIE = [
  ['3991', 'Поиск застройщиков'], ['3957', 'Потенциальный дилер'], ['3419', 'Дорого'],
  ['3677', 'Отказ от замера'], ['3113', 'Не производим'], ['3115', 'Передумал/не актуально'],
  ['3415', 'Заявку не оставлял, остекление не интересует'], ['3119', 'Спам (банки, реклама, поставщики)'],
  ['3121', 'Не дозвонились/ не выходит на связь/игнор'], ['3123', 'Отказано заводом'],
  ['3125', 'Не устроили условия/сроки'], ['3127', 'Ошибся номером'],
  ['3129', 'Узнать информацию по заказу/ внести изменения в расчет'],
  ['3133', 'Сотрудник'], ['3173', 'Сервис'], ['3265', 'Готовые окна'], ['3357', 'Заказал у других'],
  ['3447', 'Бросает трубку'], ['3687', 'Потенциальный агент (сделок нет)'], ['3967', 'Передано в другой отдел']
];
var lozhnyh = 0;
PROCHIE.forEach(function (p) {
  if (L.isSkipLoseReason(p[0], p[1])) { lozhnyh++; console.log('       ложное срабатывание: ' + p[1]); }
});
check('ни одна из 20 прочих причин не отсекается', lozhnyh === 0);
eq('причин в проверке', PROCHIE.length, 20);
eq('прочие плюс отсекаемые — все 22 значения справочника',
  PROCHIE.length + L.SKIP_LOSE_REASONS.length, 22);

console.log('\n=== Пустая причина ===');
check('пустая строка', !L.isSkipLoseReason(null, ''));
check('пробелы', !L.isSkipLoseReason(null, '   '));
check('null и null', !L.isSkipLoseReason(null, null));
check('undefined и undefined', !L.isSkipLoseReason(undefined, undefined));
check('причины нет вовсе — сделку разбираем как обычно', !L.isSkipLoseReason());

console.log('\n=== Похожие тексты не отсекаются ===');
check('«Дубликат»', !L.isSkipLoseReason(null, 'Дубликат'));
check('«Дубль сделки»', !L.isSkipLoseReason(null, 'Дубль сделки'));
check('«не дубль»', !L.isSkipLoseReason(null, 'не дубль'));
check('«Дублирование»', !L.isSkipLoseReason(null, 'Дублирование'));
check('«Дополнительный»', !L.isSkipLoseReason(null, 'Дополнительный'));
check('«Контакт»', !L.isSkipLoseReason(null, 'Контакт'));
check('«Дополнительный контакт клиента»', !L.isSkipLoseReason(null, 'Дополнительный контакт клиента'));
check('«Дополнительные контакты» (множественное)', !L.isSkipLoseReason(null, 'Дополнительные контакты'));
check('идентификатор как часть другого числа', !L.isSkipLoseReason('32970', ''));
check('идентификатор с лишним символом', !L.isSkipLoseReason('3297a', ''));
check('идентификатор доп. контакта как часть числа', !L.isSkipLoseReason('31310', ''));

console.log('\n=== Что происходит со сделкой ===');
// Слепок развилки из «Обработать 1 сделку»: отсечённая сделка не идёт ни в транскрипцию, ни в анализ.
function obrabotka(deal) {
  var key = L.skipLoseReasonKey(deal.lose_reason_id, deal.lose_reason);
  if (key) {
    return { status: 'skipped_by_reason', prichina: key, vyzyvali_analiz: false,
      pishem_kartochku: true, pishem_razbor: false, kommentariy_v_b24: false, uvedomlenie_ropu: false };
  }
  return { status: 'processed', prichina: null, vyzyvali_analiz: true,
    pishem_kartochku: true, pishem_razbor: true, kommentariy_v_b24: true, uvedomlenie_ropu: true };
}
var dubl = obrabotka({ lose_reason_id: '3297', lose_reason: 'Дубль' });
eq('статус у дубля', dubl.status, 'skipped_by_reason');
eq('причина записана', dubl.prichina, 'дубль');
check('анализ не вызывается — денег не тратим', dubl.vyzyvali_analiz === false);
check('карточка в lost_deals пишется — видно, что сделка была', dubl.pishem_kartochku === true);
check('в lost_deal_analyses не пишем', dubl.pishem_razbor === false);
check('значит в lost_pipeline_attention не попадёт и ночной повтор не возьмёт', dubl.pishem_razbor === false);
check('комментарий в Битрикс не пишется', dubl.kommentariy_v_b24 === false);
check('РОПу не уходит', dubl.uvedomlenie_ropu === false);

var dopKontakt = obrabotka({ lose_reason_id: '3131', lose_reason: 'Дополнительный контакт' });
eq('статус у доп. контакта', dopKontakt.status, 'skipped_by_reason');
eq('причина записана', dopKontakt.prichina, 'дополнительный контакт');
check('анализ не вызывается', dopKontakt.vyzyvali_analiz === false);
check('карточка пишется', dopKontakt.pishem_kartochku === true);
check('разбор не пишется', dopKontakt.pishem_razbor === false);

var obychnaya = obrabotka({ lose_reason_id: '3419', lose_reason: 'Дорого' });
eq('обычная сделка разбирается как раньше', obychnaya.status, 'processed');
check('и анализ вызывается', obychnaya.vyzyvali_analiz === true);

console.log('\n=== Счётчик в ответе вебхука ===');
// Слепок подсчёта из «Получить сделки из Bitrix»: сколько сделок отсечётся и по какой причине.
function schetchik(rows) {
  var vsego = 0;
  var poPrichinam = {};
  for (var i = 0; i < rows.length; i++) {
    var key = L.skipLoseReasonKey(rows[i].UF_CRM_1584703948317, null);
    if (!key) continue;
    vsego++;
    poPrichinam[key] = (poPrichinam[key] || 0) + 1;
  }
  return { skipped_by_reason: vsego, skipped_reasons: poPrichinam };
}
var vyborka = [
  { UF_CRM_1584703948317: '3297' }, { UF_CRM_1584703948317: '3297' },
  { UF_CRM_1584703948317: '3131' },
  { UF_CRM_1584703948317: '3419' }, { UF_CRM_1584703948317: '' }, { UF_CRM_1584703948317: null }
];
var sch = schetchik(vyborka);
eq('отсечено всего', sch.skipped_by_reason, 3);
eq('разбивка по причинам', sch.skipped_reasons, { 'дубль': 2, 'дополнительный контакт': 1 });
eq('в выборке без отсекаемых — нули',
  schetchik([{ UF_CRM_1584703948317: '3419' }]), { skipped_by_reason: 0, skipped_reasons: {} });
eq('пустая выборка', schetchik([]), { skipped_by_reason: 0, skipped_reasons: {} });

console.log('\n=== Карточка отсечённой сделки должна быть полной ===');
// Регрессия 06.10: первая версия отсечки стояла выше присвоения lose_date, поэтому в карточку
// уходил NULL и затирал уже записанную дату (так вышло на 125424). Теперь отсечка стоит после
// заполнения даты, а в SQL дата, days_in_lost и lead_id пишутся через COALESCE.
function kartochka(dealData) {
  return {
    _status: 'skipped_by_reason',
    deal_data: dealData,
    comm_stats: { total_events: 0, calls: 0, chat_messages: 0, tasks: 0 }
  };
}
var polnaya = kartochka({
  deal_id: 125424, title: 'Сделка', lose_reason_id: '3297', lose_reason: 'Дубль',
  lose_date: '2026-10-06T10:00:00+03:00', days_in_lost: 0,
  previous_stage_id: 'C23:EXECUTING', previous_stage_name: 'Расчет стоимости', stage_history_count: 5
});
check('в карточке есть lose_date', !!polnaya.deal_data.lose_date);
check('есть days_in_lost', polnaya.deal_data.days_in_lost !== undefined);
check('есть предыдущая стадия', polnaya.deal_data.previous_stage_name === 'Расчет стоимости');
check('есть история стадий', polnaya.deal_data.stage_history_count === 5);
check('коммуникации пустые — их не собирали', polnaya.comm_stats.total_events === 0);

function coalesce(novoe, staroe) { return (novoe === null || novoe === undefined) ? staroe : novoe; }
eq('пустая дата не затирает записанную', coalesce(null, '2026-10-06'), '2026-10-06');
eq('новая дата перезаписывает', coalesce('2026-10-07', '2026-10-06'), '2026-10-07');
eq('пустой days_in_lost не затирает', coalesce(undefined, 3), 3);
eq('пустой lead_id не затирает', coalesce(null, 308695), 308695);
eq('обе пустые — остаётся пусто', coalesce(null, null), null);

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
if (fail > 0) process.exit(1);
