import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const paths = ['bench/build-restore-prompts.mjs', 'prototype/prompts/judge_v2.8.md',
  'prototype/prompts/models/gpt-6-sol/patches.json', 'prototype/prompts/models/gpt-6-sol/judge.md',
  'prototype/prompts/restore-patches.json', 'prototype/prompts/writer_v2.5.md',
  'app/prompts/judge.md', 'app/prompts/writer.md'];

async function fixture(action) {
  const parent = await realpath(tmpdir());
  const folder = await mkdtemp(join(parent, 'otkazy-prompt-'));
  try {
    for (const path of paths) {
      const destination = join(folder, path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(sourceRoot, path), destination);
    }
    return await action(folder);
  } finally {
    // Удаляем только явно созданный каталог в системной временной папке.
    const actual = await realpath(folder);
    if (dirname(actual) !== parent || !actual.startsWith(join(parent, 'otkazy-prompt-'))) {
      throw new Error('Недопустимая временная директория');
    }
    await rm(actual, { recursive: true });
  }
}

const build = (folder, check = false) => execute(process.execPath,
  [join(folder, 'bench/build-restore-prompts.mjs'), ...(check ? ['--check'] : [])], { cwd: folder });

test('сборщик воспроизводит дополнения приложения и обнаруживает изменённую копию', async () => fixture(async folder => {
  const appJudge = join(folder, 'app/prompts/judge.md');
  const original = await readFile(appJudge, 'utf8');
  const baseJudge = join(folder, 'prototype/prompts/models/gpt-6-sol/judge.md');
  const baseOriginal = await readFile(baseJudge, 'utf8');
  await build(folder, true);
  await writeFile(appJudge, `${original}\nлишняя строка`, 'utf8');
  await assert.rejects(build(folder, true), /Копия judge\.md устарела/);
  await build(folder);
  assert.equal(await readFile(appJudge, 'utf8'), original);
  assert.equal(await readFile(baseJudge, 'utf8'), baseOriginal);
  await build(folder, true);
}));

test('дополнение приложения с неоднозначным якорем останавливает сборку', async () => fixture(async folder => {
  const path = join(folder, 'prototype/prompts/restore-patches.json');
  const patches = JSON.parse(await readFile(path, 'utf8'));
  patches[0].find = ' ';
  await writeFile(path, JSON.stringify(patches), 'utf8');
  await assert.rejects(build(folder), /Патч приложения .* применяется неоднозначно/);
}));
