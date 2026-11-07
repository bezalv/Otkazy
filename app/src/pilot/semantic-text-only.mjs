// Однократная оценка только текста Wazzup; без карточки, CRM, судьи и аудио.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { databaseConfig } from '../operator/triage.mjs';
import { createDeadlinePool } from '../db/deadline-pool.mjs';
import { createSavedReplayClient } from './replay-command.mjs';
import { withAudioInspectionResources } from './audio-inspect.mjs';
import { sealEvidenceReport } from './evidence-review.mjs';
import { inferChatRoles } from '../analysis/chat-role-inference.mjs';

const GOLD = Object.freeze({f001:'client',f005:'client',f006:'client',f008:'client',f009:'client',f011:'client',
  f013:'client',f014:'client',f015:'client',f016:'client',f019:'client',f004:'manager',f007:'manager',
  f010:'manager',f012:'manager',f020:'manager'});
const LIMITATIONS = Object.freeze(['saved_facts_only','synthetic_single_session','model_is_nondeterministic',
  'semantic_role_is_inference_not_proof','not_full_pipeline','neutral_ground_truth_unverified']);

export function strictPolzaFetch(url, options = {}) {
  if (url !== 'https://api.polza.ai/api/v1/chat/completions' || options.method !== 'POST') throw new Error('Адресат запрещён');
  return globalThis.fetch(url, { ...options, redirect:'error' });
}

// Возвращаем только коммуникации выбранного канала и map локальных ID. Сторона
// из исторической разметки намеренно не переносится в запрос к модели.
export function prepareTextOnly(facts, cutoff) {
  if (!Array.isArray(facts) || facts.length !== 19 || !cutoff) throw new Error('Выборка не подтверждена');
  const cutoffDate = new Date(cutoff);
  if (!Number.isFinite(cutoffDate.getTime())) throw new Error('Дата не подтверждена');
  const seen = new Set();
  const rows = facts.map(f => {
    if (!f || typeof f.fact_id !== 'string' || !/^f\d{3}$/.test(f.fact_id) || seen.has(f.fact_id)
        || typeof f.content !== 'string' || !f.content.trim() || f.content.length > 5000
        || typeof f.ts !== 'string') throw new Error('Некорректная реплика');
    const at = new Date(f.ts);
    if (!Number.isFinite(at.getTime()) || at > cutoffDate) throw new Error('Дата реплики не подтверждена');
    seen.add(f.fact_id);
    const text = f.content.replace(/^\s*\*[\p{Lu}][\p{L}'-]+(?:\s+[\p{Lu}][\p{L}'-]+){1,3}:\*\s*/u, '').trim();
    if (!text) throw new Error('Пустая реплика');
    return { fact_id: f.fact_id, text, at: at.toISOString() };
  }).sort((a,b) => a.at.localeCompare(b.at));
  if (Object.keys(GOLD).some(id => !seen.has(id)) || !seen.has('f002') || !seen.has('f003')
      || rows.some((x,i) => i && x.at === rows[i-1].at)) throw new Error('Порядок не подтверждён');
  const communications = rows.map((r,i) => ({ type:'chat', connector_id:'wazzup', chat_id:'1', session_id:'1',
    message_id:`m${String(i+1).padStart(3,'0')}`, date:r.at, text:r.text, role:'unknown', direction:'unknown',
    author_name:'Участник чата', _wazzup_author_ambiguous:true }));
  return { communications, factIds:rows.map(r=>r.fact_id), cutoff:cutoffDate.toISOString() };
}

export function buildReport(prepared, result) {
  const items = result?.evidence?.[0]?.messages;
  if (!Array.isArray(items) || result.evidence.length !== 1 || items.length !== prepared.factIds.length
      || result.stats?.model_calls !== 1) return { status:'unverified',deal_id:'127114',analysis_id:'1968',service_closed:true };
  const roles=items.map((item,i)=>({fact_id:prepared.factIds[i],predicted:item.predicted_role,
    effective:item.effective_role,impact:item.impact,nonmaterial_unknown:item.nonmaterial_unknown}));
  const scored=roles.filter(x=>Object.hasOwn(GOLD,x.fact_id));
  if(scored.length!==16) throw new Error('Эталон не подтверждён');
  return {status:'evaluated',deal_id:'127114',analysis_id:'1968',ground_truth:'user_confirmed',messages:roles.length,
    evaluated:scored.length,correct:scored.filter(x=>x.predicted===GOLD[x.fact_id]).length,
    incorrect:scored.filter(x=>x.predicted!=='unknown' && x.predicted!==GOLD[x.fact_id]).length,
    unknown:scored.filter(x=>x.predicted==='unknown').length,roles,
    model_calls:result.stats.model_calls,usage:result.stats.usage,usage_complete:result.stats.usage_complete,
    limitations:[...LIMITATIONS],service_closed:true};
}

async function readSelected(pool) {
  const connection = await pool.connect(); let releaseError;
  try {
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const mode=await connection.query("SELECT current_setting('transaction_read_only') AS read_only");
    if(mode.rows?.length!==1 || mode.rows[0].read_only!=='on') throw new Error('Режим чтения не подтверждён');
    // SQL извлекает только текст, локальные ID и время нужного чата плюс дату
    // отказа; другие факты и поля карточки не покидают БД в этом запросе.
    const data=await connection.query(`SELECT d.lose_date, COALESCE(jsonb_agg(jsonb_build_object(
      'fact_id',f->>'fact_id','content',f->>'content','ts',f->>'ts') ORDER BY ord), '[]'::jsonb) AS facts
      FROM public.lost_deal_analyses a JOIN public.lost_deals d ON d.deal_id=a.deal_id
      CROSS JOIN LATERAL jsonb_array_elements(a.ai_facts_json::jsonb->'facts') WITH ORDINALITY AS x(f,ord)
      WHERE a.deal_id=127114 AND a.id=1968 AND a.pipeline_error IS NULL
        AND f->>'source'='chat' AND f->>'channel'='WAZZUP: Max' GROUP BY d.lose_date`);
    if(data.rows?.length!==1) throw new Error('Выборка не подтверждена');
    const prepared=prepareTextOnly(data.rows[0].facts,data.rows[0].lose_date);
    await connection.query('COMMIT'); return prepared;
  } catch { try { await connection.query('ROLLBACK'); } catch(e) { releaseError=e; } throw new Error('Чтение не выполнено'); }
  finally { connection.release(releaseError); }
}

export async function runTextOnly({env=process.env,makePool=async config=>{const {default:pg}=await import('pg');return new pg.Pool(config);},
  makeClient=createSavedReplayClient,load=readSelected}={}) {
  if(typeof env.POLZA_API_KEY!=='string'||!env.POLZA_API_KEY.trim())throw new Error('Не задан ключ модели');
  const raw=await makePool(databaseConfig(env)); raw.on?.('error',()=>{});
  const pool=createDeadlinePool(raw), ctrl=new AbortController(); let cleanupUnknown=false;
  const result=await withAudioInspectionResources({deadlineMs:140000,closeLimiter:()=>ctrl.abort(),closePool:()=>pool.end(),
    run:async signal=>{
      signal.addEventListener('abort',()=>ctrl.abort(),{once:true});
      const prepared=await load(pool); signal.throwIfAborted();
      const client=makeClient({apiKey:env.POLZA_API_KEY,signal:ctrl.signal,onCleanupUnknown(){cleanupUnknown=true;},
        fetchImpl:strictPolzaFetch,wait:async()=>{throw new Error('Повтор отключён');}});
      let calls=0;
      const restricted={async complete(body, options) {
        if(++calls!==1 || options?.role!=='chat-role-inference') throw new Error('Лимит запроса');
        const expected=prepared.communications.map((x,i)=>({id:`m${String(i+1).padStart(3,'0')}`,text:x.text}));
        const allowedFields=['model','provider','reasoning','temperature','max_tokens','messages','response_format'];
        if(!Array.isArray(body?.messages) || body.messages.length!==2 || body.messages[0]?.role!=='system'
          || !body || Object.keys(body).length!==allowedFields.length || !allowedFields.every(k=>Object.hasOwn(body,k))
          || body.model!=='openai/gpt-6-sol' || typeof body.messages[0]?.content!=='string' || body.messages[0].content.length>2000
          || body.messages.some(m=>!m || Object.keys(m).length!==2 || !Object.hasOwn(m,'role') || !Object.hasOwn(m,'content'))
          || body.messages[1]?.role!=='user' || body.messages[1]?.content!==JSON.stringify({messages:expected})) throw new Error('Состав запроса не подтверждён');
        return client.complete(body,options);
      }};
      let classified;
      try { classified=await inferChatRoles({communications:prepared.communications,cutoff:prepared.cutoff,client:restricted}); }
      finally { if(cleanupUnknown){const e=new Error('Завершение не подтверждено');e.code='AUDIO_CLEANUP_UNKNOWN';throw e;} }
      return buildReport(prepared,classified);
    }});
  if(result.resources_closed!==true)throw new Error('Завершение не подтверждено');
  return result.status==='completed' && Array.isArray(result.roles)
    ? {...result,status:'evaluated',service_closed:true}
    : {status:'unverified',deal_id:'127114',analysis_id:'1968',service_closed:true};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==4 || process.argv[2]!=='--sealed'){console.error('Нужен защищённый режим');process.exitCode=1;}
  else Promise.resolve().then(()=>{sealEvidenceReport({service_closed:true},process.argv[3]);return runTextOnly();})
    .then(value=>console.log(JSON.stringify(sealEvidenceReport(value,process.argv[3]))))
    .catch(()=>{console.error('Проверка не завершена');process.exitCode=1;});
}
