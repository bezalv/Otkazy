-- Только новые переходы в отказ. Очередь пустая: исторического заполнения нет.
create table public.lost_audio_wait_config (
  id boolean primary key default true check (id),
  enabled_at timestamptz not null default now()
);
insert into public.lost_audio_wait_config default values;
create table public.lost_audio_wait (
  deal_id bigint primary key,
  lose_date timestamptz not null,
  state text not null check (state in ('waiting','done','expired','cancelled')),
  first_seen_at timestamptz not null,
  deadline_at timestamptz not null,
  next_check_at timestamptz not null,
  pending_calls jsonb not null default '[]',
  observations jsonb not null default '{}',
  silent boolean not null default false,
  screenshots boolean not null default false,
  checks integer not null default 0,
  lease_until timestamptz,
  updated_at timestamptz not null default now()
);
create index lost_audio_wait_due on public.lost_audio_wait (next_check_at) where state='waiting';
alter table public.lost_audio_wait enable row level security;
alter table public.lost_audio_wait_config enable row level security;
revoke all on public.lost_audio_wait, public.lost_audio_wait_config from public, anon, authenticated;
grant all on public.lost_audio_wait, public.lost_audio_wait_config to service_role;
comment on table public.lost_audio_wait is 'Ожидание аудио для новых отказов. Без AI-вердикта до готовности; после 24 часов — недостаточно данных. История не перепрогоняется.';
