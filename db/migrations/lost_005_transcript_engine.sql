-- 13.10.2026: пометка «кто распознал» для резервного распознавания.
-- Применена через Supabase MCP (apply_migration lost_005_transcript_engine).
alter table lost_deal_communications add column if not exists transcript_engine varchar(32);
comment on column lost_deal_communications.transcript_engine is 'Кто распознал: speechkit | reserve:gigaam | reserve:aiesa. NULL — до 13.10.2026 или звонок не распознавался';
