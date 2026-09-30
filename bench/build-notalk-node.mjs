// Сборка компактной версии детектора для вставки в Code-ноды n8n.
// Источник с комментариями — prototype/lib/no-conversation.js, он остаётся местом правок.
// Здесь убираются комментарии и лишние переводы строк: в ноде код почти не читают,
// а объём важен, потому что он дублируется в двух нодах.
//
// Запуск: node bench/build-notalk-node.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'prototype', 'lib', 'no-conversation.js');
const OUT = path.join(ROOT, 'prototype', 'lib', 'no-conversation.node.js');

const src = fs.readFileSync(SRC, 'utf8');

const lines = src.split(/\r?\n/);
const kept = [];
for (const line of lines) {
  const t = line.trim();
  if (t.startsWith('//')) continue;          // строка-комментарий целиком
  if (!t) continue;                          // пустая строка
  kept.push(line.replace(/\s+\/\/.*$/, ''));  // хвостовой комментарий
}

// Шапка: без неё непонятно, откуда код и где его править.
const header = [
  '// === ДЕТЕКТОР «РАЗГОВОРА НЕ БЫЛО» ===',
  '// Источник с комментариями и обоснованием каждого списка: prototype/lib/no-conversation.js',
  '// Править ТАМ, здесь — сборка без комментариев (node bench/build-notalk-node.mjs).',
  '// Тот же код продублирован в нодах agent-facts-assembler и b4.5 Comm Analytics.',
  '// Зачем: транскрипт приписывает клиенту любой голос на той стороне, и судья считает',
  '// автоответчик контактом с клиентом (дефект сделки 119215).'
].join('\n');

const out = header + '\n' + kept.join('\n') + '\n';
fs.writeFileSync(OUT, out, 'utf8');

console.log(`Компактная сборка: ${path.relative(ROOT, OUT)}`);
console.log(`Было ${src.length} символов, стало ${out.length} (−${Math.round((1 - out.length / src.length) * 100)}%)`);

// Проверка: компактная версия должна вести себя ровно как источник.
const mk = (code) => new Function(code + '\nreturn detectNoConversation;')();
const a = mk(src), b = mk(out);
const cases = [
  ['Алло, здравствуйте! По какому вопросу звоните?', 'Алло.', 11],
  ['Абонент сейчас не может ответить на ваш звонок.', '', 9],
  ['Алло. Мы уже поставили спасибо.', 'Татьяна, здравствуйте, менеджер Вера зовут.', 12],
  ['Алло.', 'Да, да, связь прерывается, конструктор замерщик будет вам звонить.', 18],
  ['', 'Пожалуйста, подождите завершение обработки.', 0],
  ['Алло. У Вас сейчас нет, вы по какому вопросу?', 'Але Анну могу услышать?', 9],
  ['Алло.', '', 21],
  ['', '', 5]
];
let same = 0;
for (const [c, m, s] of cases) {
  const ra = a(c, m, s), rb = b(c, m, s);
  const ok = JSON.stringify(ra) === JSON.stringify(rb);
  if (ok) same++; else console.log(`  ✗ расхождение на «${c.slice(0, 40)}»: ${JSON.stringify(ra)} против ${JSON.stringify(rb)}`);
}
console.log(`Поведение совпадает с источником: ${same} из ${cases.length} ${same === cases.length ? '✓' : '✗'}`);
if (same !== cases.length) process.exit(1);
