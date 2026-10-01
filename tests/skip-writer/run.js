// Моки на обработку случаев, когда писатель не вызывался или судья не отработал.
// Проверяют три вещи:
//   1. текст комментария подбирается по вердикту (prototype/lib/skip-writer-comment.js);
//   2. признак ошибки судьи распознаётся по тому же правилу, что в ноде judge-error-router;
//   3. слово «правомерен» не появляется ни при каком другом вердикте.
//
// Запуск: node tests/skip-writer/run.js
var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '..', '..', 'prototype', 'lib', 'skip-writer-comment.js'), 'utf8');
var L = new Function(src + '\nreturn { buildSkipWriterComment: buildSkipWriterComment, SKIPW_REASON_LIMIT: SKIPW_REASON_LIMIT };')();

var pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       получил: ' + JSON.stringify(got) + '\n       ожидал:  ' + JSON.stringify(want)); }
}
function check(name, cond, hint) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (hint ? '\n       ' + hint : '')); }
}

console.log('=== Недостаточно данных ===');
eq('берёт первое предложение из exact_reason',
  L.buildSkipWriterComment({
    verdict: 'недостаточно_данных',
    verdict_reason_short: 'недостаточно данных для разбора',
    exact_reason: 'В материалах сделки нет содержательных диалогов с клиентом — ни одного транскрипта звонка длительностью ≥60 сек, ни одного содержательного чат-сообщения от клиента. Вердикт по существу вынести невозможно.'
  }),
  'Недостаточно данных для оценки: В материалах сделки нет содержательных диалогов с клиентом — ни одного транскрипта звонка длительностью ≥60 сек, ни одного содержательного чат-сообщения от клиента.');

eq('без exact_reason берёт короткую подпись',
  L.buildSkipWriterComment({ verdict: 'недостаточно_данных', verdict_reason_short: 'нет содержательных контактов' }),
  'Недостаточно данных для оценки: нет содержательных контактов');

eq('совсем без пояснений — общая фраза',
  L.buildSkipWriterComment({ verdict: 'недостаточно_данных' }),
  'Недостаточно данных для оценки: в материалах сделки нет содержательных диалогов с клиентом');

check('в тексте «недостаточно данных» нет слова «правомерен»',
  L.buildSkipWriterComment({ verdict: 'недостаточно_данных', exact_reason: 'Нет диалогов.' }).indexOf('равомерен') === -1);

console.log('\n=== Правомерен без писателя ===');
eq('добавляет короткую подпись судьи',
  L.buildSkipWriterComment({ verdict: 'правомерен', verdict_reason_short: 'клиент ушёл к конкуренту' }),
  'Отказ правомерен: клиент ушёл к конкуренту');
eq('без подписи — короткая фраза',
  L.buildSkipWriterComment({ verdict: 'правомерен' }),
  'Отказ правомерен.');

console.log('\n=== Неправомерен без писателя (сюда попадать не должно) ===');
eq('не выдумывает разбор и не пишет «правомерен»',
  L.buildSkipWriterComment({ verdict: 'неправомерен', verdict_reason_short: 'закрыли досрочно' }),
  'Отказ неправомерен: закрыли досрочно. Подробный разбор не сформирован.');
check('слово «правомерен» отдельным вердиктом не появляется',
  L.buildSkipWriterComment({ verdict: 'неправомерен' }).indexOf('Отказ правомерен') === -1);

console.log('\n=== Сбой судьи: вердикта нет ===');
for (var i = 0; i < 4; i++) {
  var input = [undefined, null, {}, { verdict: null }][i];
  var names = ['judge не передан', 'judge = null', 'judge = пустой объект', 'verdict = null'];
  eq(names[i], L.buildSkipWriterComment(input), 'Разбор не сформирован: вердикт не получен.');
}
check('при сбое судьи слова «правомерен» нет',
  L.buildSkipWriterComment({}).indexOf('равомерен') === -1);
check('при сбое судьи нет слова «Вердикт: неизвестно», которое попадало в карточку',
  L.buildSkipWriterComment({}).indexOf('неизвестно') === -1);

console.log('\n=== Длинное пояснение обрезается ===');
var longReason = 'Клиент ' + new Array(60).join('очень ') + 'длинная причина.';
var out = L.buildSkipWriterComment({ verdict: 'недостаточно_данных', exact_reason: longReason });
check('длина в пределах лимита плюс префикс',
  out.length <= L.SKIPW_REASON_LIMIT + 40,
  'получилось ' + out.length + ' символов при лимите ' + L.SKIPW_REASON_LIMIT);
check('обрезка не рвёт слово посередине', /…$/.test(out) || /[.!?]$/.test(out), 'хвост: ' + JSON.stringify(out.slice(-25)));

console.log('\n=== Признак ошибки судьи (как в judge-error-router) ===');
// Нода agent-judge-parse при любом сбое возвращает error: true и _block: 'judge_error'.
function isJudgeError(j) { return j && (j.error === true || j._block === 'judge_error'); }
check('пустой ответ модели', isJudgeError({ error: true, message: 'Empty LLM response', _block: 'judge_error' }));
check('JSON не разобрался', isJudgeError({ error: true, message: 'Failed to parse JSON', _block: 'judge_error' }));
check('нет обязательных полей', isJudgeError({ error: true, message: 'Missing fields: verdict', _block: 'judge_error' }));
check('нормальный разбор ошибкой не считается', !isJudgeError({ judge: { verdict: 'правомерен' }, _block: 'judge_parsed' }));

console.log('\n=== Что НЕ должно попадать в карточку при сбое ===');
var brokenComment = L.buildSkipWriterComment({});
check('нет «Отказ правомерен»', brokenComment.indexOf('Отказ правомерен') === -1);
check('текст непустой и осмысленный', brokenComment.length > 20);

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
if (fail > 0) process.exit(1);
