// Сверка правок этапа 4 (п.12, 13, 14) с источником prototype/lib/batch-fixes.js
// плюс проверки, что версия промпта нигде не зашита, batch_lock убран, utm на месте.
//
// Порядок: выгрузить ноды пакета в tmp/backup/chastV/posle/, потом сверить.
//   node bench/dump-node.mjs --wf BhPWB9S6W5dlMUvV --node "Подготовить SQL" --out tmp/backup/chastV/posle/sql.js
//   (так же params.js, poluchit.js, obrabotat.js, komment.js)
//   node bench/check-batch-fixes.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const D = path.join(ROOT, 'tmp', 'backup', 'chastV', 'posle');
const body = (f) => { const t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); return t.slice(t.indexOf('\n\n') + 2); };

let bad = 0;
const ok = (name) => console.log(`  ok   ${name}`);
const no = (name, hint) => { bad++; console.log(`  FAIL ${name}${hint ? '\n       ' + hint : ''}`); };
const want = (name, cond, hint) => (cond ? ok(name) : no(name, hint));

console.log('=== Синтаксис нод ===');
const files = fs.readdirSync(D).filter(n => n.endsWith('.js'));
for (const f of files) {
  try { new Function('return (async function(){' + body(path.join(D, f)) + '})'); ok(f); }
  catch (e) { no(f, e.message); }
}

const sql = body(path.join(D, 'sql.js'));
const params = body(path.join(D, 'params.js'));
const poluchit = body(path.join(D, 'poluchit.js'));
const obrabotat = body(path.join(D, 'obrabotat.js'));
const komment = body(path.join(D, 'komment.js'));

console.log('\n=== П.12.10: версия промпта в одной константе ===');
want('объявлена в «Параметрах запуска»', /var PROMPT_VERSION = 'v2\.8-sol'/.test(params));
want('проброшена в «Параметры запуска» → наружу', /prompt_version: PROMPT_VERSION/.test(params));
want('проброшена в «Получить сделки»', /prompt_version: config\.prompt_version/.test(poluchit));
want('читается в «Обработать 1 сделку»', /var PROMPT_VERSION = input\.prompt_version/.test(obrabotat));
want('в «Подготовить SQL» берётся из входа', /var PROMPT_VERSION = String\(r\.prompt_version/.test(sql));
want('в «Собрать AI-комментарий» берётся из входа', /var promptVersion = r\.prompt_version/.test(komment));
// Жёстко зашитой строки быть не должно нигде, кроме значения константы и запасных значений.
const hardSql = (sql.match(/'v2\.8-sol'/g) || []).length;
const hardKomment = (komment.match(/'v2\.8-sol'/g) || []).length;
want(`в «Подготовить SQL» осталось только запасное значение (${hardSql})`, hardSql === 1, 'ожидалось одно вхождение в || fallback');
want(`в «Собрать AI-комментарий» только запасное значение (${hardKomment})`, hardKomment === 1);

console.log('\n=== П.12.8: batch_lock убран ===');
// Ищем именно рабочий SQL, а не упоминание в комментарии про то, что его убрали.
want('в «Подготовить SQL» нет UPDATE batch_lock',
  !/batch_lock SET is_locked/.test(sql),
  'найдено: ' + (sql.match(/batch_lock SET is_locked/g) || []).length);
want('и нет unlockSql с содержимым', !/unlockSql = \" UPDATE/.test(sql));

console.log('\n=== П.13: utm в INSERT и DO UPDATE SET ===');
want('utm в списке колонок INSERT', /utm_source, utm_medium, utm_campaign, product_type/.test(sql));
want('utm в значениях', /escOrNull\(dd\.utm_source\)/.test(sql) && /escOrNull\(dd\.utm_campaign\)/.test(sql));
want('utm в DO UPDATE SET', /utm_source=EXCLUDED\.utm_source/.test(sql));

console.log('\n=== П.12: предыдущая стадия — поведение против библиотеки ===');
const badBefore = bad;
// Вырезаем цикл из ноды и сравниваем с библиотекой на тех же историях.
function pickPrevStage(code) {
  const i = code.indexOf('var loseSeen = false;');
  const j = code.indexOf('dealData.previous_stage_id');
  if (i === -1 || j === -1) throw new Error('не нашёл блок предыдущей стадии в ноде');
  const stagesLine = code.match(/var stages = \{[^}]+\};/);
  if (!stagesLine) throw new Error('не нашёл словарь стадий');
  const src = stagesLine[0] + '\nfunction run(histArr) {\n'
    + 'var prevStageId = null; var prevStageName = null; var pauseDate = null; var loseDate = null;\n'
    + code.slice(i, j)
    + '\nreturn { previous_stage_id: prevStageId, previous_stage_name: prevStageName, lose_date: loseDate, pause_date: pauseDate, stage_history_count: histArr.length };\n}';
  return new Function(src + '\nreturn run;')();
}
const NODE = pickPrevStage(obrabotat);
const LIB = new Function(fs.readFileSync(path.join(ROOT, 'prototype', 'lib', 'batch-fixes.js'), 'utf8') + '\nreturn prevStageBeforeLose;')();

const st = (s, t) => ({ STAGE_ID: s, CREATED_TIME: t });
const istorii = [
  [st('C23:LOSE', 'a'), st('C23:UC_GDK5HI', 'b'), st('C23:FINAL_INVOICE', 'c')],
  [st('C23:LOSE', 'a'), st('C23:FINAL_INVOICE', 'b')],
  [st('C23:LOSE', 'a'), st('C23:PREPAYMENT_INVOIC', 'b'), st('C23:UC_F0XO84', 'c'), st('C23:FINAL_INVOICE', 'd')],
  [st('C23:LOSE', 'a')],
  [st('C23:NEW', 'a')],
  [],
  [st('C23:LOSE', 'a'), st('C23:EXECUTING', 'b'), st('C23:LOSE', 'c'), st('C23:NEW', 'd')],
  [st('C23:LOSE', 'a'), st('C23:UC_NEWSTAGE', 'b')]
];
for (let k = 0; k < istorii.length; k++) {
  const a = LIB(istorii[k]), b = NODE(istorii[k]);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    no(`история ${k}`, `нода ${JSON.stringify(b)}\n       библиотека ${JSON.stringify(a)}`);
  }
}
if (bad === badBefore) ok(`поведение совпадает с библиотекой на ${istorii.length} историях`);

console.log('\n=== П.12.11: дата по Новосибирску ===');
want('сдвиг на +07:00 задан константой', /NSK_OFFSET_MS = 7 \* 60 \* 60 \* 1000/.test(komment));
want('дата читается через getUTC*', /getUTCDate\(\)/.test(komment) && /getUTCHours\(\)/.test(komment));
want('локальных getDate\\(\\)/getHours\\(\\) не осталось', !/now\.getDate\(\)/.test(komment) && !/now\.getHours\(\)/.test(komment));

console.log(bad === 0 ? '\nвсе правки этапа 4 на месте' : `\nпроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
