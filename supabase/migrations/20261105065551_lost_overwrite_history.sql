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
