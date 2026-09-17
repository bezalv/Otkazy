-- lost_003_screenshot_columns
-- Распознавание скриншотов переписки, приложенных к комментариям сделки.
-- Применена в Supabase (wdosxmyemhdschannoar) отдельно, здесь — для истории.
--
-- screenshot_extract_status: ok / not_chat / failed / empty

alter table public.lost_deal_communications
  add column if not exists screenshot_files jsonb,
  add column if not exists screenshot_turns jsonb,
  add column if not exists screenshot_text text,
  add column if not exists screenshot_extract_status varchar(20);

alter table public.lost_deal_analyses
  add column if not exists screenshots_total integer,
  add column if not exists screenshots_extracted integer,
  add column if not exists screenshots_failed integer;
