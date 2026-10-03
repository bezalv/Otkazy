// Уведомления РОПам: только после записи разбора в базу, с отметкой доставки и без повторов.
//
// Пункт 15 документа otkazy-reshennoe-v-spin.md. Что было: `notify-prepare` → `notify-send`
// висели на выходе `final-output` внутри анализа, параллельно с ответом вебхука. То есть
// уведомление уходило РОПу ДО того, как пакет записывал разбор в базу: если запись падала,
// РОП уже прочитал про сделку, которой в базе нет. Доставка нигде не отмечалась, и повторный
// прогон той же сделки присылал то же уведомление снова.
//
// Теперь отправка живёт в пакете, после «Записать в Supabase» и после комментария в карточку.
// Отметка доставки пишется в `ai_judge_json.notification` — новая таблица и новые колонки
// не нужны, укладываемся в существующий jsonb.
//
// Дедупликация делается одним SQL-запросом, который сразу и проверяет, и занимает право на
// отправку (nodes `notify-claim`): обновляет отметку на `sending` только если по этой сделке
// с этим же вердиктом ещё не было `status = ok`. Вернулась строка — отправляем, пусто — молчим.
//
// Источник правок — этот файл. Моки: tests/rop-notify/run.js

// Кому уходят уведомления. Те же идентификаторы, что были в notify-prepare.
var ROP_RECIPIENTS = [65, 26175, 19601];

// Когда уведомлять. Правило прежнее: неправомерный отказ либо правомерный по цене —
// такие можно попробовать вернуть спецпредложением.
function ropShouldNotify(verdict, closure) {
  if (verdict === 'неправомерен') return true;
  if (verdict === 'правомерен' && closure === 'price') return true;
  return false;
}

// Шапка сообщения по вердикту.
function ropHeader(verdict, closure) {
  if (verdict === 'неправомерен') {
    return { emoji: '🔴', text: 'Неправомерный отказ' };
  }
  if (verdict === 'правомерен' && closure === 'price') {
    return { emoji: '💰', text: 'Отказ по цене — возможен возврат спецпредложением' };
  }
  return null;
}

// Текст уведомления. Формат прежний, чтобы РОПы не заметили перемены места отправки.
function ropMessage(deal) {
  var d = deal || {};
  var head = ropHeader(d.verdict, d.closure);
  if (!head) return '';
  var url = 'https://dinalnsk.bitrix24.ru/crm/deal/details/' + d.deal_id + '/';
  return head.emoji + ' ' + head.text + '\n'
    + 'Сделка: ' + (d.title || '') + ' (#' + d.deal_id + ')\n'
    + (d.reason_short || '') + '\n'
    + url;
}

// Отметка доставки для ai_judge_json.notification: кому, когда, с каким исходом.
// results — массив { user_id, ok, error } по каждому получателю.
function ropMark(results, nowIso) {
  var list = results || [];
  var delivered = [], failed = [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i] || {};
    if (r.ok) delivered.push(Number(r.user_id));
    else failed.push({ user_id: Number(r.user_id), error: String(r.error || 'неизвестная ошибка').substring(0, 200) });
  }
  // Статус ok ставим, если дошло хотя бы одному: иначе повтор будет слать уведомление снова
  // тем, кто его уже получил. Полный провал оставляем как error — такую сделку можно повторить.
  return {
    status: delivered.length ? 'ok' : 'error',
    sent_at: nowIso || new Date().toISOString(),
    recipients: list.map(function (r) { return Number((r || {}).user_id); }),
    delivered: delivered,
    failed: failed
  };
}
