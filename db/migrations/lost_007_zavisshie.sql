-- 19.10.2026: сделки со сбоем сбора данных не разбираются, а висят в списке и сигналят.
--
-- Решение Сани: неполные данные — это сбой процесса, а не повод для вердикта. Прежний
-- механизм last_attempt (после третьей неудачи разбор идёт на том, что собрали) убран:
-- 16–17.10 он дал 12 неверных разборов, у двух менеджеров вышло ложное «неправомерен».
--
-- Что изменилось в представлении против lost_004:
--   * not_received — что именно не получено, человеческими словами (для сигнала в сводке);
--   * first_fail_at — с какого числа сделка висит (первая неудача после последнего успеха);
--   * attempts_exhausted — ночные повторы закончились, сама она больше не поднимется;
--   * next_is_last убран: он существовал только для last_attempt.
--
-- Счётчик попыток по-прежнему без отдельной колонки: это число строк lost_deal_analyses
-- с pipeline_error, накопившихся ПОСЛЕ последнего успешного разбора.

-- Пересоздаём, а не create or replace: Postgres не позволяет менять имена и порядок колонок
-- существующего представления (42P16). Представление read-only, зависимостей в схеме нет.
drop view if exists lost_pipeline_attention;

create view lost_pipeline_attention as
with posledniy as (
  select deal_id, max(processed_at) as last_at
  from lost_deal_analyses
  group by deal_id
),
posledniy_uspeh as (
  select deal_id, max(processed_at) as ok_at
  from lost_deal_analyses
  where pipeline_error is null
  group by deal_id
),
neudachi as (
  select a.deal_id,
         count(*) as failed_attempts,
         max(a.processed_at) as last_fail_at,
         min(a.processed_at) as first_fail_at
  from lost_deal_analyses a
  left join posledniy_uspeh u on u.deal_id = a.deal_id
  where a.pipeline_error is not null
    and a.processed_at > coalesce(u.ok_at, '-infinity'::timestamptz)
  group by a.deal_id
)
select
  a.deal_id,
  d.title,
  d.lose_date,
  d.assigned_by_id,
  a.pipeline_error,
  case
    when a.pipeline_error like 'сбор неполный%' then 'collect'
    when a.pipeline_error like 'технический сбой распознавания%' then 'recognition'
    else 'other'
  end as gate_kind,
  -- Человеческая формулировка для сигнала в суточной сводке.
  case
    when a.pipeline_error like 'сбор неполный%' then 'данные из Битрикса не загрузились'
    when a.pipeline_error like 'технический сбой распознавания%' then 'звонки не распознаны'
    else 'сбой обработки'
  end as not_received,
  coalesce(n.failed_attempts, 0) as failed_attempts,
  -- Ночной повтор берёт сделку, пока неудач меньше трёх.
  coalesce(n.failed_attempts, 0) < 3 as retry_eligible,
  -- Повторы закончились: сама сделка больше не поднимется, нужен ручной «Прогон зависших».
  coalesce(n.failed_attempts, 0) >= 3 as attempts_exhausted,
  coalesce(n.first_fail_at, a.processed_at) as first_fail_at,
  a.processed_at as last_attempt_at,
  a.prompt_version
from lost_deal_analyses a
join posledniy p on p.deal_id = a.deal_id and p.last_at = a.processed_at
left join neudachi n on n.deal_id = a.deal_id
left join lost_deals d on d.deal_id = a.deal_id
where a.pipeline_error is not null;

comment on view lost_pipeline_attention is 'Зависшие сделки: последний разбор со сбоем. not_received — что не получено, first_fail_at — с какого числа висит, attempts_exhausted — ночные повторы закончились, нужен ручной «Прогон зависших» (воркфлоу). Разбор по таким сделкам не делается совсем (решение Сани 19.10.2026)';
