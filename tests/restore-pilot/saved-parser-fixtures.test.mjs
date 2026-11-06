import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseJudgeResponse } from '../../app/src/agents/judge.mjs';

const inputs = 'bench/data/inputs', goldens = 'bench/data/golden';
const available = existsSync(inputs) && existsSync(goldens);

test('парсер принимает сохранённые исторические ответы судьи без сетевых вызовов', { skip: !available }, t => {
  try {
    const files = readdirSync(inputs).filter(name => /^[1-9]\d*\.json$/.test(name)).sort();
    if (!files.length || files.some(name => !existsSync(join(goldens, name)))) throw new Error();
    let errors = 0;
    for (const name of files) {
      const packet = JSON.parse(readFileSync(join(inputs, name), 'utf8'));
      const golden = JSON.parse(readFileSync(join(goldens, name), 'utf8'));
      const prepared = { facts_packet: packet, deal_card: packet.deal_card, communications: [], transcription_stats: {} };
      const parsed = parseJudgeResponse({ content: JSON.stringify(golden.judge), model: 'historical-fixture' }, prepared, 'тест', Date.now());
      if (parsed.error || parsed.proof_errors_count !== golden.proof_errors_count) throw new Error();
      errors += parsed.proof_errors_count;
    }
    assert.ok(files.length > 0);
    t.diagnostic(`Пакетов: ${files.length}; число ошибок ссылок совпало: ${errors}`);
  } catch { throw new Error('Исторический парсер не прошёл сравнение'); }
});
