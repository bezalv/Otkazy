import 'dotenv/config';
import { writeFileSync } from 'fs';
import { assembleFacts } from './lib/facts_assembler.js';
import { runJudge } from './lib/judge.js';
import { validateProofs } from './lib/proof_validator.js';
import { runWriter } from './lib/writer.js';

async function main() {
  const dealId = parseInt(process.argv[2], 10);
  if (!dealId) {
    console.error('Usage: node run.js <deal_id>');
    process.exit(1);
  }

  console.log(`\n=== Отказы: анализ сделки ${dealId} ===\n`);

  // ── Step 1: Facts Assembler (детерминированный) ──
  console.log('[1/4] Facts Assembler...');
  const factsPacket = await assembleFacts(dealId);
  console.log(`  deal: ${factsPacket.deal_card.title || '?'}`);
  console.log(`  lose_reason: ${factsPacket.deal_card.lose_reason || 'N/A'}`);
  console.log(`  facts: ${factsPacket.facts.length} шт.`);
  console.log(`  metrics: calls_total=${factsPacket.metrics.calls_total ?? '?'}, chats_total=${factsPacket.metrics.chats_total ?? '?'}`);

  writeFileSync(`output/deal_${dealId}_facts.json`, JSON.stringify(factsPacket, null, 2), 'utf8');
  console.log(`  → output/deal_${dealId}_facts.json\n`);

  // ── Step 2: Judge (LLM) ──
  console.log('[2/4] Judge...');
  const judgeResponse = await runJudge(factsPacket);
  console.log(`  parseMethod: ${judgeResponse.parseMethod}`);
  console.log(`  model: ${judgeResponse.model || 'n/a'}`);
  console.log(`  tokens: prompt=${judgeResponse.usage?.prompt_tokens ?? '?'}, completion=${judgeResponse.usage?.completion_tokens ?? '?'}`);

  if (!judgeResponse.parsed) {
    // Сохранить raw ответ для анализа
    writeFileSync(`output/deal_${dealId}_judge_raw.txt`, judgeResponse.raw, 'utf8');
    console.error('  ОШИБКА: Judge вернул невалидный JSON. Сохранён → output/deal_' + dealId + '_judge_raw.txt');
    process.exit(2);
  }

  const judge = judgeResponse.parsed;
  console.log(`  verdict: ${judge.verdict}`);
  console.log(`  reason: ${judge.verdict_reason_short}`);
  console.log(`  closure_class: ${judge.closure_reason_class}`);
  if (judge.recoverable_level) console.log(`  recoverable: ${judge.recoverable_level}`);
  if (judge.misplaced) console.log(`  misplaced → ${judge.correct_stage}`);

  writeFileSync(`output/deal_${dealId}_judge.json`, JSON.stringify(judge, null, 2), 'utf8');
  console.log(`  → output/deal_${dealId}_judge.json\n`);

  // ── Step 3: Proof Validator (детерминированный) ──
  console.log('[3/4] Proof Validator...');
  const validation = validateProofs(judge, factsPacket.facts, factsPacket.metrics);
  console.log(`  refs: ${validation.stats.total_refs} total, ${validation.stats.valid_refs} valid, ${validation.stats.invalid_refs} invalid`);

  if (!validation.valid) {
    console.log('  ISSUES:');
    for (const issue of validation.issues) {
      console.log(`    ⚠ ${issue}`);
    }
  } else {
    console.log('  все пруфы валидны');
  }

  writeFileSync(`output/deal_${dealId}_validation.json`, JSON.stringify(validation, null, 2), 'utf8');
  console.log(`  → output/deal_${dealId}_validation.json\n`);

  // ── Step 4: Writer (LLM, только если неправомерен) ──
  if (judge.verdict === 'неправомерен') {
    console.log('[4/4] Writer...');
    const writerResult = await runWriter(factsPacket, judge);
    console.log(`  model: ${writerResult.model || 'n/a'}`);
    console.log(`  tokens: prompt=${writerResult.usage?.prompt_tokens ?? '?'}, completion=${writerResult.usage?.completion_tokens ?? '?'}`);

    writeFileSync(`output/deal_${dealId}_comment.txt`, writerResult.text, 'utf8');
    console.log(`  → output/deal_${dealId}_comment.txt`);
    console.log('\n─── КОММЕНТАРИЙ ДЛЯ BITRIX24 ───\n');
    console.log(writerResult.text);
    console.log('\n─────────────────────────────────\n');
  } else {
    console.log('[4/4] Writer... пропущен (verdict="правомерен")\n');
  }

  // ── Итог ──
  console.log(`=== Готово: сделка ${dealId} ===`);
  console.log(`verdict=${judge.verdict}, class=${judge.closure_reason_class}, recoverable=${judge.recoverable_level || 'n/a'}`);
  if (!validation.valid) {
    console.log(`⚠ Proof Validator нашёл ${validation.issues.length} проблем(ы)`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
