// Ночной повтор: кого звать живым разбором, а кого тихо.
//
// Повтор берёт из вью lost_pipeline_attention сделки, у которых последний разбор упал с
// pipeline_error и неудач меньше трёх. Раньше он ходил со `silent: false` по всем, и это было
// опасно: в очереди лежат сделки из перепрогона, закрытые месяцы назад. Уведомление РОПу по
// такой сделке приходит как про свежий факап, а вернуть клиента уже нельзя.
//
// Правило (решение Сани 02.10.2026):
//   — lose_date не старше NIGHTLY_FRESH_DAYS → живой повтор: комментарий в карточку и
//     уведомления РОПам, как при обычном разборе;
//   — старше, либо даты нет вовсе → тихий повтор: разбор пишется в базу, в Битрикс ничего.
//
// Даты может не быть: если разбор упал до записи в lost_deals (например, 120271 — таймаут
// вызова анализа на 12 минут), сделки в таблице ещё нет. Такую считаем старой: тихий режим
// безопаснее, чем уведомление по сделке с неизвестной давностью.
//
// Источник правок — этот файл. Моки: tests/nightly-retry/run.js

// Сколько дней сделка считается свежей.
var NIGHTLY_FRESH_DAYS = 7;

// Сколько сделок берём за одну ночь — предохранитель от лавины живых разборов.
var NIGHTLY_MAX_DEALS = 20;

// Свежая ли сделка. nowMs — текущее время в миллисекундах.
function nightlyIsFresh(loseDate, nowMs) {
  if (!loseDate) return false;
  var t = new Date(loseDate).getTime();
  if (isNaN(t)) return false;
  var ageDays = (nowMs - t) / 86400000;
  return ageDays <= NIGHTLY_FRESH_DAYS;
}

// Партии для lost-batch. Делим по двум признакам: свежесть (silent) и номер попытки
// (last_attempt) — оба флага действуют на весь запуск, поэтому в одну партию их не смешать.
// Порядок партий: сначала живые, внутри — обычные попытки перед последними.
function nightlyBatches(rows, nowMs) {
  var list = rows || [];
  var now = nowMs || Date.now();
  var buckets = {
    'live-normal': { deal_ids: [], silent: false, last_attempt: false },
    'live-last': { deal_ids: [], silent: false, last_attempt: true },
    'quiet-normal': { deal_ids: [], silent: true, last_attempt: false },
    'quiet-last': { deal_ids: [], silent: true, last_attempt: true }
  };

  for (var i = 0; i < list.length; i++) {
    var row = list[i] || {};
    var id = Number(row.deal_id);
    if (!id) continue;
    var fresh = nightlyIsFresh(row.lose_date, now);
    var last = row.next_is_last === true;
    var key = (fresh ? 'live' : 'quiet') + '-' + (last ? 'last' : 'normal');
    buckets[key].deal_ids.push(id);
  }

  var order = ['live-normal', 'live-last', 'quiet-normal', 'quiet-last'];
  var out = [];
  for (var k = 0; k < order.length; k++) {
    var b = buckets[order[k]];
    if (!b.deal_ids.length) continue;
    out.push({
      deal_ids: b.deal_ids,
      silent: b.silent,
      last_attempt: b.last_attempt,
      _partiya: order[k],
      _skolko: b.deal_ids.length
    });
  }
  return out;
}
