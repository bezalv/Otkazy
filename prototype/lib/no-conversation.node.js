// === ДЕТЕКТОР «РАЗГОВОРА НЕ БЫЛО» ===
// Источник с комментариями и обоснованием каждого списка: prototype/lib/no-conversation.js
// Править ТАМ, здесь — сборка без комментариев (node bench/build-notalk-node.mjs).
// Тот же код продублирован в нодах agent-facts-assembler и b4.5 Comm Analytics.
// Зачем: транскрипт приписывает клиенту любой голос на той стороне, и судья считает
// автоответчик контактом с клиентом (дефект сделки 119215).
var NOTALK_MAX_SEC = 20;
var NOTALK_ZERO_SEC_CHARS = 200;
var NOTALK_MEANINGFUL_CHARS = 12;
var NOTALK_MANAGER_REST_CHARS = 15;
var NOTALK_DIALING = [
  'оставайтесь на линии', 'продолжаем дозваниваться', 'продолжаю дозвон', 'должны дозваниваться',
  'дозваниваться до абонента', 'ожидайте ответа', 'не отключайтесь', 'продолжаю вызов',
  'запись разговоров активирована', 'запись разговора активирована', 'запись разговоров'
];
var NOTALK_MACHINE = [
  'абонент', 'абоненту', 'вызываемый', 'вне зоны действия', 'телефон выключен',
  'телефон разряжен', 'телефон занят', 'не может ответить', 'может ответить на ваш звонок', 'не берет трубку',
  'не в сети', 'не на связи', 'недоступен', 'не доступен', 'линия занята', 'линия абонента',
  'номер не существует', 'сеть перегружена', 'аппарат вызываемого',
  'попробуйте перезвонить', 'перезвонить позднее', 'бесплатное смс', 'отправить бесплатное',
  'консультация оператора', 'на удержание', 'перенаправлен на', 'звонок был перенаправлен',
  'не отвечает', 'номер не отвечает',
  'голосовая почта', 'голосовой почтовый', 'почтовый ящик', 'после звукового сигнала',
  'после сигнала', 'оставьте сообщение', 'оставить сообщение', 'запишите сообщение',
  'длительность сообщения', 'сообщение улетело', 'сообщение отправлено', 'сообщение готово',
  'сообщение достигло',
  'автоответчик', 'виртуальн', 'ассистент', 'помощник', 'помошник', 'секретар', 'голосовой',
  'защитник', 'умный бот', 'защита от спама', 'антиспам', 'я не человек', 'я программа',
  'что передать', 'что нужно передать', 'передам сообщение', 'передам ваше сообщение',
  'передам ему ваше сообщение', 'все от вас передам', 'сохраню и передам', 'запишу и передам',
  'знакомы с абонентом', 'личному или деловому', 'личный или деловой',
  'с какой целью звоните', 'с какой целью', 'по какому поводу вы звоните',
  'озвучьте что', 'скажите что нужно',
  'тоновый', 'тональн', 'пин код', 'для соединения нажмите', 'наберите добавочный',
  'абоненту пока неудобно', 'абоненту сейчас неудобно', 'абоненту неудобно',
  'not available', 'please try again', 'the number is', 'at the moment', 'try again later',
  'switched off'
];
var NOTALK_BOT_SMALLTALK = [
  'робот или человек', 'живой человек или робот', 'живой человек или автоответчик',
  'человек или компьютер', 'вы точно человек', 'вы случайно не робот', 'вы живой человек',
  'единорог', 'в слова сыграем', 'в слова поиграем', 'чур первый', 'в бар спамер',
  'не спамер', 'не спамеры', 'руки крюки', 'рюки крюки', 'век бы с вами',
  'одновременно положим трубки', 'не молчите лучшее'
];
var NOTALK_MACHINE_IN_MANAGER = [
  'абонент сейчас не может ответить', 'абонент не может ответить',
  'абонент пока не может', 'абонент не берет трубку', 'абонент недоступен',
  'оставьте сообщение после сигнала', 'оставьте сообщение после звукового сигнала',
  'вне зоны действия сети', 'телефон выключен или находится',
  'вызываемый абонент не может', 'я виртуальный помощник', 'я виртуальный ассистент',
  'я голосовой помощник', 'я голосовой ассистент'
];
var NOTALK_MANAGER_SYSTEM = [
  'пожалуйста подождите завершение обработки', 'подождите завершение обработки',
  'завершение обработки', 'пожалуйста подождите', 'идет соединение', 'соединяю'
];
var NOTALK_BAD_LINE = [
  'связь прерывается', 'связь прервалась', 'связь барахлит', 'вас не слышно',
  'не слышно', 'плохо слышно', 'вы меня слышите', 'ничего не слышно', 'вы тут'
];
var NOTALK_NOT_CLIENT = [
  'сейчас нет вы по какому вопросу', 'сейчас нет вы по какому',
  'его сейчас нет', 'ее сейчас нет', 'нет на месте',
  'кого вам', 'не туда попали', 'вы не туда', 'ошиблись номером', 'номером ошиблись'
];
var NOTALK_GREETING = [
  'алло', 'аллло', 'ало', 'але', 'здравствуйте', 'здрасьте', 'приветствую', 'привет',
  'добрый день', 'добрый вечер', 'доброе утро', 'добрый',
  'я вас слушаю', 'слушаю вас', 'слушаю', 'говорите пожалуйста', 'говорите',
  'по какому вопросу звоните', 'по какому вопросу', 'по какому поводу', 'кто это',
  'продолжайте', 'на связи',
  'да да да', 'да да', 'да', 'нет', 'ага', 'угу', 'ммм', 'мм', 'э', 'а', 'ну',
  'пожалуйста', 'спасибо', 'что', 'простите', 'извините', 'секунду', 'минуту',
  'до свидания', 'всего доброго', 'всего хорошего'
];
var NOTALK_DEBRIS = [
  'его', 'ее', 'телефон', 'звонок', 'на ваш', 'сети', 'зоны', 'действия', 'возможно',
  'если хотите', 'сейчас', 'пока', 'вам', 'вы', 'или', 'находится', 'сообщение',
  'позднее', 'позже', 'но', 'и', 'в', 'с', 'на', 'не', 'это', 'я', 'он', 'она',
  'потому что', 'разговаривать', 'попробуй', 'был', 'была', 'было', 'можете', 'ящик'
];
var NOTALK_PURPOSE = [
  'окн', 'окош', 'остекл', 'балкон', 'двер', 'лодж', 'перегород', 'витраж',
  'замер', 'расчет', 'смет', 'стоимост', 'цена', 'цены', 'монтаж', 'установк',
  'заявк', 'заказ', 'договор', 'предложени', 'акци', 'скидк',
  'динал', 'завод', 'компани',
  'менеджер', 'меня зовут', 'это ирина', 'это ольга', 'это марина', 'это мария',
  'вас беспокоит', 'вам удобно', 'удобно разговаривать', 'звоню по', 'звоню из',
  'звоню уточнить', 'я вам звонила', 'я вам звонил', 'мы с вами', 'по поводу',
  'обращались', 'уточнить', 'напомнить', 'подтвердить', 'согласовать',
  'отправил', 'отправля', 'считали', 'ранее'
];
function notalkNormalize(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,!?;:()"«»\-–—'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function notalkStripList(norm, list) {
  var sorted = list.slice().sort(function (a, b) { return b.length - a.length; });
  var rest = ' ' + norm + ' ';
  for (var i = 0; i < sorted.length; i++) {
    while (rest.indexOf(sorted[i]) !== -1) rest = rest.split(sorted[i]).join(' ');
  }
  return rest.replace(/\s+/g, ' ').trim();
}
function notalkStripWords(norm, list) {
  var sorted = list.slice().sort(function (a, b) { return b.length - a.length; });
  var rest = ' ' + norm + ' ';
  for (var i = 0; i < sorted.length; i++) {
    var needle = ' ' + sorted[i] + ' ';
    while (rest.indexOf(needle) !== -1) rest = rest.split(needle).join(' ');
  }
  return rest.replace(/\s+/g, ' ').trim();
}
function notalkHit(norm, list) {
  for (var i = 0; i < list.length; i++) {
    if (norm.indexOf(list[i]) !== -1) return list[i];
  }
  return null;
}
function detectNoConversationMono(wholeText, durationSec) {
  var wn = notalkStripList(notalkNormalize(wholeText), NOTALK_DIALING);
  wn = notalkStripList(wn, NOTALK_MANAGER_SYSTEM);
  var machine = notalkHit(wn, NOTALK_MACHINE) || notalkHit(wn, NOTALK_BOT_SMALLTALK);
  var notClient = notalkHit(wn, NOTALK_NOT_CLIENT);
  var rest = notalkStripList(wn, NOTALK_MACHINE);
  rest = notalkStripList(rest, NOTALK_BOT_SMALLTALK);
  rest = notalkStripList(rest, NOTALK_NOT_CLIENT);
  rest = notalkStripWords(rest, NOTALK_GREETING);
  rest = notalkStripWords(rest, NOTALK_DEBRIS);
  if (rest.length > NOTALK_MEANINGFUL_CHARS) return null;
  if (machine) return { reason: 'machine', matched: machine, rest: rest, mono: true, duration_sec: durationSec };
  if (notClient) return { reason: 'not_client', matched: notClient, rest: rest, mono: true, duration_sec: durationSec };
  return { reason: 'greeting_only', matched: null, rest: rest, mono: true, duration_sec: durationSec };
}
function detectNoConversation(clientText, managerText, durationSec, isMono) {
  var cnRaw = notalkNormalize(clientText);
  var mn = notalkNormalize(managerText);
  var isShort;
  if (durationSec === 0 || durationSec === null || typeof durationSec !== 'number') {
    isShort = (cnRaw.length + mn.length) <= NOTALK_ZERO_SEC_CHARS;
  } else {
    isShort = durationSec <= NOTALK_MAX_SEC;
  }
  if (!isShort) return null;
  if (isMono) return detectNoConversationMono((clientText || '') + ' ' + (managerText || ''), durationSec);
  var cn = notalkStripList(cnRaw, NOTALK_DIALING);
  var machine = notalkHit(cn, NOTALK_MACHINE)
    || notalkHit(cn, NOTALK_BOT_SMALLTALK)
    || notalkHit(mn, NOTALK_MACHINE_IN_MANAGER);
  var notClient = notalkHit(cn, NOTALK_NOT_CLIENT);
  var rest = notalkStripList(cn, NOTALK_MACHINE);
  rest = notalkStripList(rest, NOTALK_BOT_SMALLTALK);
  rest = notalkStripList(rest, NOTALK_NOT_CLIENT);
  rest = notalkStripWords(rest, NOTALK_GREETING);
  rest = notalkStripWords(rest, NOTALK_DEBRIS);
  if (rest.length > NOTALK_MEANINGFUL_CHARS) return null;
  if (machine) return { reason: 'machine', matched: machine, rest: rest, duration_sec: durationSec };
  if (notClient) return { reason: 'not_client', matched: notClient, rest: rest, duration_sec: durationSec };
  var badLine = notalkHit(mn, NOTALK_BAD_LINE);
  if (badLine) return { reason: 'bad_line', matched: badLine, rest: rest, duration_sec: durationSec };
  if (notalkManagerNamedPurpose(mn)) return null;
  var mgrRest = notalkStripList(mn, NOTALK_DIALING);
  mgrRest = notalkStripList(mgrRest, NOTALK_MANAGER_SYSTEM);
  mgrRest = notalkStripList(mgrRest, NOTALK_MACHINE_IN_MANAGER);
  mgrRest = notalkStripWords(mgrRest, NOTALK_GREETING);
  mgrRest = notalkStripWords(mgrRest, NOTALK_DEBRIS);
  if (rest.length > 0 && mgrRest.length > NOTALK_MANAGER_REST_CHARS) return null;
  return { reason: 'greeting_only', matched: null, rest: rest, manager_rest: mgrRest, duration_sec: durationSec };
}
function notalkManagerNamedPurpose(mn) {
  return notalkHit(mn, NOTALK_PURPOSE);
}
