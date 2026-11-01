import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root = new URL('../../', import.meta.url);
const lib = fs.readFileSync(new URL('prototype/lib/audio-wait.js', root), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(lib, ctx);
const now = Date.parse('2026-11-01T10:00:00Z');
const iso = ms => new Date(ms).toISOString();
const lose = iso(now - 60000), enabled = iso(now - 3600000);
const call = { ID: '123', PROVIDER_ID: 'VOXIMPLANT_CALL', COMPLETED: 'Y', CREATED: iso(now - 180000), START_TIME: iso(now - 180000), END_TIME: iso(now - 120000), FILES: [] };
const assess = (calls = [call], saved = null, at = now, lost = lose) => ctx.awAssess(calls, lost, enabled, saved, at);
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('ok ' + name); }
check('только будущие переходы', () => assert.equal(assess([call], null, now, iso(now - 7200000)).state, 'disabled'));
check('нет даты — нет исторического перезапуска', () => assert.equal(assess([call], null, now, null).state, 'disabled'));
check('нет звонков — обычный разбор', () => assert.equal(assess([]).state, 'ready'));
const first = assess();
check('звонок без файла — очередь на 5 минут', () => { assert.equal(first.state, 'waiting'); assert.equal(first.queue.next_check_at, iso(now + 300000)); });
const saved = { ...first.queue, state: 'waiting' };
check('после 5 минут проверка на 15-й', () => assert.equal(assess([call], saved, now + 300000).queue.next_check_at, iso(now + 900000)));
check('дубли не сдвигают дедлайн', () => assert.equal(assess([call], saved, now + 600000).queue.deadline_at, iso(now + 86400000)));
check('после 8 часов — контроль через сутки', () => assert.equal(assess([call], saved, now + 8 * 3600000).queue.next_check_at, iso(now + 86400000)));
const file = { ...call, FILES: [{ url: 'https://example.test/audio.mp3' }] };
check('файл появился — можно транскрибировать', () => assert.equal(assess([file], saved, now + 1000000).state, 'ready'));
check('сохраняется время обнаружения файла', () => assert.equal(assess([file], saved, now + 1000000).queue.observations['123'].first_audio_seen_at, iso(now + 1000000)));
check('ID файла без URL не считается аудио', () => assert.equal(assess([{ ...call, FILES: [{ id: 7 }] }]).state, 'waiting'));
check('RECORD_URL учитывается', () => assert.equal(assess([{ ...call, SETTINGS: { RECORD_URL: 'https://example.test/audio' } }]).state, 'ready'));
check('напоминание не является звонком', () => assert.equal(assess([{ ...call, CREATED: iso(now - 7200000) }]).state, 'ready'));
check('незавершённое дело не блокирует', () => assert.equal(assess([{ ...call, COMPLETED: 'N' }]).state, 'ready'));
check('нулевая длительность не блокирует', () => assert.equal(assess([{ ...call, END_TIME: call.START_TIME }]).state, 'ready'));
check('старые отсутствующие архивы не блокируют новый отказ', () => assert.equal(assess([{ ...call, CREATED: iso(now - 2 * 86400000), START_TIME: iso(now - 2 * 86400000), END_TIME: iso(now - 2 * 86400000 + 1000) }]).state, 'ready'));
check('исчезновение звонка не открывает шлюз', () => assert.equal(assess([], saved).state, 'waiting'));
check('все записи должны появиться', () => assert.equal(assess([file, { ...call, ID: '456' }], saved).state, 'waiting'));
check('ровно через сутки — нехватка данных', () => assert.equal(assess([call], saved, now + 86400000).state, 'expired'));
check('файл на последней проверке допускает анализ', () => assert.equal(assess([file], saved, now + 86400000).state, 'ready'));
check('истёкшие очереди не пересчитываются', () => assert.equal(assess([file], { ...saved, state: 'expired' }).state, 'terminal'));
check('новый переход в отказ получает новое ожидание', () => assert.equal(assess([call], { ...saved, state: 'expired', lose_date: iso(now - 1800000) }).state, 'waiting'));

if (fs.existsSync(new URL('tmp/audio-wait/Обработать 1 сделку.js', root))) {
const processCode = fs.readFileSync(new URL('tmp/audio-wait/Обработать 1 сделку.js', root), 'utf8');
const sqlCode = fs.readFileSync(new URL('tmp/audio-wait/Подготовить SQL.js', root), 'utf8');
async function runProcess(calls, queue, at = now, broken = false) {
  const hit = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return at; } }
  const input = { deal_id: 777, B24_API: 'https://example.test', BLOCK3_WEBHOOK: 'https://example.test/lost-analysis', silent: false };
  const context = { Date: Clock, console: { log() {} }, $input: { first: () => ({ json: { enabled_at: enabled, audio_wait: queue } }) }, $: () => ({ item: { json: input } }), helpers: { httpRequest: async o => {
    hit.push(o.url);
    if (o.url.includes('userfield.list')) return { result: [] };
    if (o.url.includes('crm.deal.get')) return { result: { ID: '777', STAGE_ID: 'C23:LOSE', TITLE: 'test' } };
    if (o.url.includes('stagehistory')) return { result: [{ STAGE_ID: 'C23:LOSE', CREATED_TIME: lose }, { STAGE_ID: 'C23:NEW' }] };
    if (o.url.includes('activity.list') && o.body.filter.TYPE_ID === 2) return broken ? { error: 'ACCESS_DENIED' } : { result: calls };
    if (o.url.includes('lost-analysis')) return { multi_agent_analysis: { verdict: 'правомерен' } };
    return { result: [] };
  } } };
  const value = await vm.runInNewContext('(async function(){' + processCode + '\n}).call({helpers: helpers})', context);
  return { result: value[0].json, hit };
}
function sql(result) {
  return vm.runInNewContext('(function(){' + sqlCode + '\n})()', { $input: { first: () => ({ json: result }) } })[0].json.sql;
}
const waiting = await runProcess([call], null);
check('интеграция: ожидание не вызывает анализ и чаты', () => { assert.equal(waiting.result._status, 'waiting_audio'); assert.equal(waiting.hit.length, 4); });
check('ожидание не создаёт вердикт в БД', () => { const s = sql(waiting.result); assert.match(s, /INSERT INTO public.lost_audio_wait/); assert.doesNotMatch(s, /INSERT INTO lost_deal_analyses/); });
const expired = await runProcess([call], saved, now + 86400000);
check('истечение не вызывает судью', () => { assert.equal(expired.result.multi_agent_analysis.verdict, 'недостаточно_данных'); assert.equal(expired.hit.length, 4); });
check('вердикт и завершение очереди атомарны', () => { const s = sql(expired.result); assert.match(s, /^BEGIN;/); assert.match(s, /недостаточно_данных/); assert.match(s, /'expired'/); assert.match(s, /COMMIT;$/); });
const ready = await runProcess([file], saved);
check('появившийся файл отправляется в штатный анализ', () => { assert.equal(ready.result._status, 'processed', JSON.stringify(ready.result)); assert.ok(ready.hit.some(x => x.includes('lost-analysis'))); assert.ok(ready.result.deal_data.communications[0]._needs_transcription); });
check('успешный разбор закрывает очередь', () => assert.match(sql(ready.result), /'done'/));
const failed = await runProcess([], saved, now, true);
check('ошибка API не принимается за пустой список', () => { assert.equal(failed.result._status, 'error'); assert.ok(!failed.hit.some(x => x.includes('lost-analysis'))); });
check('сбой анализа не завершает ожидание', () => assert.doesNotMatch(sql({ ...ready.result, _status: 'error', _error: 'test' }), /'done'/));
if (process.argv.includes('--sql-fixture')) {
  const fixture = { ...waiting.result, deal_id: 1999999999, deal_data: { ...waiting.result.deal_data, deal_id: 1999999999 } };
  const final = { ...expired.result, deal_id: 1999999999, deal_data: fixture.deal_data };
  const finishSql = sql(final).replace(/^BEGIN;\s*/, '').replace(/COMMIT;$/, '');
  const claimSql = fs.readFileSync(new URL('tmp/audio-wait/claim.sql', root), 'utf8');
  fs.writeFileSync(new URL('tmp/audio-wait/sql-fixture.sql', root), 'BEGIN;\n' + sql(fixture) + '\n' + claimSql + '\n' + finishSql + '\nSELECT state FROM public.lost_audio_wait WHERE deal_id=1999999999;\nROLLBACK;');
}
} else {
  console.log('Интеграция с нодами пропущена: сначала выполните bench/build-audio-wait.mjs с экспортом пакета.');
}
console.log(checks + ' проверок пройдено');
