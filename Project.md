# Отказы Б24 — Project.md

## Статус проекта

| Фаза | Название | Статус |
|------|----------|--------|
| 1 | БД | ✅ завершена (DD.MM.YYYY) |
| 2 | Адаптация клонов воркфлоу | ✅ завершена (13.04.2026) |
| 3 | Тестовый прогон | 🔄 в процессе (13.04.2026) |
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

## Фаза 3: тестовый прогон (13.04.26, в процессе)

### Что сделано
- Активированы все 4 воркфлоу Отказов (qNPqFd0LE4dlYQDH, GLQ2iuzRaCQZM7QU, FHdtN0HGjVAbe9Ow, BhPWB9S6W5dlMUvV)
- Первый прогон по 3 сделкам: 97861, 111455, 113751
- Применена миграция `002_align_ai_columns_with_priostanovlennye_code.sql`

### Проблемы и фиксы

**1. IPv6 ENETUNREACH у Postgres credential**
- Supabase direct-connection (`db.PROJECT.supabase.co`) резолвится только в IPv6, у хоста n8n нет IPv6-маршрута
- Фикс: credential `Otkaz: Supabase Postgres` (id=dU8hxg0nDK4yedJO) переведён на pooler:
  - Host: `aws-0-eu-west-1.pooler.supabase.com`
  - Port: `5432`
  - User: `postgres.wdosxmyemhdschannoar`
  - Флаг "Ignore SSL Issues" включён (self-signed cert в цепочке pooler)

**2. Схема БД не совпала с кодом воркфлоу (косяк архитектора)**
- В брифинге было явно: "Структура lost_deals идентична deals из Приостановленных — минимум правок в коде"
- В миграции 001 переименовал last_ai_* поля под новую схему Отказов → INSERT в lost_deals упал с ошибкой `column "last_ai_reason_class" does not exist`
- Пайплайн сам отработал корректно: 15 звонков, 8 из 8 транскрибированы, журнал собран, comm_analytics посчитан
- Фикс: миграция 002 добавила обратно старые имена (не трогая код воркфлоу):
  - В `lost_deals`: last_ai_reason_class, last_ai_maturity, last_ai_probability, last_ai_route, last_ai_misplaced
  - В `lost_deal_analyses`: ai_reason_class, ai_maturity, ai_contact_level, ai_urgency, ai_probability, ai_route, ai_manager_script
- Новые поля Отказов (ai_closure_correctness, ai_recoverable_now, ai_recovery_route, ai_manager_mistakes, ai_recovery_script, ai_recovery_probability и т.д.) остались в таблицах — будут заполняться в Фазе 4 после переписывания промпта

**3. batch_lock не разлочился после падения**
- Lock взят через REST перед Postgres-нодой, падение на INSERT не дошло до UPDATE batch_lock
- Фикс включён в миграцию 002 (ручной разлок)
- Архитектурный риск: при любом падении пайплайна после HTTP-лока, но до SQL-разлока, lock остаётся повисшим. Нужно продумать защиту (таймаут 30 мин в коде уже есть, но лучше try/finally)

### Фильтры работают
Сделка 97861 (Виталий Попов, assigned_by_id=20903) корректно отфильтрована в "Обработать 1 сделку" со статусом `skipped` / `excluded_responsible`.

### Инфраструктурная проблема на стороне Сани
- В UI Claude не загружается часть MCP-инструментов n8n-mcp (`n8n_test_workflow`, `n8n_update_partial_workflow`) из-за блокировки домена `claudemcpcontent.com`
- Причина: антивирус / adblock / VPN / корпоративный прокси
- Workaround на время фикса: запуск воркфлоу через `curl.exe` из PowerShell:
```
  curl.exe -X POST https://bezalv.ru/webhook/lost-batch -H "Content-Type: application/json" -d "{\"deal_ids\":[97861,111455,113751]}"
```
- Update воркфлоу через MCP недоступен — только через n8n UI или через CC с работающим MCP

**4. lose_reason и lose_date всегда NULL (14.04.2026)**
- Причина: WF1 не извлекал `UF_CRM_1584703948317` (enum ID причины отказа) из карточки сделки, не резолвил его через справочник, не вычислял дату отказа из `pauseDate`
- Фикс в WF1: добавлена HTTP Request нода "B24 Справочник причин отказа" (`crm.deal.userfield.list`), в "Собрать поля сделки" добавлены `lose_reason_id` + `lead_id`, в "Определить предыдущую стадию" — `lose_date`, `days_in_lost`, `lose_reason` (резолв через lookup)
- Фикс в WF2: промпт переделан — убраны "Причина приостановки / Дата приостановки / Отложить до / Дней до даты отложения", добавлены "Причина отказа / Дата перехода в отказ / Дней в отказе"
- Фикс в WF4: INSERT и ON CONFLICT расширены колонками `lose_reason_id, lose_reason, lose_date, days_in_lost, lead_id`
- Фикс в WF4 (14.04.2026): синхронизирована логика сбора данных в "Обработать 1 сделку" — добавлен HTTP-вызов `crm.deal.userfield.list` для справочника причин, извлечение `lose_reason_id/lead_id` из карточки, поиск `loseDate` в истории стадий, вычисление `days_in_lost`
- Бонус: починено corrupted connection (тип "0" вместо "main") в WF1 между "Объединить коммуникации" и "Вызов Блока 3"
- Миграция БД: `ALTER TABLE lost_deals ADD COLUMN lead_id INTEGER` + индекс (применена Саней вручную)

### TODO для Фазы 3
- [x] Перезапустить batch с теми же 3 сделками после миграции 002
- [x] Проверить что все 3 таблицы заполнились (lost_deals: 2 записи, 97861 отфильтрована; lost_deal_communications: ~50+ записей; lost_deal_analyses: 2 записи с ai_* = null)
- [x] Прогнать вторым батчем оставшиеся сделки 108811, 109919 + добить до ~20-30 исторических
- [x] Починить блокировку claudemcpcontent.com у Сани → полный MCP вернётся
- [ ] Перепрогнать batch по всем сделкам lost_deals — проверить что lose_reason, lose_date, days_in_lost, lead_id заполнены
- [ ] Проверочная сделка: 97161 (Виктория) — ожидается lose_reason = "Заказал у других"

## Открытые вопросы

- (пусто)
