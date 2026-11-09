-- Синтетическая проверка трёх новых таблиц на выделенном подключении.
-- Никаких существующих таблиц или реальных сделок не затрагивает.
BEGIN;
INSERT INTO public.lost_prejudge_manual_jobs
  (id,request_key,deal_id,stage_history_id,lose_date,status)
VALUES ('00000000-0000-4000-8000-000000000999',
  'manual-test:00000000-0000-4000-8000-000000000999', 42, '101',
  '2026-11-04T00:00:00Z', 'running');
INSERT INTO public.lost_prejudge_artifacts
  (job_id,deal_id,stage_history_id,lose_date,artifact_type,artifact_key,payload,payload_sha256,run_kind)
VALUES ('00000000-0000-4000-8000-000000000999',42,'101','2026-11-04T00:00:00Z',
  'begin',repeat('0',64),'{"synthetic":true}'::jsonb,
  'a8198524f58e72b56283ab71ebddada22840f108b46ef7165bb3fca9919c5558','manual');
INSERT INTO public.lost_prejudge_stt_attempts
  (attempt_id,deal_id,stage_history_id,lose_date,source_key,audio_sha256,policy_sha256,
   owner_job_id,owner_lease_token,status)
VALUES ('00000000-0000-4000-8000-000000000998',42,'101','2026-11-04T00:00:00Z',
  repeat('1',64),repeat('2',64),repeat('3',64),'00000000-0000-4000-8000-000000000999',
  '00000000-0000-4000-8000-000000000997','pending');
UPDATE public.lost_prejudge_manual_jobs SET status='completed',finished_at=now()
 WHERE id='00000000-0000-4000-8000-000000000999';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.lost_prejudge_manual_jobs j
    JOIN public.lost_prejudge_artifacts a ON a.job_id=j.id
    JOIN public.lost_prejudge_stt_attempts s ON s.owner_job_id=j.id
    WHERE j.id='00000000-0000-4000-8000-000000000999'
      AND j.status='completed' AND a.run_kind='manual' AND s.status='pending') THEN
    RAISE EXCEPTION 'Synthetic smoke test failed';
  END IF;
END $$;
ROLLBACK;
