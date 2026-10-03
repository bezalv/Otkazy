// Моки на уведомления РОПам (prototype/lib/rop-notify.js), пункт 15.
//
// Проверяется: когда уведомлять, что в тексте, как выглядит отметка доставки, и что повторный
// прогон с тем же вердиктом второго уведомления не даёт (слепок условий SQL-запроса claim).
//
// Запуск: node tests/rop-notify/run.js
var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '..', '..', 'prototype', 'lib', 'rop-notify.js'), 'utf8');
var L = new Function(src + '\nreturn { ROP_RECIPIENTS: ROP_RECIPIENTS, ropShouldNotify: ropShouldNotify, ropHeader: ropHeader, ropMessage: ropMessage, ropMark: ropMark };')();

var pass = 0, fail = 0;
function check(name, cond, hint) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (hint ? '\n       ' + hint : '')); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    'получил: ' + JSON.stringify(got) + '\n       ожидал:  ' + JSON.stringify(want));
}

console.log('=== Когда уведомлять ===');
check('неправомерен — да', L.ropShouldNotify('неправомерен', 'manager_dropped'));
check('неправомерен с любым классом — да', L.ropShouldNotify('неправомерен', 'competitor'));
check('правомерен по цене — да', L.ropShouldNotify('правомерен', 'price'));
check('правомерен, ушёл к конкуренту — нет', !L.ropShouldNotify('правомерен', 'competitor'));
check('правомерен, не актуально — нет', !L.ropShouldNotify('правомерен', 'no_need'));
check('недостаточно данных — нет', !L.ropShouldNotify('недостаточно_данных', 'other'));
check('вердикта нет — нет', !L.ropShouldNotify(null, null));
check('отсечка по порогу данных уведомления не даёт', !L.ropShouldNotify('недостаточно_данных', 'other'));
eq('получатели прежние', L.ROP_RECIPIENTS, [65, 26175, 19601]);

console.log('\n=== Текст уведомления ===');
var msg = L.ropMessage({
  verdict: 'неправомерен', closure: 'manager_dropped',
  deal_id: 124927, title: 'Окна в дом, Бердск', reason_short: 'закрыли при живом клиенте'
});
check('есть шапка про неправомерный отказ', msg.indexOf('Неправомерный отказ') !== -1);
check('есть номер сделки', msg.indexOf('#124927') !== -1);
check('есть название', msg.indexOf('Окна в дом, Бердск') !== -1);
check('есть подпись вердикта', msg.indexOf('закрыли при живом клиенте') !== -1);
check('есть ссылка на карточку', msg.indexOf('https://dinalnsk.bitrix24.ru/crm/deal/details/124927/') !== -1);
eq('строк в сообщении четыре', msg.split('\n').length, 4);

var msgPrice = L.ropMessage({ verdict: 'правомерен', closure: 'price', deal_id: 1, title: 'Т', reason_short: 'дорого' });
check('по цене — своя шапка', msgPrice.indexOf('Отказ по цене') !== -1);
check('и подсказка про спецпредложение', msgPrice.indexOf('спецпредложением') !== -1);
eq('там, где уведомлять не надо, текста нет',
  L.ropMessage({ verdict: 'правомерен', closure: 'competitor', deal_id: 1 }), '');
eq('пустой вход', L.ropMessage(null), '');

console.log('\n=== Отметка доставки ===');
var markOk = L.ropMark([
  { user_id: 65, ok: true }, { user_id: 26175, ok: true }, { user_id: 19601, ok: true }
], '2026-10-03T05:00:00.000Z');
eq('статус', markOk.status, 'ok');
eq('время отправки', markOk.sent_at, '2026-10-03T05:00:00.000Z');
eq('кому отправляли', markOk.recipients, [65, 26175, 19601]);
eq('кому дошло', markOk.delivered, [65, 26175, 19601]);
eq('ошибок нет', markOk.failed, []);

var markPart = L.ropMark([
  { user_id: 65, ok: true },
  { user_id: 26175, ok: false, error: 'HTTP 403: insufficient_scope' },
  { user_id: 19601, ok: true }
]);
eq('дошло не всем — статус всё равно ok', markPart.status, 'ok');
eq('дошло двоим', markPart.delivered, [65, 19601]);
eq('один в ошибках', markPart.failed.length, 1);
check('текст ошибки сохранён', /insufficient_scope/.test(markPart.failed[0].error));
eq('и его идентификатор', markPart.failed[0].user_id, 26175);

var markFail = L.ropMark([
  { user_id: 65, ok: false, error: 'ETIMEDOUT' },
  { user_id: 26175, ok: false, error: 'ETIMEDOUT' },
  { user_id: 19601, ok: false, error: 'ETIMEDOUT' }
]);
eq('никому не дошло — статус error', markFail.status, 'error');
eq('доставленных нет', markFail.delivered, []);
eq('все в ошибках', markFail.failed.length, 3);
check('длинная ошибка обрезается',
  L.ropMark([{ user_id: 1, ok: false, error: new Array(400).join('x') }]).failed[0].error.length <= 200);
eq('пустой список', L.ropMark([]).status, 'error');

console.log('\n=== Повторный прогон не шлёт второй раз ===');
// Слепок условий SQL-запроса notify-claim: он занимает право на отправку только если
// по этой сделке с этим же вердиктом ещё не было notification.status = 'ok'.
function claim(razbory, dealId, verdict, closure) {
  if (!L.ropShouldNotify(verdict, closure)) return null;
  var uzhe = (razbory || []).some(function (r) {
    return r.deal_id === dealId && r.verdict === verdict && r.notification_status === 'ok';
  });
  if (uzhe) return null;
  return { deal_id: dealId, verdict: verdict, closure: closure };
}

var istoriya = [{ deal_id: 124927, verdict: 'неправомерен', notification_status: 'ok' }];
check('первый прогон — отправляем', claim([], 124927, 'неправомерен', 'manager_dropped') !== null);
check('второй прогон с тем же вердиктом — молчим',
  claim(istoriya, 124927, 'неправомерен', 'manager_dropped') === null);
check('вердикт сменился — отправляем снова',
  claim(istoriya, 124927, 'правомерен', 'price') !== null);
check('другая сделка — отправляем',
  claim(istoriya, 999999, 'неправомерен', 'manager_dropped') !== null);
check('прошлая отправка упала (status=error) — пробуем снова',
  claim([{ deal_id: 124927, verdict: 'неправомерен', notification_status: 'error' }],
    124927, 'неправомерен', 'manager_dropped') !== null);
check('отметки нет вовсе — отправляем',
  claim([{ deal_id: 124927, verdict: 'неправомерен', notification_status: null }],
    124927, 'неправомерен', 'manager_dropped') !== null);
check('вердикт не из тех, что уведомляют — не отправляем даже без истории',
  claim([], 124927, 'правомерен', 'no_need') === null);
check('повтор по цене после успешной отправки по цене — молчим',
  claim([{ deal_id: 5, verdict: 'правомерен', notification_status: 'ok' }], 5, 'правомерен', 'price') === null);

console.log('\n=== Несколько строк по одной сделке ===');
// Уникальности по deal_id в lost_deal_analyses нет: каждый прогон добавляет новую строку
// (у 125336 и 123831 их по три). Поэтому claim ищет status='ok' по ВСЕМ строкам сделки,
// а не только по текущей — иначе повторный прогон слал бы уведомление снова.
// Слепок NOT EXISTS из notify-claim: условие по deal_id и вердикту, без привязки к id.
function claimPoVsemStrokam(stroki, dealId, verdict, closure) {
  if (!L.ropShouldNotify(verdict, closure)) return null;
  var uzhe = (stroki || []).some(function (s) {
    return s.deal_id === dealId && s.verdict === verdict && s.notification_status === 'ok';
  });
  return uzhe ? null : { deal_id: dealId, verdict: verdict };
}

// Три строки по сделке: отметка стоит на самой старой, текущая — третий прогон.
var tryStroki = [
  { id: 1, deal_id: 124927, verdict: 'неправомерен', notification_status: 'ok' },
  { id: 2, deal_id: 124927, verdict: 'неправомерен', notification_status: null },
  { id: 3, deal_id: 124927, verdict: 'неправомерен', notification_status: null }
];
check('вторая строка той же сделки, тот же вердикт — не шлём',
  claimPoVsemStrokam(tryStroki, 124927, 'неправомерен', 'manager_dropped') === null);
check('третий прогон тоже молчит',
  claimPoVsemStrokam(tryStroki.concat([{ id: 4, deal_id: 124927, verdict: 'неправомерен', notification_status: null }]),
    124927, 'неправомерен', 'manager_dropped') === null);
check('отметка на старой строке, а не на текущей — всё равно находим',
  claimPoVsemStrokam([
    { id: 1, deal_id: 5, verdict: 'правомерен', notification_status: 'ok' },
    { id: 2, deal_id: 5, verdict: 'правомерен', notification_status: null }
  ], 5, 'правомерен', 'price') === null);

check('другой вердикт в той же сделке — шлём',
  claimPoVsemStrokam(tryStroki, 124927, 'правомерен', 'price') !== null);
check('вердикт сменился обратно на прежний — молчим',
  claimPoVsemStrokam(tryStroki.concat([{ id: 4, deal_id: 124927, verdict: 'правомерен', notification_status: 'ok' }]),
    124927, 'неправомерен', 'manager_dropped') === null);
check('по второму вердикту тоже молчим после его отправки',
  claimPoVsemStrokam(tryStroki.concat([{ id: 4, deal_id: 124927, verdict: 'правомерен', notification_status: 'ok' }]),
    124927, 'правомерен', 'price') === null);

// Разборы до правки отметок не имеют вовсе — по ним уведомление уйдёт один раз, это нормально.
check('строки без отметки (разборы до правки) отправку не блокируют',
  claimPoVsemStrokam([
    { id: 1, deal_id: 7, verdict: 'неправомерен', notification_status: undefined },
    { id: 2, deal_id: 7, verdict: 'неправомерен', notification_status: null }
  ], 7, 'неправомерен', 'manager_dropped') !== null);
check('status=sending не считается доставкой — повтор возможен',
  claimPoVsemStrokam([{ id: 1, deal_id: 8, verdict: 'неправомерен', notification_status: 'sending' }],
    8, 'неправомерен', 'manager_dropped') !== null);
check('строки другой сделки не мешают',
  claimPoVsemStrokam([{ id: 1, deal_id: 999, verdict: 'неправомерен', notification_status: 'ok' }],
    124927, 'неправомерен', 'manager_dropped') !== null);

console.log('\n=== Порядок: сначала база, потом уведомление ===');
// Слепок порядка нод в пакете после правки.
var poryadok = ['Записать в Supabase', 'Разблокировать сделку', 'Собрать AI-комментарий',
  'Тихий режим?', 'B24: Добавить AI-комментарий в карточку', 'notify-claim', 'notify-needed?',
  'notify-rop', 'notify-mark'];
check('запись в базу раньше уведомления',
  poryadok.indexOf('Записать в Supabase') < poryadok.indexOf('notify-rop'));
check('комментарий в карточку раньше уведомления',
  poryadok.indexOf('B24: Добавить AI-комментарий в карточку') < poryadok.indexOf('notify-rop'));
check('отметка доставки после отправки',
  poryadok.indexOf('notify-mark') > poryadok.indexOf('notify-rop'));
check('проверка повтора до отправки',
  poryadok.indexOf('notify-claim') < poryadok.indexOf('notify-rop'));
check('тихий режим отсекает раньше уведомления',
  poryadok.indexOf('Тихий режим?') < poryadok.indexOf('notify-claim'));

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
if (fail > 0) process.exit(1);
