-- Журнал оплаченных попыток определения автора: без текста и адресов.
-- Создание таблиц не включает обработчик, расписания и доставку.
CREATE TABLE public.lost_role_inference_scopes (
  deal_id bigint NOT NULL CHECK (deal_id > 0),
  stage_history_id text NOT NULL CHECK (stage_history_id ~ '^[1-9][0-9]{0,29}$'),
  PRIMARY KEY (deal_id, stage_history_id)
);

CREATE TABLE public.lost_role_inference_attempts (
  job_id uuid NOT NULL REFERENCES public.lost_processing_jobs(id),
  attempt_no smallint NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  deal_id bigint NOT NULL,
  stage_history_id text NOT NULL,
  lease_token uuid NOT NULL,
  run_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'settled', 'unknown')),
  created_at timestamptz NOT NULL,
  finished_at timestamptz,
  CHECK ((state = 'reserved' AND finished_at IS NULL)
      OR (state IN ('settled', 'unknown') AND finished_at IS NOT NULL)),
  PRIMARY KEY (job_id, attempt_no),
  FOREIGN KEY (deal_id, stage_history_id)
    REFERENCES public.lost_role_inference_scopes(deal_id, stage_history_id)
);
CREATE INDEX lost_role_inference_attempts_scope_idx
  ON public.lost_role_inference_attempts(deal_id, stage_history_id);

ALTER TABLE public.lost_role_inference_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lost_role_inference_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lost_role_inference_scopes, public.lost_role_inference_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.lost_role_inference_scopes, public.lost_role_inference_attempts FROM service_role;
GRANT SELECT, INSERT, UPDATE ON public.lost_role_inference_scopes, public.lost_role_inference_attempts TO service_role;
