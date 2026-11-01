import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const backup = path.join(root, process.argv[2] || 'tmp/backup/2026-11-01-audio-wait');
const out = path.join(root, 'tmp/audio-wait');
fs.mkdirSync(out, { recursive: true });
const lib = fs.readFileSync(path.join(root, 'prototype/lib/audio-wait.js'), 'utf8');
const wf = JSON.parse(fs.readFileSync(path.join(backup, 'batch.json'), 'utf8'));
function replaceOnce(s, a, b) {
  if (s.split(a).length !== 2) throw new Error('Неоднозначный якорь: ' + a.slice(0, 90));
  return s.replace(a, b);
}
let processCode = wf.nodes.find(n => n.name === 'Обработать 1 сделку').parameters.jsCode;
processCode = replaceOnce(processCode, 'var input = $input.first().json;', "var input = $('По одной сделке').item.json;\nvar audioContext = $input.first().json;\nvar audioWaitResult = null;\n" + lib);
const waitStart = processCode.indexOf('  // === CONDITIONAL WAIT');
const waitEnd = processCode.indexOf('  var allCalls = [];', waitStart);
if (waitStart < 0 || waitEnd < 0) throw new Error('Не найдена прежняя пауза');
processCode = processCode.slice(0, waitStart) + processCode.slice(waitEnd);
processCode = replaceOnce(processCode, 'allCalls = allCalls.concat(cpr.result || []);', "if (cpr.error || !Array.isArray(cpr.result)) throw new Error('Не получен список звонков: ' + (cpr.error || 'неверный ответ')); allCalls = allCalls.concat(cpr.result);");
processCode = replaceOnce(processCode, "_status: 'error', _error: 'Not in suspended stage'", "_status: 'skipped', _reason: 'not_in_lost_stage'");
const gate = `
  // Не делаем вывод по отсутствующей записи. В ожидании не собираем платные источники.
  if (_sources.calls.complete) {
    audioWaitResult = awAssess(allCalls, loseDate, audioContext.enabled_at, audioContext.audio_wait, Date.now());
    if (audioWaitResult.state === 'terminal') {
      return [{ json: { deal_id: dealId, _status: 'skipped', _reason: 'audio_wait_terminal', silent: SILENT } }];
    }
    if (audioWaitResult.state === 'waiting' || audioWaitResult.state === 'expired') {
      var awExpired = audioWaitResult.state === 'expired';
      var awReason = 'Запись звонка не появилась в течение 24 часов ожидания. Содержание разговора неизвестно; оценка действий менеджера не выносилась.';
      return [{ json: {
        deal_id: dealId, title: dealData.title, deal_data: dealData,
        _status: awExpired ? 'processed' : 'waiting_audio',
        audio_wait: audioWaitResult.queue, audio_wait_screenshots: SCREENSHOTS,
        audio_wait_expired: awExpired, silent: SILENT, prompt_version: PROMPT_VERSION,
        classification: awExpired ? { summary: awReason, exact_reason: awReason } : null,
        multi_agent_analysis: awExpired ? {
          verdict: 'недостаточно_данных', verdict_reason_short: 'не получена запись звонка',
          exact_reason: awReason, final_comment: awReason, manager_mistakes: [],
          recoverable_level: null, judge_model: 'none (audio-wait gate)',
          audio_wait: audioWaitResult.queue
        } : null,
        processing_time_sec: Math.round((Date.now() - startTime) / 1000),
        _index: input._index, _total: input._total
      } }];
    }
  }
`;
processCode = replaceOnce(processCode, '  var allComments = [];', gate + '\n  var allComments = [];');
processCode = replaceOnce(processCode, 'communications_with_transcripts: block345Result.communications', 'audio_wait: audioWaitResult && audioWaitResult.queue, audio_wait_screenshots: SCREENSHOTS, communications_with_transcripts: block345Result.communications');
let sqlCode = wf.nodes.find(n => n.name === 'Подготовить SQL').parameters.jsCode;
sqlCode = lib + '\n' + sqlCode;
sqlCode = replaceOnce(sqlCode, "if (r._status !== 'processed') {", `if (r._status === 'waiting_audio') {
  return [{ json: { sql: awQueueSql(r, 'waiting'), _status: r._status, _deal_id: r.deal_id } }];
}
var awCancel = r._status === 'skipped' || r._status === 'skipped_by_reason'
  ? "UPDATE public.lost_audio_wait SET state='cancelled', lease_until=NULL, updated_at=NOW() WHERE deal_id=" + Number(r.deal_id) + " AND state='waiting';" : '';
if (r._status !== 'processed') {`);
sqlCode = replaceOnce(sqlCode, "var tailSql = 'SELECT 1;';", "var tailSql = awCancel || 'SELECT 1;';");
sqlCode = replaceOnce(sqlCode, 'sql: dupSql,', 'sql: dupSql + awCancel,');
sqlCode = replaceOnce(sqlCode, "return [{ json: { sql: allSql.join('\\n'),", "var awFinalSql = awQueueSql(r, r.audio_wait_expired ? 'expired' : 'done');\nif (awFinalSql) allSql.push(awFinalSql);\nreturn [{ json: { sql: (awFinalSql ? 'BEGIN;\\n' : '') + allSql.join('\\n') + (awFinalSql ? '\\nCOMMIT;' : ''),");
let selectCode = wf.nodes.find(n => n.name === 'Получить сделки из Bitrix').parameters.jsCode;
selectCode = replaceOnce(selectCode, 'Date.now() - 30 * 60 * 1000', 'Date.now() - 60 * 60 * 1000');
selectCode = selectCode.replace('старше 30 мин', 'старше 60 мин: сбор плюс анализ могут занимать больше 30 минут');
for (const [name, code] of [['Обработать 1 сделку', processCode], ['Подготовить SQL', sqlCode], ['Получить сделки из Bitrix', selectCode]]) {
  new Function('return (async function(){' + code + '\n})');
  fs.writeFileSync(path.join(out, name + '.js'), code);
}
const cred = wf.nodes.find(n => n.type === 'n8n-nodes-base.postgres').credentials;
const context = {
  name: 'audio-wait-context', type: 'n8n-nodes-base.postgres', typeVersion: 2.6,
  position: [500, 300], credentials: cred,
  parameters: { operation: 'executeQuery', query: 'SELECT c.enabled_at, (SELECT to_jsonb(q) FROM public.lost_audio_wait q WHERE q.deal_id=$1) AS audio_wait FROM public.lost_audio_wait_config c WHERE c.id=true;', options: { queryReplacement: '={{ [Number($json.deal_id)] }}' } }
};
fs.writeFileSync(path.join(out, 'context.json'), JSON.stringify(context, null, 2));
const claim = `WITH due AS (
 SELECT q.deal_id FROM public.lost_audio_wait q
 WHERE q.state='waiting' AND q.next_check_at<=NOW()
 AND (q.lease_until IS NULL OR q.lease_until<NOW())
 AND NOT EXISTS (SELECT 1 FROM public.deal_processing_locks l WHERE l.deal_id=q.deal_id AND l.locked_at>NOW()-INTERVAL '65 minutes')
 ORDER BY q.next_check_at LIMIT 2 FOR UPDATE SKIP LOCKED
) UPDATE public.lost_audio_wait q SET lease_until=NOW()+INTERVAL '65 minutes'
FROM due WHERE q.deal_id=due.deal_id RETURNING q.deal_id, q.silent, q.screenshots;`;
fs.writeFileSync(path.join(out, 'claim.sql'), claim);
const scheduler = `const tick = trigger({type:'n8n-nodes-base.scheduleTrigger',version:1.3,config:{name:'Каждые 5 минут',parameters:{rule:{interval:[{field:'minutes',minutesInterval:5}]}}},output:[{timestamp:'2026-11-01T00:00:00Z'}]});
const claim = node({type:'n8n-nodes-base.postgres',version:2.6,config:{name:'Забрать ожидающие записи',parameters:{operation:'executeQuery',query:${JSON.stringify(claim)},options:{}},credentials:${JSON.stringify(cred)}},output:[{deal_id:1,silent:false,screenshots:false}]});
const dispatch = node({type:'n8n-nodes-base.httpRequest',version:4.2,config:{name:'Повторить сбор сделки',onError:'continueRegularOutput',parameters:{method:'POST',url:'https://bezalv.ru/webhook/lost-batch',sendBody:true,specifyBody:'json',jsonBody:expr('{{ JSON.stringify({deal_ids:[Number($json.deal_id)],silent:$json.silent===true,screenshots:$json.screenshots===true}) }}'),options:{timeout:30000,batching:{batch:{batchSize:1,batchInterval:1000}}}}},output:[{status:'started'}]});
export default workflow('lost-audio-wait','Отказ: Ожидание записи звонка').add(tick).to(claim).to(dispatch);`;
fs.writeFileSync(path.join(out, 'scheduler.ts'), scheduler);
console.log('Подготовлены 3 Code-ноды, контекст и планировщик. Секреты остаются в tmp/.');
