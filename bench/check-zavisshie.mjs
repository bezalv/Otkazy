// Сверка правила «неполные данные — не повод для вердикта» (19.10.2026):
// код в нодах ведёт себя как источники prototype/lib/pipeline-gate.js и nightly-retry.js,
// механизма last_attempt нигде не осталось, воркфлоу ручного прогона на месте.
//
// Ноды выгружаются сами, по API. Запуск: node bench/check-zavisshie.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..').replace(/\\/g, '/');
const env = {};
for (const l of fs.readFileSync(ROOT + '/.env', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const base = (env.N8N_BASE_URL || 'https://bezalv.ru').replace(/\/+$/, '');

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ok   ' + n); };
const bad = (n, h) => { fail++; console.log('  FAIL ' + n + (h ? '\n       ' + h : '')); };

async function wf(id) {
  const r = await fetch(`${base}/api/v1/workflows/${id}`, { headers: { 'X-N8N-API-KEY': env.N8N_API_KEY } });
  if (!r.ok) { console.error('n8n API ' + r.status + ' по ' + id); process.exit(2); }
  return r.json();
}

const WF = {
  paket: await wf('BhPWB9S6W5dlMUvV'),
  analiz: await wf('GLQ2iuzRaCQZM7QU'),
  nochnoy: await wf('dqwzTtYN5MqQxx6V'),
  zavisshie: await wf('nP8UTwVnRYHjDTAC'),
};
const kod = (w, nm) => {
  const n = w.nodes.find((x) => x.name === nm);
  return n ? (n.parameters.jsCode || n.parameters.query || '') : null;
};

console.log('=== Синтаксис правленых Code-нод ===');
const nody = [
  ['pipeline-gate', kod(WF.analiz, 'pipeline-gate')],
  ['Параметры запуска', kod(WF.paket, 'Параметры запуска')],
  ['Получить сделки из Bitrix', kod(WF.paket, 'Получить сделки из Bitrix')],
  ['Обработать 1 сделку', kod(WF.paket, 'Обработать 1 сделку')],
  ['Собрать партии', kod(WF.nochnoy, 'Собрать партии')],
  ['Собрать партию (зависшие)', kod(WF.zavisshie, 'Собрать партию')],
  ['Итог (зависшие)', kod(WF.zavisshie, 'Итог')],
];
for (const [nm, src] of nody) {
  if (src === null) { bad('ноды «' + nm + '» нет'); continue; }
  try { new Function('return (async function(){' + src + '})'); ok(nm); }
  catch (e) { bad(nm, e.message); }
}

console.log('\n=== Механизма last_attempt нигде нет (кроме пояснений) ===');
// Комментарии про то, почему убрали, оставлены намеренно — ищем именно код.
const kodovyeFormy = [/last_attempt\s*[:=]/, /LAST_ATTEMPT/, /next_is_last/, /recognition_accepted/];
for (const [nm, src] of nody) {
  if (!src) continue;
  const bezKommentariev = src.split('\n').filter((s) => !/^\s*(\/\/|--)/.test(s)).join('\n');
  const najdeno = kodovyeFormy.filter((re) => re.test(bezKommentariev)).map(String);
  najdeno.length ? bad(nm + ': осталось в коде ' + najdeno.join(', ')) : ok(nm + ' — чисто');
}
// В SQL комментарии начинаются с «--»: пояснения про убранное поле искать не надо.
const bezSqlKomm = (s) => String(s || '').split('\n').filter((x) => !/^\s*--/.test(x)).join('\n');
const zapros = bezSqlKomm(kod(WF.nochnoy, 'Взять сделки на повтор'));
/next_is_last/.test(zapros) ? bad('запрос ночного повтора читает next_is_last') : ok('запрос ночного повтора не читает next_is_last');

console.log('\n=== Решение гейта: нода против источника ===');
const lib = fs.readFileSync(ROOT + '/prototype/lib/pipeline-gate.js', 'utf8');
const L = new Function(lib + '\nreturn { pgDecide, pgMarkFailed, PG_MAX_ATTEMPTS };')();

function marki(polnye) {
  const m = { calls: { complete: true }, openlines: { complete: true }, comments: { complete: true }, tasks: { complete: true } };
  if (!polnye) L.pgMarkFailed(m, 'openlines', 'HTTP 502', 3);
  return m;
}
// Что должно блокировать, а что нет — те же случаи, что в моках
const sluchai = [
  ['сбор неполный', { sources: marki(false), recognition: {} }, true],
  ['сбой распознавания', { sources: marki(true), recognition: { calls: [{ activity_id: '1', retryable: true, error: 'timeout' }] } }, true],
  ['сбой + посторонний last_attempt', { sources: marki(true), recognition: { calls: [{ activity_id: '1', retryable: true, error: 'timeout' }] }, last_attempt: true }, true],
  ['тишина', { sources: marki(true), recognition: { calls: [{ activity_id: '2', retryable: false, error: '', duration_sec: 10 }] } }, false],
  ['всё чисто', { sources: marki(true), recognition: {} }, false],
  ['m4a-голосовое', { sources: marki(true), recognition: { voices: [{ file_id: '3', retryable: true, error: 'нет поддержки', file_name: 'a.m4a' }] } }, false],
];
let rashod = 0;
for (const [nm, state, zhdem] of sluchai) {
  const d = L.pgDecide(state);
  if (d.block !== zhdem) { rashod++; console.log('       ' + nm + ': блок=' + d.block + ', ждали ' + zhdem); }
}
rashod ? bad('решение источника расходится с ожиданием', rashod + ' случаев') : ok('источник решает верно на ' + sluchai.length + ' случаях');

// last_attempt на решение не влияет
const sSFlagom = L.pgDecide({ sources: marki(true), recognition: { calls: [{ activity_id: '1', retryable: true, error: 'timeout' }] }, last_attempt: true });
const bezFlaga = L.pgDecide({ sources: marki(true), recognition: { calls: [{ activity_id: '1', retryable: true, error: 'timeout' }] } });
JSON.stringify(sSFlagom) === JSON.stringify(bezFlaga)
  ? ok('посторонний last_attempt на решение не влияет')
  : bad('last_attempt всё ещё меняет решение');

console.log('\n=== Причина сбоя попадает в текст ошибки (для сводки) ===');
const dRec = L.pgDecide({ sources: marki(true), recognition: { calls: [{ activity_id: '77', retryable: true, error: 'Резерв распознавания: timeout' }] } });
/ — Резерв распознавания: timeout/.test(dRec.pipeline_error) ? ok('распознавание: причина в тексте') : bad('нет причины распознавания', dRec.pipeline_error);
const dCol = L.pgDecide({ sources: marki(false), recognition: {} });
/ — HTTP 502/.test(dCol.pipeline_error) ? ok('сбор: причина в тексте') : bad('нет причины сбора', dCol.pipeline_error);
const gateNode = kod(WF.analiz, 'pipeline-gate') || '';
gateNode.includes('pgFailuresText') && gateNode.includes('pgSourcesReason')
  ? ok('обе функции причины стоят в ноде') : bad('в ноде нет функций причины');

// Находка проверки безопасности: причина уходит в базу и в сводку, секреты из неё вычищаем.
gateNode.includes('pgSafeReason') ? ok('очистка причины стоит в ноде') : bad('в ноде нет pgSafeReason');
const S = new Function(lib + '\nreturn { pgSafeReason };')();
const gryaznye = [
  ['502 от https://dinalnsk.bitrix24.ru/rest/65/tokenprimer9z8y7x/disk.file.get', /tokenprimer9z8y7x/],
  ['Api-Key AQVNprimerklyucha0123456789abcdefghij', /AQVN0UdCv1xKfHU/],
  ['GET /v1/x?token=abcdef0123456789abcdef вернул 403', /abcdef0123456789abcdef/],
];
const utechki = gryaznye.filter(([txt, re]) => re.test(S.pgSafeReason(txt)));
utechki.length ? bad('очистка пропускает секрет', utechki.length + ' случаев') : ok('секреты из причины вычищаются (' + gryaznye.length + ' случая)');
const poleznye = [['Резерв распознавания: timeout', /timeout/], ['Polza HTTP 503', /503/]];
poleznye.every(([txt, re]) => re.test(S.pgSafeReason(txt)))
  ? ok('полезные причины остаются читаемыми') : bad('очистка съедает полезное');

console.log('\n=== Партии ночного повтора и ручного прогона ===');
const NR = fs.readFileSync(ROOT + '/prototype/lib/nightly-retry.js', 'utf8');
const N = new Function(NR + '\nreturn { nightlyBatches, manualBatch };')();
const NOW = Date.parse('2026-10-19T10:00:00+07:00');
const rows = [{ deal_id: 1, lose_date: '2026-10-18' }, { deal_id: 2, lose_date: '2026-05-01' }];
const partii = N.nightlyBatches(rows, NOW);
partii.length === 2 && partii[0].silent === false && partii[1].silent === true
  ? ok('ночной повтор: две партии, живая и тихая') : bad('партии ночного повтора не те', JSON.stringify(partii));
partii.every((p) => p.last_attempt === undefined) ? ok('флага попытки в партиях нет') : bad('флаг попытки остался');
const ruch = N.manualBatch(rows);
ruch.length === 1 && ruch[0].silent === false && JSON.stringify(ruch[0].deal_ids) === JSON.stringify([1, 2])
  ? ok('ручной прогон: одна живая партия со всеми сделками') : bad('ручной прогон собран не так', JSON.stringify(ruch));

console.log('\n=== Воркфлоу «Отказ: Прогон зависших» ===');
const z = WF.zavisshie;
z.name === 'Отказ: Прогон зависших' ? ok('имя') : bad('имя: ' + z.name);
z.active ? ok('активен (вебхук работает)') : bad('не активен');
const tipy = z.nodes.map((n) => n.type.replace('n8n-nodes-base.', ''));
tipy.includes('manualTrigger') ? ok('есть кнопка запуска') : bad('нет кнопки');
tipy.includes('webhook') ? ok('есть вебхук') : bad('нет вебхука');
tipy.includes('scheduleTrigger') ? bad('есть расписание — его быть не должно') : ok('расписания нет');
const zapros2 = bezSqlKomm(kod(z, 'Взять зависшие'));
/retry_eligible/.test(zapros2) ? bad('запрос фильтрует по retry_eligible — берём всех') : ok('берутся все зависшие, без фильтра попыток');
const http = z.nodes.find((n) => n.name === 'Запустить lost-batch');
const telo = http ? String(http.parameters.jsonBody || '') : '';
/silent: \$json\.silent/.test(telo) && !/last_attempt/.test(telo)
  ? ok('в пакет уходит только silent, без флага попытки') : bad('тело запроса не то', telo);
kod(z, 'Собрать партию').includes('silent: false')
  ? ok('режим живой, фильтра свежести нет') : bad('режим не живой');

console.log('\nИТОГО: ' + pass + ' ok, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
