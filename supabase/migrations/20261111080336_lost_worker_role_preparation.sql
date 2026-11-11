BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- Очередь автономного обработчика. Применяется отдельно после интеграционных проверок.
-- Содержимое коммуникаций и токены в очередь не помещаются.
create table public.lost_processing_jobs (
  id uuid primary key,
  request_key text not null unique,
  deal_id bigint not null,
  lose_date timestamptz not null,
  trigger_type text not null,
  -- Проверенный переход ручного/ночного повтора фиксируется под арендой.
  origin_stage_history_id text check (origin_stage_history_id is null or origin_stage_history_id ~ '^[1-9][0-9]{0,29}$'),
  silent boolean not null default false,
  screenshots boolean not null default true,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'failed', 'needs_review')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  comment_state text not null default 'pending' check (comment_state in ('pending', 'sending', 'ok', 'unknown', 'skipped')),
  comment_id text,
  comment_sha256 text check (comment_sha256 is null or comment_sha256 ~ '^[0-9a-f]{64}$'),
  comment_attempted_at timestamptz,
  notify_state text not null default 'pending' check (notify_state in ('pending', 'sending', 'ok', 'unknown', 'skipped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lost_jobs_lease_consistent check (
    (status = 'processing' and lease_token is not null and lease_until is not null)
    or (status <> 'processing' and lease_token is null and lease_until is null)
  )
);

-- Два разных события одной сделки нельзя обрабатывать одновременно.
create unique index lost_jobs_one_processing_per_deal
  on public.lost_processing_jobs (deal_id) where status = 'processing';
create index lost_jobs_ready
  on public.lost_processing_jobs (available_at, created_at) where status = 'pending';
create index lost_jobs_active_deal
  on public.lost_processing_jobs (deal_id) where status in ('pending', 'processing', 'needs_review');
-- Поиск ночных постановок в окне 04:00–04:00 по Новосибирску.
create index lost_jobs_nightly_created
  on public.lost_processing_jobs (created_at) where trigger_type = 'nightly';
create index lost_jobs_review_attention
  on public.lost_processing_jobs (status) where status = 'needs_review';

-- Новые разборы имеют устойчивый идентификатор операции. NULL оставляет
-- исторические записи и существующих потребителей без изменений.
alter table public.lost_deal_analyses add column pipeline_operation_id uuid;
create unique index lost_analyses_pipeline_operation_id
  on public.lost_deal_analyses (pipeline_operation_id) where pipeline_operation_id is not null;

alter table public.lost_processing_jobs enable row level security;
revoke all on public.lost_processing_jobs from anon, authenticated;

-- Снимок ночного отбора: после фиксации повтор/перезапуск не расширяет набор.
-- Хранятся только ID сделок и параметры заданий, не коммуникации и не токены.
create table public.lost_nightly_retry_runs (
  run_date date primary key,
  actions jsonb not null check (jsonb_typeof(actions) = 'array'),
  deferred jsonb not null check (jsonb_typeof(deferred) = 'array'),
  status text not null default 'planned' check (status in ('planned', 'enqueued')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_array_length(actions) + jsonb_array_length(deferred) <= 20)
);
alter table public.lost_nightly_retry_runs enable row level security;
revoke all on public.lost_nightly_retry_runs from anon, authenticated;

-- Минимальная входящая очередь событий Б24. Секреты и тело запроса не хранятся.
-- До включения необходимо применить предыдущую миграцию очереди заданий.
-- Запись включения создаётся отдельной процедурой при вводе в эксплуатацию.
create table public.lost_live_config (
  id boolean primary key default true check (id),
  enabled_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.lost_live_config enable row level security;
revoke all on public.lost_live_config from anon, authenticated;

-- После инициализации cutoff нельзя случайно сдвинуть или удалить между
-- перезапусками. Осознанная смена требует отдельной миграции.
create function public.lost_live_config_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'lost_live_config immutable';
end;
$$;
create trigger lost_live_config_no_change before update or delete on public.lost_live_config
  for each row execute function public.lost_live_config_immutable();
create trigger lost_live_config_no_truncate before truncate on public.lost_live_config
  for each statement execute function public.lost_live_config_immutable();

create table public.lost_bitrix_events (
  id uuid primary key,
  deal_id bigint not null check (deal_id > 0 and deal_id <= 2147483647),
  status text not null default 'pending' check (status in ('pending', 'processing', 'done')),
  outcome text check (outcome in ('queued', 'ignored')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status='processing' and lease_token is not null and lease_until is not null)
      or (status<>'processing' and lease_token is null and lease_until is null)),
  check ((status='done' and outcome is not null) or (status<>'done' and outcome is null))
);
create index lost_bitrix_events_ready on public.lost_bitrix_events (available_at, created_at) where status='pending';
create index lost_bitrix_events_expired on public.lost_bitrix_events (lease_until) where status='processing';
create index lost_bitrix_events_retry_attention on public.lost_bitrix_events (status)
  where status in ('pending', 'processing') and attempts > 0;
alter table public.lost_bitrix_events enable row level security;
revoke all on public.lost_bitrix_events from anon, authenticated;

-- Прежние данные, которые новый разбор перезаписывает. Это архив для разбора
-- инцидентов, а не источник фактов или вход для модели.
create table public.lost_overwrite_history (
  operation_id uuid not null,
  deal_id bigint not null,
  record_type text not null check (record_type in ('card', 'communication')),
  event_type text not null default '',
  event_id text not null default '',
  previous_values jsonb not null check (jsonb_typeof(previous_values) = 'object'),
  saved_at timestamptz not null default now(),
  primary key (operation_id, record_type, event_type, event_id),
  check ((record_type = 'card' and event_type = '' and event_id = '')
      or (record_type = 'communication' and event_type <> '' and event_id <> ''))
);

create index lost_overwrite_history_deal on public.lost_overwrite_history (deal_id, saved_at desc);
alter table public.lost_overwrite_history enable row level security;
revoke all on public.lost_overwrite_history from public, anon, authenticated;

comment on table public.lost_overwrite_history is
  'Архив перезаписанных транскриптов и данных карточки; содержит коммуникации, не использовать как вход для анализа';

-- Исторические строки намеренно остаются NULL: ID перехода из даты не вывести.
-- Новая очередь заполняет его атомарно с созданием/обновлением ожидания.
alter table public.lost_audio_wait
  add column origin_stage_history_id text
  check (origin_stage_history_id is null or origin_stage_history_id ~ '^[1-9][0-9]{0,29}$');

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

COMMIT;
