-- Изолированные ручные прогоны не создают заданий в lost_processing_jobs.
-- Выполнять в Supabase отдельно после проверки прав роли и RLS.
CREATE TABLE public.lost_prejudge_manual_jobs (
  id uuid PRIMARY KEY,
  request_key text NOT NULL UNIQUE,
  deal_id integer NOT NULL CHECK (deal_id > 0),
  stage_history_id text NOT NULL CHECK (stage_history_id ~ '^[1-9][0-9]{0,29}$'),
  lose_date timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (request_key = 'manual-test:' || id::text),
  CHECK ((status = 'running' AND finished_at IS NULL) OR (status <> 'running' AND finished_at IS NOT NULL))
);
ALTER TABLE public.lost_prejudge_manual_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lost_prejudge_manual_jobs FROM PUBLIC, anon, authenticated;
