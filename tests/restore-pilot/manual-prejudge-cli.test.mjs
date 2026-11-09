import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createManualPaidAdapters, parseManualPrejudgeOptions } from '../../app/src/pilot/manual-prejudge-cli.mjs';

const env = {
  DATABASE_URL:'postgresql://user:pass@example.invalid/db', BITRIX_REST_BASE:'https://example.invalid/rest/',
  POLZA_API_KEY:'test-key', TEST_POLZA_BASELINE_RUB:'1', TEST_POLZA_PRIOR_RESERVED_RUB:'0',
  TEST_POLZA_LIMIT_RUB:'50', TEST_POLZA_STT_RESERVE_RUB:'2', TEST_POLZA_MODEL_RESERVE_RUB:'5',
  TEST_POLZA_MAX_STT_PARTS:'1', TEST_POLZA_LOCK_PATH:resolve('tmp/test.lock'), TEST_POLZA_JOURNAL_PATH:resolve('tmp/test.jsonl'),
};
const args = ['126276','123','2026-10-13T00:00:00.000Z'];

test('ручной тест требует идентификаторы перехода и явный бюджет', () => {
  assert.equal(parseManualPrejudgeOptions(args, env).dealId, 126276);
  assert.throws(() => parseManualPrejudgeOptions(args.slice(0,2), env));
  assert.throws(() => parseManualPrejudgeOptions(args, {...env, TEST_POLZA_LIMIT_RUB:'501'}));
  assert.throws(() => parseManualPrejudgeOptions(args, {...env, TEST_POLZA_PRIOR_RESERVED_RUB:'50'}));
  assert.throws(() => parseManualPrejudgeOptions(args, {...env, TEST_POLZA_JOURNAL_PATH:env.TEST_POLZA_LOCK_PATH}));
});

test('распознавание и модель допускаются только через бюджет, без повторов', async () => {
  const trace = [];
  const signal = new AbortController().signal;
  const guard = {
    async runUnpricedAudio(amount, fn, options) {
      trace.push(['reserve-audio',amount,options]);
      return { settled:true, accounted_as:'unpriced_reserve', response:await fn({signal}) };
    },
    async run(amount, fn) { trace.push(['reserve-model',amount]); return {settled:true,response:await fn({signal})}; },
  };
  const fetchImpl = async (url, options) => {
    trace.push(['post',url,options.method]);
    const body = url.endsWith('transcriptions') ? {text:'клиент'} : {usage:{cost_rub:0.2}, choices:[]};
    return new Response(JSON.stringify(body), {status:200});
  };
  const paid = createManualPaidAdapters({key:'test-key',guard,signal,fetchImpl,sttReserveRub:2,modelReserveRub:5,maxSttParts:1});
  assert.deepEqual(await paid.budgetTransport({audio:Buffer.from('fake'),model:'ai-sage/gigaam-v3',signal}), {text:'клиент'});
  await assert.rejects(paid.budgetTransport({audio:Buffer.from('fake'),model:'ai-sage/gigaam-v3',signal}));
  await assert.rejects(paid.llm.complete({model:'different-model',max_tokens:2}, {role:'judge'}));
  await paid.llm.complete({model:'openai/gpt-6-sol',max_tokens:2}, {role:'writer'});
  assert.deepEqual(trace.map(item => item[0]), ['reserve-audio','post','reserve-model','post']);
  assert.equal(trace[0][2].allowEmptyText, true);
});
