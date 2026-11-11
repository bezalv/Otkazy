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
