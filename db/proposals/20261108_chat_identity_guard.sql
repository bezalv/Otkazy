-- ПРОЕКТ, НЕ ПРИМЕНЁН. Не помещать в автоматическую миграцию.
-- Защита только от второй строки возможного псевдонима: решение не доказывает,
-- что ID сообщения уникален между сессиями, и не объединяет записи.
-- Выполняется отдельно от транзакции (CREATE INDEX CONCURRENTLY).
-- Перед применением обязательны аудит 20261108_chat_identity_preflight.sql,
-- проверка прав/воздействия на все существующие писатели и план обработки
-- конфликта unique_violation. Ошибка сборки может оставить INVALID индекс;
-- проверить pg_index.indisvalid и удалить INVALID индекс отдельно CONCURRENTLY.
-- Откат: DROP INDEX CONCURRENTLY IF EXISTS public.lost_comm_chat_identity_guard;
CREATE UNIQUE INDEX CONCURRENTLY lost_comm_chat_identity_guard
ON public.lost_deal_communications
  (deal_id, chat_id, (substring(event_id from '[0-9]+$')))
WHERE event_type = 'chat'
  AND chat_id ~ '^[1-9][0-9]*$'
  AND event_id ~ '^([1-9][0-9]*|chat_[1-9][0-9]*)_[1-9][0-9]*$'
  AND (event_id NOT LIKE 'chat\_%' ESCAPE '\' OR split_part(event_id, '_', 2) = chat_id);
