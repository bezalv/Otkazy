# Отказы Б24 — Project.md

## Статус проекта

| Фаза | Название | Статус |
|------|----------|--------|
| 1 | БД | ✅ завершена (DD.MM.YYYY) |
| 2 | Адаптация клонов воркфлоу | в работе |
| 3 | Тестовый прогон | ожидает |
| 4 | Промпт под Отказы | ожидает |
| 5 | Лайв-триггер | ожидает |

## Supabase

- **Project ID:** wdosxmyemhdschannoar
- **Таблицы:** lost_deals (58 колонок), lost_deal_communications (34), lost_deal_analyses (32), batch_lock
- **Миграция:** 001_initial_schema применена через Supabase MCP

## Решения

- Схемы `lost_deals` и `lost_deal_communications` скопированы 1:1 из Приостановленных, добавлены 4 поля (`lose_reason_id`, `lose_reason`, `lose_date`, `days_in_lost`)
- `lost_deal_analyses` — своя схема под Отказы (10 AI-полей: closure_correctness, recoverable_now, recovery_route и др.)
- `batch_lock` создан с начальной строкой (id=1, is_locked=false) — чтобы UPDATE работал с первого прогона

## Открытые вопросы

- ID новых воркфлоу в n8n (пользователь пришлёт)
