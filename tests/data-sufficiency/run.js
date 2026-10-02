// Моки на жёсткий минимум данных (prototype/lib/data-sufficiency.js), пункт 10.
//
// Главное, что проверяется: код отсекает ТОЛЬКО когда нет ничего — ни реплик клиента,
// ни содержательных записей менеджера, ни технического отказа. Все случаи, где судья
// за 60 дней оказался прав против кода, разобраны отдельными моками.
//
// Запуск: node tests/data-sufficiency/run.js
var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '..', '..', 'prototype', 'lib', 'data-sufficiency.js'), 'utf8');
var L = new Function(src + '\nreturn {' + [
  'dsEvaluate', 'dsInsufficientJudge', 'dsClientSpeech', 'dsManagerComments', 'dsFactoryRefusal',
  'dsIsOwnComment', 'DS_CLIENT_MIN_CHARS', 'DS_COMMENT_MIN_CHARS'
].map(function (n) { return n + ':' + n; }).join(',') + '};')();

var pass = 0, fail = 0;
function check(name, cond, hint) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (hint ? '\n       ' + hint : '')); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    'получил: ' + JSON.stringify(got) + '\n       ожидал:  ' + JSON.stringify(want));
}

function f(source, actor, content) { return { source: source, actor: actor, content: content }; }

console.log('=== Пусто: код отсекает ===');
var pustoyNabor = [
  f('call_event', 'system', 'Звонок outgoing, 4 сек, записи нет'),
  f('call_event', 'system', 'Звонок outgoing, 0 сек, записи нет'),
  f('crm_task', 'manager', 'CRM: решение по замеру')
];
var dsPusto = L.dsEvaluate(pustoyNabor);
check('судью не зовём', dsPusto.enough === false);
eq('реплик клиента нет', dsPusto.client_facts, 0);
eq('комментариев нет', dsPusto.manager_comments, 0);
eq('отказа завода нет', dsPusto.factory_refusal, null);
eq('перечислено три нехватки', dsPusto.missing.length, 3);
eq('фактов всего', dsPusto.facts_total, 3);

var dsNichego = L.dsEvaluate([]);
check('совсем пустой список — отсекаем', dsNichego.enough === false);
check('null вместо фактов — отсекаем', L.dsEvaluate(null).enough === false);

console.log('\n=== Реплика клиента спасает ===');
check('сообщение клиента от 20 знаков',
  L.dsEvaluate([f('chat', 'client', 'Добрый день, сколько будет стоить остекление балкона?')]).enough);
check('речь клиента в звонке',
  L.dsEvaluate([f('call_transcript', 'client', 'Да, здравствуйте, я по окнам звоню, нужен расчёт')]).enough);
check('распознанное голосовое',
  L.dsEvaluate([f('chat_voice_transcript', 'client', '[Голосовое сообщение]: Вера, подскажите по расчёту')]).enough);
check('реплика со скриншота',
  L.dsEvaluate([f('screenshot_chat', 'client', 'Нам пока дорого, подумаем до весны')]).enough);

console.log('\n=== Что репликой клиента НЕ считается ===');
check('«ок» — слишком коротко', !L.dsEvaluate([f('chat', 'client', 'ок')]).enough);
check('«+» — слишком коротко', !L.dsEvaluate([f('chat', 'client', '+')]).enough);
check('слова менеджера не спасают', !L.dsEvaluate([f('chat', 'manager', 'Отправила вам расчёт, посмотрите пожалуйста')]).enough);
check('моно-запись (actor=unknown) не спасает',
  !L.dsEvaluate([f('call_transcript', 'unknown', 'Запись без разделения сторон (одна звуковая дорожка): алло, да, хорошо')]).enough);
check('системный факт звонка не спасает',
  !L.dsEvaluate([f('call_event', 'system', 'Звонок outgoing, 40 сек: запись есть, но не распознана')]).enough);
eq('порог клиента вынесен константой', L.DS_CLIENT_MIN_CHARS, 20);

// Та самая сделка 125119: клиент ответил 16 знаками, код бы отсёк — решение остаётся за судьёй.
// Поэтому её спасает комментарий менеджера, а не длина реплики.
var sdelka125119 = [
  f('screenshot_chat', 'client', 'Я уже купил окна'),
  f('crm_comment', 'manager', '24.09. расчет в макс\n25.09 предложила замер, сказал что уже купил окна')
];
check('125119: к судье идёт (спасает комментарий)', L.dsEvaluate(sdelka125119).enough);
eq('125119: сама реплика короче порога', L.dsEvaluate(sdelka125119).longest_client_reply, 16);
eq('125119: содержательных реплик клиента ноль', L.dsEvaluate(sdelka125119).client_facts, 0);

console.log('\n=== Комментарий менеджера спасает ===');
check('содержательная запись в CRM',
  L.dsEvaluate([f('crm_comment', 'manager', 'Клиент заключила договор с другой компанией, нашла дешевле')]).enough);
check('короткая запись не спасает', !L.dsEvaluate([f('crm_comment', 'manager', 'перезвонить')]).enough);
check('наш же AI-разбор не считается',
  !L.dsEvaluate([f('crm_comment', 'manager', '[B]:f09f948d: AI-анализ отказа[/B] (04.09.2026) Вердикт: правомерен, клиент ушёл к конкуренту')]).enough);
check('AI-разбор распознаётся по заголовку', L.dsIsOwnComment('… AI-анализ отказа … вердикт'));
check('обычный комментарий не считается нашим', !L.dsIsOwnComment('Клиент просил перезвонить в пятницу'));

console.log('\n=== Технический отказ спасает ===');
check('«технически невозможно»',
  L.dsEvaluate([f('crm_comment', 'manager', 'технически невозможно установить перегородки')]).enough);
check('«технически не возможно» — раздельно, как в 125085',
  L.dsEvaluate([f('crm_comment', 'manager', 'технически не возможно установить перегородки')]).enough);
check('«монтажники отказали», как в 121175',
  L.dsEvaluate([f('crm_comment', 'manager', 'монтажники отказались от работ, объект сложный')]).enough);
check('«производство отказало», как в 120953',
  L.dsEvaluate([f('crm_comment', 'manager', 'производство отказало по крыше')]).enough);
check('«засыпной дом»', L.dsEvaluate([f('crm_comment', 'manager', 'старый засыпной дом')]).enough);
eq('маркер возвращается, чтобы его было видно в отчёте',
  L.dsFactoryRefusal([f('crm_comment', 'manager', 'не производим такие')]), 'не производим');
eq('посторонний текст маркером не считается',
  L.dsFactoryRefusal([f('crm_comment', 'manager', 'клиент передумал')]), null);

console.log('\n=== Показатели для data_sufficiency ===');
var nabor = [
  f('chat', 'client', 'Здравствуйте, нужен расчёт на два окна в дом'),
  f('chat', 'client', 'да'),
  f('crm_comment', 'manager', 'Отправила смету, ждём решение по замеру'),
  f('crm_comment', 'manager', 'ок'),
  f('call_event', 'system', 'Звонок 5 сек')
];
var ds = L.dsEvaluate(nabor);
eq('содержательных реплик клиента', ds.client_facts, 1);
eq('самая длинная реплика клиента', ds.longest_client_reply, 44);
eq('содержательных комментариев', ds.manager_comments, 1);
eq('фактов всего', ds.facts_total, 5);
check('нехваток нет', ds.missing.length === 0);
check('к судье идёт', ds.enough);

console.log('\n=== Ответ вместо судьи ===');
var judge = L.dsInsufficientJudge(dsPusto);
eq('вердикт', judge.verdict, 'недостаточно_данных');
eq('класс', judge.closure_reason_class, 'other');
eq('возврат не оценивается', judge.recoverable_level, null);
eq('ошибок менеджера нет', judge.manager_mistakes.length, 0);
eq('сигналов нет', judge.key_signals.length, 0);
eq('риск один, через absence', [judge.risk_factors.length, judge.risk_factors[0].proof_type], [1, 'absence']);
check('в пояснении перечислено, чего не хватило', /нет содержательных реплик клиента/.test(judge.exact_reason));
check('и про записи менеджера', /записей менеджера/.test(judge.exact_reason));
check('и про технический отказ', /технического отказа/.test(judge.exact_reason));
check('сказано, что судья не вызывался', /не вызывался/.test(judge.exact_reason));
check('вопросы менеджеру есть', judge.questions_for_manager.length === 2);
check('показатели приложены', judge.data_sufficiency && judge.data_sufficiency.facts_total === 3);
check('слова «правомерен» в пояснении нет', judge.exact_reason.indexOf('равомерен') === -1);

console.log('\n=== verdict-router отправит такой вердикт мимо писателя ===');
// Слепок условий ноды verdict-router: к писателю идут «неправомерен», либо если есть
// ошибки менеджера, либо низкий потенциал возврата.
function kPisatelyu(j) {
  return j.verdict === 'неправомерен'
    || (j.manager_mistakes || []).length > 0
    || j.recoverable_level === 'низкий';
}
check('писатель не вызывается', !kPisatelyu(judge));

// Слепок skip-writer: текст комментария по вердикту.
var skipSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'prototype', 'lib', 'skip-writer-comment.js'), 'utf8');
var SW = new Function(skipSrc + '\nreturn buildSkipWriterComment;')();
var komment = SW(judge);
check('комментарий начинается с «Недостаточно данных»', komment.indexOf('Недостаточно данных для оценки') === 0, komment.slice(0, 60));
check('в комментарии перечислено, чего нет', /реплик клиента/.test(komment));
check('слова «правомерен» в комментарии нет', komment.indexOf('равомерен') === -1);

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
if (fail > 0) process.exit(1);
