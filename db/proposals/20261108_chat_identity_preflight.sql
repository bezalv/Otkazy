-- ПРОЕКТ, только чтение. Подозрительные пары нужно разбирать индивидуально;
-- одинаковый суффикс в одной сделке и чате ещё не доказывает идентичность.
WITH classified AS (
  SELECT deal_id, chat_id, event_id,
    chat_id ~ '^[1-9][0-9]*$'
      AND event_id ~ '^([1-9][0-9]*|chat_[1-9][0-9]*)_[1-9][0-9]*$'
      AND (event_id NOT LIKE 'chat\_%' ESCAPE '\' OR split_part(event_id, '_', 2) = chat_id) AS covered,
    substring(event_id from '[0-9]+$') AS message_id
  FROM public.lost_deal_communications WHERE event_type = 'chat'
), collisions AS (
  SELECT deal_id, chat_id, message_id, count(*) AS rows_count
  FROM classified WHERE covered IS TRUE
  GROUP BY deal_id, chat_id, message_id HAVING count(*) > 1
)
SELECT (SELECT count(*) FROM classified) AS chat_rows,
  (SELECT count(*) FROM classified WHERE covered IS TRUE) AS covered_rows,
  (SELECT count(*) FROM classified WHERE covered IS NOT TRUE) AS uncovered_rows,
  (SELECT count(*) FROM collisions) AS candidate_collision_groups,
  (SELECT coalesce(sum(rows_count), 0) FROM collisions) AS candidate_collision_rows;

-- Если candidate_collision_groups > 0, CREATE UNIQUE INDEX не сработает.
-- Идентификаторы можно перечислить отдельным запросом без текстов сообщений:
WITH classified AS (
  SELECT deal_id, chat_id, event_id, substring(event_id from '[0-9]+$') AS message_id
  FROM public.lost_deal_communications
  WHERE event_type = 'chat' AND chat_id ~ '^[1-9][0-9]*$'
    AND event_id ~ '^([1-9][0-9]*|chat_[1-9][0-9]*)_[1-9][0-9]*$'
    AND (event_id NOT LIKE 'chat\_%' ESCAPE '\' OR split_part(event_id, '_', 2) = chat_id)
)
SELECT deal_id, chat_id, message_id, array_agg(event_id ORDER BY event_id) AS event_ids
FROM classified GROUP BY deal_id, chat_id, message_id HAVING count(*) > 1
ORDER BY deal_id, chat_id, message_id LIMIT 100;
