import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runManualPrejudge } from '../../app/src/pilot/manual-prejudge.mjs';

// Только одноразовый локальный сервер из run-local-real-pg.sh, не DATABASE_URL.
const socket=process.env.OTKAZY_LOCAL_PG_SOCKET;
const enabled=process.env.OTKAZY_LOCAL_PG_TEST==='1' && /^\/tmp\/otkazy-local-pg-[A-Za-z0-9]{8}$/.test(socket||'')
  && process.env.OTKAZY_LOCAL_PG_PORT==='56471';
const requireApp=createRequire(new URL('../../app/package.json',import.meta.url));
const cutoff='2026-11-04T00:00:00Z',runId='00000000-0000-4000-8000-000000000111';

test('ручной staging сохраняет транскрипт до судьи без основной очереди в PostgreSQL',
  {skip:!enabled,timeout:15000},async()=>{
    const {Pool}=requireApp('pg');
    const pool=new Pool({host:socket,port:56471,user:'otkazytest',database:'otkazytest',ssl:false,max:3,connectionTimeoutMillis:3000});
    try {
      const identity=await pool.query("SELECT current_database() AS db, inet_server_addr() AS addr, current_setting('data_directory') AS data, current_setting('listen_addresses') AS listens");
      assert.deepEqual(identity.rows[0],{db:'otkazytest',addr:null,data:`${socket}/data`,listens:''});
      const absent=await pool.query("SELECT to_regclass('public.lost_processing_jobs') AS jobs, to_regclass('public.lost_prejudge_artifacts') AS artifacts, to_regclass('public.lost_prejudge_manual_jobs') AS manual");
      assert.deepEqual(absent.rows[0],{jobs:null,artifacts:null,manual:null});
      await pool.query('CREATE ROLE anon; CREATE ROLE authenticated');
      const stage=(await readFile('db/proposals/20261109_prejudge_artifacts.sql','utf8')).replace(/\r\n/g,'\n').trimEnd();
      const manual=(await readFile('db/proposals/20261109_prejudge_manual_jobs.sql','utf8')).replace(/\r\n/g,'\n').trimEnd();
      const combined=(await readFile('db/proposals/20261109_manual_prejudge_combined.sql','utf8')).replace(/\r\n/g,'\n').trimEnd();
      assert.equal(combined,`-- Combined staging/manual schema. Apply atomically after independent review.\nBEGIN;\n${stage}\n\n${manual}\nCOMMIT;`);
      await pool.query(combined);
      // Один выделенный клиент: BEGIN/ROLLBACK должны относиться к одному подключению.
      const smoke=await pool.connect();
      try {
        await smoke.query(await readFile('db/proposals/20261109_prejudge_manual_smoke.sql','utf8'));
        const remaining=await smoke.query(`SELECT
          (SELECT count(*)::int FROM public.lost_prejudge_manual_jobs) AS jobs,
          (SELECT count(*)::int FROM public.lost_prejudge_artifacts) AS artifacts,
          (SELECT count(*)::int FROM public.lost_prejudge_stt_attempts) AS attempts`);
        assert.deepEqual(remaining.rows[0],{jobs:0,artifacts:0,attempts:0});
      } finally { smoke.release(); }
      const judge={verdict:'правомерен',verdict_reason_short:'Клиент отказался',recoverable_level:null,
        closure_reason_class:'competitor',misplaced:false,correct_stage:null,exact_reason:'Клиент купил в другом месте',
        manager_mistakes:[],key_signals:[],risk_factors:[],questions_for_manager:[]};
      const events=[];
      const options={nowMs:Date.parse('2026-11-05T00:00:00Z'),wait:async()=>{},audioWaitEnabledAt:'2026-11-01T00:00:00Z',
        judgeSystemPrompt:'Промпт',writerSystemPrompt:'Писатель',
        bitrix:{async request(method,body){
          if(method==='crm.deal.userfield.list')return {result:[{LIST:[{ID:'1',VALUE:'Другая'}]}]};
          if(method==='crm.deal.get')return {result:{ID:'42',STAGE_ID:'C23:LOSE',ASSIGNED_BY_ID:'65',UF_CRM_1584703948317:'1'}};
          if(method==='crm.stagehistory.list')return {result:{items:[{ID:'101',STAGE_ID:'C23:LOSE',CREATED_TIME:cutoff}]}};
          if(method==='crm.activity.list' && body.filter.TYPE_ID)return {result:[{ID:'1',PROVIDER_ID:'VOXIMPLANT_CALL',COMPLETED:'Y',
            CREATED:'2026-11-03T01:00:00Z',START_TIME:'2026-11-03T01:00:00Z',END_TIME:'2026-11-03T01:01:10Z',
            SETTINGS:{RECORD_URL:'https://example.invalid/audio?fileId=101'}}]};
          if(method==='crm.activity.list'||method==='imopenlines.crm.chat.get'||method==='crm.timeline.comment.list')return {result:[]};
          if(method==='tasks.task.list')return {result:{tasks:[]}};
          throw Error(`Недопустимый метод ${method}`);
        }},
        transcribe:async request=>{events.push('stt');return {success:true,activity_id:request.activity_id,
          formatted_dialog:'Клиент: Я уже купил в другом месте',client_text:'Я уже купил в другом месте',manager_text:'',
          total_replicas:1,channel_count:2};},
        llm:{async complete(_body,{role}={}){events.push(role);
          if(role==='judge'){
            const saved=await pool.query("SELECT artifact_type,run_kind FROM public.lost_prejudge_artifacts WHERE job_id=$1",[runId]);
            assert.ok(saved.rows.some(r=>r.artifact_type==='raw_collection'));
            assert.ok(saved.rows.some(r=>r.artifact_type==='transcript'));
            assert.ok(saved.rows.some(r=>r.artifact_type==='judge_input'));
            assert.ok(saved.rows.every(r=>r.run_kind==='manual'));
          }
          return role==='writer'?{choices:[{message:{content:'Итог'}}]}:{choices:[{message:{content:JSON.stringify(judge)}}]};
        }} };
      const result=await runManualPrejudge({pool,dealId:42,stageHistoryId:'101',loseDate:cutoff,options,uuid:()=>runId});
      assert.equal(result.result.status,'processed');assert.equal(result.resultSaved,true);assert.deepEqual(events,['stt','judge']);
      assert.equal((await pool.query("SELECT to_regclass('public.lost_processing_jobs') AS jobs")).rows[0].jobs,null);
      assert.equal((await pool.query('SELECT status FROM public.lost_prejudge_manual_jobs WHERE id=$1',[runId])).rows[0].status,'completed');
      const saved=await pool.query("SELECT payload FROM public.lost_prejudge_artifacts WHERE job_id=$1 AND artifact_type='judge_result' AND run_kind='manual'",[runId]);
      assert.equal(saved.rowCount,1);assert.equal(saved.rows[0].payload.analysis.multi_agent_analysis.verdict,'правомерен');
      await assert.rejects(pool.query(`INSERT INTO public.lost_prejudge_artifacts
        (job_id,deal_id,stage_history_id,lose_date,artifact_type,artifact_key,payload,payload_sha256,run_kind)
        VALUES ($1,42,'101',$2,'judge_result',repeat('0',64),'{}',repeat('0',64),'automatic')`,[runId,cutoff]));
    } finally { await pool.end(); }
  });
