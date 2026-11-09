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
