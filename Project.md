# Отказы Б24 — Project.md

## Статус проекта

| Фаза | Название | Статус |
|------|----------|--------|
| 1 | БД | ✅ завершена (DD.MM.YYYY) |
| 2 | Адаптация клонов воркфлоу | ✅ завершена (13.04.2026) |
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
- 13.04.2026: Установлено правило — после `n8n_test_workflow` не проверять статус самому, ждать подтверждения от Сани. Причина — ложные тревоги от таймаутов MCP

## Воркфлоу n8n

| Имя | ID | Назначение |
|-----|----|------------|
| Отказ: Сбор данных сделки | qNPqFd0LE4dlYQDH | Триггер + данные + коммуникации |
| Отказ: Анализ сделки | GLQ2iuzRaCQZM7QU | Транскрипция + журнал + AI |
| Отказ: Транскрипция звонка | FHdtN0HGjVAbe9Ow | Sub-workflow: звонок → SpeechKit |
| Отказ: Пакетный прогон | BhPWB9S6W5dlMUvV | Batch по N сделкам |

## Credentials n8n

| Имя | Тип | ID |
|-----|-----|----|
| Otkaz: Supabase Postgres | postgres | dU8hxg0nDK4yedJO |
| Otkaz: Supabase REST (anon) | httpCustomAuth | 2BrFkjPNUNwhcFgb |

## Фаза 2 — лог изменений (13.04.2026)

- 4 воркфлоу адаптированы: webhook paths (lost-*), stage C23:LOSE, таблицы lost_*, Supabase URL/KEY, Postgres credential
- AI ноды в WF2 disabled (из клона), "Возврат без AI" активен — готово к Phase 3 без AI
- Все воркфлоу inactive — активация по команде

## Открытые вопросы

- (пусто)
