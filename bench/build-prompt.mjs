// Сборка промпта под модель: рабочий промпт + патчи из папки модели.
// Рабочий промпт Opus не трогаем — он остаётся источником.
// Запуск: node bench/build-prompt.mjs --model gpt-6-sol
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const model = arg('model', 'gpt-6-sol');
const dir = path.join(ROOT, 'prototype', 'prompts', 'models', model);

const base = fs.readFileSync(path.join(ROOT, 'prototype', 'prompts', 'judge_v2.5.md'), 'utf8');
const patches = JSON.parse(fs.readFileSync(path.join(dir, 'patches.json'), 'utf8'));

let out = base;
const applied = [];
for (const p of patches) {
  const hits = out.split(p.find).length - 1;
  if (hits !== 1) {
    console.error(`✗ патч ${p.id}: find встречается ${hits} раз (нужно ровно 1)`);
    console.error(`  искали: ${p.find.slice(0, 120)}…`);
    process.exit(1);
  }
  out = out.replace(p.find, p.replace);
  applied.push({ id: p.id, delta: p.replace.length - p.find.length });
}

fs.writeFileSync(path.join(dir, 'judge.md'), out, 'utf8');
console.log(`Промпт судьи под ${model}: ${path.relative(ROOT, path.join(dir, 'judge.md'))}`);
console.log(`Было ${base.length} символов, стало ${out.length} (+${out.length - base.length})`);
console.table(applied);

// Писателя пока не правим — копию не делаем, стенд возьмёт рабочий writer_v2.5.md.
const writerPatches = path.join(dir, 'writer.patches.json');
if (fs.existsSync(writerPatches)) {
  const baseW = fs.readFileSync(path.join(ROOT, 'prototype', 'prompts', 'writer_v2.5.md'), 'utf8');
  let outW = baseW;
  for (const p of JSON.parse(fs.readFileSync(writerPatches, 'utf8'))) {
    const hits = outW.split(p.find).length - 1;
    if (hits !== 1) { console.error(`✗ патч писателя ${p.id}: find встречается ${hits} раз`); process.exit(1); }
    outW = outW.replace(p.find, p.replace);
  }
  fs.writeFileSync(path.join(dir, 'writer.md'), outW, 'utf8');
  console.log(`Промпт писателя под ${model}: собран`);
}
