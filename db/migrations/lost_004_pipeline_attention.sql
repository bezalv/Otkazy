-- Шаг Б п.3: где смотреть заблокированные сделки и кого повторять ночью.
--
-- Счётчик попыток держим без новой колонки: число неудач — это число строк
-- lost_deal_analyses с pipeline_error, накопившихся ПОСЛЕ последнего успешного разбора.
-- Так принцип минимальных правок схемы соблюдён, а данные и так уже есть в базе.
--
-- Сделка попадает в повтор, если последний её разбор — с pipeline_error и неудач меньше трёх.

create or replace view lost_pipeline_attention as
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
  select a.deal_id, count(*) as failed_attempts, max(a.processed_at) as last_fail_at
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
  -- вид сбоя: по тексту ошибки видно, можно ли надеяться на повтор
  case
    when a.pipeline_error like 'сбор неполный%' then 'collect'
    when a.pipeline_error like 'технический сбой распознавания%' then 'recognition'
    else 'other'
  end as gate_kind,
  coalesce(n.failed_attempts, 0) as failed_attempts,
  a.processed_at as last_attempt_at,
  a.prompt_version,
  -- повторяем, пока неудач меньше трёх; «сбор неполный» повторяем так же — ошибка API
  -- может быть временной, а после третьей попытки сделка остаётся без вердикта и видна здесь
  (coalesce(n.failed_attempts, 0) < 3) as retry_eligible,
  -- следующая попытка будет последней: распознавание больше не держит сделку
  (coalesce(n.failed_attempts, 0) = 2) as next_is_last
from lost_deal_analyses a
join posledniy p on p.deal_id = a.deal_id and p.last_at = a.processed_at
left join neudachi n on n.deal_id = a.deal_id
left join lost_deals d on d.deal_id = a.deal_id
where a.pipeline_error is not null;

comment on view lost_pipeline_attention is
  'Сделки, у которых последний разбор упал с pipeline_error. failed_attempts — неудач после последнего успеха, retry_eligible — брать ли в ночной повтор, next_is_last — на следующей попытке сбой распознавания уже не блокирует вердикт.';
