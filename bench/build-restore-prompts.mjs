// Копии для сборки отдельного приложения; единственный источник правок — prototype/prompts.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFile(resolve(root, path), 'utf8');
let judge = await read('prototype/prompts/judge_v2.8.md');
const patches = JSON.parse(await read('prototype/prompts/models/gpt-6-sol/patches.json'));
for (const patch of patches.filter(item => item.enabled !== false)) {
  if (judge.split(patch.find).length !== 2) throw new Error(`Патч промпта ${patch.id} применяется неоднозначно`);
  judge = judge.replace(patch.find, patch.replace);
}
if (judge !== await read('prototype/prompts/models/gpt-6-sol/judge.md')) {
  throw new Error('Собранный промпт судьи расходится с рабочей копией');
}
// Дополнения относятся только к восстановленному приложению: базовый промпт
// n8n остаётся неизменным. Каждый якорь обязан встретиться ровно один раз.
const restorePatches = JSON.parse(await read('prototype/prompts/restore-patches.json'));
if (!Array.isArray(restorePatches) || restorePatches.length === 0) throw new Error('Не заданы патчи приложения');
const restoreIds = new Set();
for (const patch of restorePatches) {
  if (!patch || typeof patch.id !== 'string' || !patch.id || restoreIds.has(patch.id)
      || typeof patch.find !== 'string' || !patch.find || typeof patch.replace !== 'string') {
    throw new Error('Некорректный патч приложения');
  }
  restoreIds.add(patch.id);
  if (judge.split(patch.find).length !== 2) throw new Error(`Патч приложения ${patch.id} применяется неоднозначно`);
  judge = judge.replace(patch.find, () => patch.replace);
}
const writer = await read('prototype/prompts/writer_v2.5.md');
const prompts = { 'judge.md': judge, 'writer.md': writer };
const destination = resolve(root, 'app/prompts');
if (process.argv.includes('--check')) {
  for (const [name, expected] of Object.entries(prompts)) {
    if (await read(`app/prompts/${name}`) !== expected) throw new Error(`Копия ${name} устарела`);
  }
  console.log('Промпты приложения совпадают с источниками');
} else {
  await mkdir(destination, { recursive: true });
  for (const [name, value] of Object.entries(prompts)) await writeFile(resolve(destination, name), value, 'utf8');
  console.log('Промпты приложения собраны');
}
