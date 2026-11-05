import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rules = [
  {
    source: 'prototype/lib/pipeline-gate.js',
    target: 'app/src/rules/pipeline-gate.mjs',
    exports: ['pgDecide', 'pgInitMarks', 'pgMarkComplete', 'pgMarkFailed', 'pgSafeReason', 'pgUnrecognizedCallFact'],
  },
  {
    source: 'prototype/lib/data-sufficiency.js',
    target: 'app/src/rules/data-sufficiency.mjs',
    exports: ['dsEvaluate', 'dsInsufficientJudge'],
  },
  {
    source: 'prototype/lib/nightly-retry.js',
    target: 'app/src/rules/nightly-retry.mjs',
    exports: ['NIGHTLY_FRESH_DAYS', 'NIGHTLY_MAX_DEALS', 'nightlyIsFresh', 'nightlyBatches', 'manualBatch'],
  },
];
const check = process.argv.includes('--check');
let different = false;

for (const rule of rules) {
  const source = await readFile(resolve(root, rule.source), 'utf8');
  const generated = `// Создано bench/build-restore-rules.mjs из ${rule.source}.\n${source.replace(/\r\n/g, '\n').trimEnd()}\n\nexport { ${rule.exports.join(', ')} };\n`;
  const target = resolve(root, rule.target);
  if (check) {
    const actual = await readFile(target, 'utf8').catch(() => '');
    if (actual.replace(/\r\n/g, '\n') !== generated) {
      console.error(`Код расходится с источником: ${rule.target}`);
      different = true;
    }
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, generated, 'utf8');
  }
}

if (different) process.exitCode = 1;
else console.log(check ? 'Правила совпадают с источниками' : 'Правила собраны из источников');
