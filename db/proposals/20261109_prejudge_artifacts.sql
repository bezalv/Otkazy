-- ПРОЕКТ, НЕ ПРИМЕНЁН. Хранение промежуточных материалов до вызова судьи.
-- До production необходимо проверить права подключения, миграцию и сроки хранения.
CREATE TABLE public.lost_prejudge_artifacts (
  job_id uuid NOT NULL,
  deal_id integer NOT NULL,
  stage_history_id text NOT NULL CHECK (stage_history_id ~ '^[1-9][0-9]{0,29}$'),
  lose_date timestamptz NOT NULL,
  artifact_type text NOT NULL CHECK (artifact_type IN ('begin', 'raw_collection', 'communications', 'transcript', 'judge_input', 'judge_result')),
  run_kind text NOT NULL DEFAULT 'automatic' CHECK (run_kind IN ('automatic', 'manual')),
  artifact_key text NOT NULL CHECK (artifact_key ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, artifact_type, artifact_key),
  CHECK (artifact_type <> 'judge_result' OR run_kind = 'manual')
);

-- В staging могут находиться тексты звонков и переписки; доступ только из
-- доверенного серверного подключения. Публичные политики здесь не создаются.
ALTER TABLE public.lost_prejudge_artifacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lost_prejudge_artifacts FROM PUBLIC;
REVOKE ALL ON public.lost_prejudge_artifacts FROM anon, authenticated;

CREATE TABLE public.lost_prejudge_stt_attempts (
  attempt_id uuid PRIMARY KEY,
  deal_id integer NOT NULL,
  stage_history_id text NOT NULL,
  lose_date timestamptz NOT NULL,
  source_key text NOT NULL CHECK (source_key ~ '^[a-f0-9]{64}$'),
  audio_sha256 text NOT NULL CHECK (audio_sha256 ~ '^[a-f0-9]{64}$'),
  policy_sha256 text NOT NULL CHECK (policy_sha256 ~ '^[a-f0-9]{64}$'),
  owner_job_id uuid NOT NULL,
  owner_lease_token uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','completed','unknown')),
  transcript jsonb,
  transcript_sha256 text CHECK (transcript_sha256 IS NULL OR transcript_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('pending','unknown') AND transcript IS NULL AND transcript_sha256 IS NULL)
      OR (status = 'completed' AND transcript IS NOT NULL AND transcript_sha256 IS NOT NULL))
);
CREATE INDEX lost_prejudge_stt_attempts_lookup ON public.lost_prejudge_stt_attempts
  (deal_id,stage_history_id,lose_date,source_key,audio_sha256,policy_sha256);
ALTER TABLE public.lost_prejudge_stt_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lost_prejudge_stt_attempts FROM PUBLIC, anon, authenticated;
