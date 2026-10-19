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

// Партии для lost-batch. Делим только по свежести: она решает, живой разбор или тихий.
//
// 19.10.2026: деление по номеру попытки убрано вместе с механизмом last_attempt. Раньше
// третья попытка снимала блокировку по распознаванию и сделка разбиралась на неполных
// данных; теперь такая сделка просто остаётся в списке зависших и ждёт ручного прогона.
function nightlyBatches(rows, nowMs) {
  var list = rows || [];
  var now = nowMs || Date.now();
  var buckets = {
    live: { deal_ids: [], silent: false },
    quiet: { deal_ids: [], silent: true }
  };

  for (var i = 0; i < list.length; i++) {
    var row = list[i] || {};
    var id = Number(row.deal_id);
    if (!id) continue;
    buckets[nightlyIsFresh(row.lose_date, now) ? 'live' : 'quiet'].deal_ids.push(id);
  }

  var order = ['live', 'quiet'];
  var out = [];
  for (var k = 0; k < order.length; k++) {
    var b = buckets[order[k]];
    if (!b.deal_ids.length) continue;
    out.push({
      deal_ids: b.deal_ids,
      silent: b.silent,
      _partiya: order[k],
      _skolko: b.deal_ids.length
    });
  }
  return out;
}

// Ручной прогон зависших («Отказ: Прогон зависших», 19.10.2026).
//
// Отличия от ночного повтора, оба — решение Сани:
//   * фильтра свежести нет: сделка ни разу не получала вердикт, и РОП должен о ней узнать,
//     даже если закрыта давно;
//   * берутся ВСЕ зависшие, а не только те, у кого остались ночные попытки;
//   * одна партия: делить не по чему, флаг один.
// Сделка, которая снова не собралась, останется в списке — её видно в следующей сводке.
function manualBatch(rows) {
  var ids = [];
  var list = rows || [];
  for (var i = 0; i < list.length; i++) {
    var id = Number((list[i] || {}).deal_id);
    if (id && ids.indexOf(id) === -1) ids.push(id);
  }
  if (!ids.length) return [];
  return [{ deal_ids: ids, silent: false, _partiya: 'manual', _skolko: ids.length }];
}
