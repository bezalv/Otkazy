// Жёсткий минимум данных: когда судью звать бессмысленно.
//
// Пункт 10 документа otkazy-reshennoe-v-spin.md, вариант Сани от 02.10.2026.
// В коде — только крайний случай, до вызова платной ноды: в материалах нет НИ ОДНОГО
// содержательного факта. Основной порог остаётся в промпте судьи: там есть исключения,
// которые код не различит (клиент назвал причину одной фразой на коротком звонке и т.п.).
//
// Отсекаем, только если выполнено всё сразу:
//   — нет содержательной реплики клиента (речь в звонке, сообщение от 20 знаков,
//     распознанное голосовое, реплика со скриншота);
//   — нет содержательного комментария менеджера в CRM;
//   — нет подтверждённого фактами технического отказа с нашей стороны.
//
// Почему комментарий менеджера спасает от отсечки: по выборке за 60 дней правило без него
// отсекало 61 сделку из 581, и в 9 случаях судья был прав, а код — нет. Там были и технические
// отказы с формулировками вне списка маркеров («технически не возможно», «монтажники отказали»,
// «плохие перекрытия»), и совершённые покупки у конкурента, зафиксированные менеджером.
// С комментарием как основанием правило отсекает 24 сделки, и все 24 судья сам пометил
// «недостаточно_данных» — расхождений ноль.
//
// Источник правок — этот файл. Моки: tests/data-sufficiency/run.js

// Сколько знаков делают реплику содержательной. Порог низкий намеренно: он отсекает «ок»,
// «да», «+», но пропускает короткие однозначные отказы вроде «Я уже купил окна» (16 знаков)…
// — такие в выборке есть, поэтому решение по ним остаётся за судьёй, а не за кодом.
var DS_CLIENT_MIN_CHARS = 20;
var DS_COMMENT_MIN_CHARS = 20;

// Источники, где лежат настоящие слова сторон.
var DS_SPEECH_SOURCES = ['call_transcript', 'chat', 'chat_voice_transcript', 'screenshot_chat'];

// Маркеры технического отказа с нашей стороны. Список заведомо неполный — именно поэтому
// он не единственное основание: содержательный комментарий менеджера спасает сделку и без него.
var DS_FACTORY_MARKERS = [
  'технически невозможно',
  'технически не возможно',
  'не производим',
  'не делаем такое',
  'не изготавливаем',
  'не наш профиль',
  'не попадает в производство',
  'не та серия',
  'регион не обслуживаем',
  'засыпной дом',
  'деревянный сруб',
  'отказано заводом',
  'цех отказал',
  'производство отказал',
  'монтажники отказал'
];

// AI-разбор от прошлого прогона содержательным комментарием не считается: это наш же текст.
function dsIsOwnComment(content) {
  var t = String(content || '');
  return t.indexOf('AI-анализ отказа') !== -1
    || t.indexOf('[B]:f09f948d:') !== -1;
}

function dsLen(content) {
  return String(content || '').trim().length;
}

// Содержательные реплики клиента: сколько их и какая самая длинная.
function dsClientSpeech(facts) {
  var list = facts || [];
  var count = 0, longest = 0;
  for (var i = 0; i < list.length; i++) {
    var f = list[i] || {};
    if (f.actor !== 'client') continue;
    if (DS_SPEECH_SOURCES.indexOf(f.source) === -1) continue;
    var len = dsLen(f.content);
    if (len > longest) longest = len;
    if (len >= DS_CLIENT_MIN_CHARS) count++;
  }
  return { count: count, longest: longest };
}

// Содержательные комментарии менеджера в CRM, кроме наших же AI-разборов.
function dsManagerComments(facts) {
  var list = facts || [];
  var count = 0, longest = 0;
  for (var i = 0; i < list.length; i++) {
    var f = list[i] || {};
    if (f.source !== 'crm_comment') continue;
    if (dsIsOwnComment(f.content)) continue;
    var len = dsLen(f.content);
    if (len > longest) longest = len;
    if (len >= DS_COMMENT_MIN_CHARS) count++;
  }
  return { count: count, longest: longest };
}

// Подтверждённый фактами технический отказ с нашей стороны.
function dsFactoryRefusal(facts) {
  var list = facts || [];
  for (var i = 0; i < list.length; i++) {
    var t = String((list[i] || {}).content || '').toLowerCase();
    if (!t) continue;
    for (var m = 0; m < DS_FACTORY_MARKERS.length; m++) {
      if (t.indexOf(DS_FACTORY_MARKERS[m]) !== -1) return DS_FACTORY_MARKERS[m];
    }
  }
  return null;
}

// Полная оценка достаточности. enough=false означает: судью не зовём.
function dsEvaluate(facts) {
  var client = dsClientSpeech(facts);
  var comments = dsManagerComments(facts);
  var refusal = dsFactoryRefusal(facts);
  var enough = client.count > 0 || comments.count > 0 || !!refusal;

  // missing — это причины отсечки, а не опись всего, чего в сделке нет. У сделки, которая
  // идёт к судье, список пустой: иначе в data_sufficiency попадала бы строка «нет
  // технического отказа завода» у обычного отказа клиента, и читать это было бы странно.
  var missing = [];
  if (enough) {
    return {
      enough: true,
      client_facts: client.count,
      longest_client_reply: client.longest,
      manager_comments: comments.count,
      longest_manager_comment: comments.longest,
      factory_refusal: refusal,
      facts_total: (facts || []).length,
      threshold_client_chars: DS_CLIENT_MIN_CHARS,
      threshold_comment_chars: DS_COMMENT_MIN_CHARS,
      missing: missing
    };
  }

  if (!client.count) {
    missing.push('содержательных реплик клиента (речь в звонке, сообщение от '
      + DS_CLIENT_MIN_CHARS + ' знаков, распознанное голосовое или реплика со скриншота)');
  }
  if (!comments.count) {
    missing.push('содержательных записей менеджера в CRM');
  }
  if (!refusal) {
    missing.push('подтверждённого фактами технического отказа с нашей стороны');
  }

  return {
    enough: enough,
    client_facts: client.count,
    longest_client_reply: client.longest,
    manager_comments: comments.count,
    longest_manager_comment: comments.longest,
    factory_refusal: refusal,
    facts_total: (facts || []).length,
    threshold_client_chars: DS_CLIENT_MIN_CHARS,
    threshold_comment_chars: DS_COMMENT_MIN_CHARS,
    missing: missing
  };
}

// Готовый ответ вместо судьи: та же схема, что отдаёт agent-judge-parse.
function dsInsufficientJudge(ds) {
  var d = ds || {};
  var spisok = (d.missing || []).join('; ');
  return {
    verdict: 'недостаточно_данных',
    verdict_reason_short: 'в материалах нет ничего для оценки',
    recoverable_level: null,
    closure_reason_class: 'other',
    misplaced: false,
    correct_stage: null,
    exact_reason: 'Судья не вызывался: в материалах сделки нет '
      + spisok + '. Оценивать по существу нечего.',
    manager_mistakes: [],
    key_signals: [],
    risk_factors: [{
      factor: 'данных недостаточно для оценки правомерности закрытия',
      proof_fact_ids: [],
      proof_type: 'absence'
    }],
    questions_for_manager: [
      'уточнить у менеджера обстоятельства закрытия сделки — в материалах нет данных',
      'почему общение с клиентом не попало ни в звонки, ни в переписку, ни в комментарии'
    ],
    data_sufficiency: d
  };
}
