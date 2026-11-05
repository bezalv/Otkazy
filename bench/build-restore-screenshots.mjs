import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'tests/restore-screenshots/fixtures/screenshots-parse.n8n.txt');
const targetPath = resolve(root, 'app/src/screenshots/parse.mjs');
const source = (await readFile(sourcePath, 'utf8')).replace(/\r\n/g, '\n');
const bindings = "var base = $('b4.5 Comm Analytics').first().json;\nvar tasks = $('screenshots-fetch').all();\nvar runs = $input.all();";
const result = 'return [{ json: out }];';
if (source.split(bindings).length !== 2 || source.split(result).length !== 2) {
  throw new Error('Не удалось однозначно определить вход и выход исходной ноды');
}
const body = source.replace(bindings, '').replace(result, 'return out;').trimEnd();
const generated = '// Собрано из локальной выгрузки ноды screenshots-parse от 19.10.2026.\n' +
  'export function mergeScreenshotResults(base, taskItems, runItems) {\n' +
  'var tasks = taskItems.map(function (item) { return { json: item }; });\n' +
  'var runs = runItems.map(function (item) { return { json: item }; });\n' +
  body + '\n}\n';
if (process.argv.includes('--check')) {
  const actual = await readFile(targetPath, 'utf8').catch(() => '');
  if (actual.replace(/\r\n/g, '\n') !== generated) {
    console.error('Разбор скриншотов отличается от выгрузки');
    process.exitCode = 1;
  } else console.log('Разбор скриншотов совпадает с выгрузкой');
} else {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, generated, 'utf8');
  console.log('Разбор скриншотов собран из выгрузки');
}
