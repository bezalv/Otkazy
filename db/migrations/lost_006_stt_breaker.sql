-- 13.10.2026: предохранитель «SpeechKit лежит» для резервного распознавания (пункт Д2
-- задания 2026-10-12-rezervnoe-raspoznavanie.md).
--
-- Зачем таблица, а не $getWorkflowStaticData: проверено 13.10 на воркфлоу
-- «Отказ: проверка stt-reserve» — при вызове через вебхук staticData между выполнениями
-- НЕ сохраняется (счётчик на двух прогонах подряд оба раза вернул 1). Значит отметку
-- «SpeechKit лежит до …» держать в n8n нельзя.
--
-- Строка ровно одна (id = 1): это состояние инфраструктуры, а не история.
-- Пустой down_until = предохранитель закрыт, звонки пробуют SpeechKit как обычно.
create table if not exists lost_stt_breaker (
  id smallint primary key default 1,
  down_until timestamptz,
  tripped_at timestamptz,
  reason text,
  updated_at timestamptz not null default now(),
  constraint lost_stt_breaker_one_row check (id = 1)
);

insert into lost_stt_breaker (id, down_until) values (1, null) on conflict (id) do nothing;

comment on table lost_stt_breaker is 'Предохранитель резервного распознавания: пока down_until в будущем, звонки идут сразу в stt-reserve, не тратя попытки на лежащий SpeechKit. Одна строка, id=1';
comment on column lost_stt_breaker.down_until is 'До какого момента считаем SpeechKit лежащим (15 минут от последнего повторяемого сбоя). NULL или прошлое — предохранитель закрыт';
comment on column lost_stt_breaker.tripped_at is 'Когда предохранитель взвели в последний раз';
comment on column lost_stt_breaker.reason is 'Текст сбоя SpeechKit, из-за которого взвели предохранитель';
