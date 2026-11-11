-- Исторические строки намеренно остаются NULL: ID перехода из даты не вывести.
-- Новая очередь заполняет его атомарно с созданием/обновлением ожидания.
alter table public.lost_audio_wait
  add column origin_stage_history_id text
  check (origin_stage_history_id is null or origin_stage_history_id ~ '^[1-9][0-9]{0,29}$');
