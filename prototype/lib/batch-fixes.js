// Мелочи пакетного прогона: предыдущая стадия и дата в комментарии.
// Пункты 12 и 12.11 документа otkazy-reshennoe-v-spin.md, этап 4 (03.10.2026).
//
// Источник правок — этот файл. Моки: tests/batch-fixes/run.js

// Стадии воронки 23 (СЧП). Сверено с crm.status.list по ENTITY_ID=DEAL_STAGE_23.
var STAGE_NAMES = {
  'C23:NEW': 'Технический этап',
  'C23:PREPARATION': 'Предварительный расчет стоимости',
  'C23:PREPAYMENT_INVOIC': 'Замер',
  'C23:EXECUTING': 'Расчет стоимости',
  'C23:FINAL_INVOICE': 'Презентация и согласование КП',
  'C23:UC_GDK5HI': 'Подписание договора и оплата',
  'C23:UC_F0XO84': 'Приостановленные',
  'C23:WON': 'Сделка успешна',
  'C23:LOSE': 'Отказ'
};

// П.12: стадия, с которой сделка ушла в отказ.
//
// Раньше искали стадию перед «Приостановленными» и заполняли её ТОЛЬКО если пауза была,
// поэтому за 60 дней previous_stage пустая у 330 сделок из 528. Нужна же стадия перед
// переходом в отказ — она есть у любой сделки в LOSE.
//
// История приходит от новых к старым (CREATED_TIME DESC), значит после последнего C23:LOSE
// первая же иная стадия — та, с которой ушли в отказ. pause_date считается по-прежнему:
// оно нужно отдельно и от этой правки не зависит.
function prevStageBeforeLose(histArr, stageNames) {
  var hist = histArr || [];
  var names = stageNames || STAGE_NAMES;
  var loseDate = null, pauseDate = null, prevStageId = null, prevStageName = null;
  var loseSeen = false;

  for (var h = 0; h < hist.length; h++) {
    var sid = (hist[h] || {}).STAGE_ID;
    if (sid === 'C23:LOSE') {
      if (!loseDate) loseDate = hist[h].CREATED_TIME;
      loseSeen = true;
      continue;
    }
    if (sid === 'C23:UC_F0XO84' && !pauseDate) pauseDate = hist[h].CREATED_TIME;
    if (loseSeen && !prevStageId) {
      prevStageId = sid || null;
      prevStageName = sid ? (names[sid] || sid) : null;
    }
  }

  return {
    previous_stage_id: prevStageId,
    previous_stage_name: prevStageName,
    lose_date: loseDate,
    pause_date: pauseDate,
    stage_history_count: hist.length
  };
}

// П.12.11: дата для комментария в карточку — по Новосибирску (UTC+7), а не в поясе сервера.
// Сдвигаем метку и дальше читаем через getUTC*, чтобы не зависеть от настройки инстанса.
var NSK_OFFSET_MS = 7 * 60 * 60 * 1000;

function nskDateStr(nowMs) {
  var now = new Date((nowMs === undefined ? Date.now() : nowMs) + NSK_OFFSET_MS);
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  return pad(now.getUTCDate()) + '.' + pad(now.getUTCMonth() + 1) + '.' + now.getUTCFullYear()
    + ' ' + pad(now.getUTCHours()) + ':' + pad(now.getUTCMinutes());
}
