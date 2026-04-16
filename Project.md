# Отказы Б24 — Project.md

## Статус проекта

| Фаза | Название | Статус |
|------|----------|--------|
| 1 | БД | ✅ завершена (DD.MM.YYYY) |
| 2 | Адаптация клонов воркфлоу | ✅ завершена (13.04.2026) |
| 3 | Тестовый прогон | 🔄 в процессе (13.04.2026) |
| 3.5 | Миграция мульти-агента в n8n | ✅ завершена (16.04.2026) |
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
- Фикс в WF4 (14.04.2026): починен счётчик `trans_calls_transcribed`/`trans_calls_failed` — считается из communications по наличию transcript (было захардкожено 0, 0)

### TODO для Фазы 3
- [x] Перезапустить batch с теми же 3 сделками после миграции 002
- [x] Проверить что все 3 таблицы заполнились (lost_deals: 2 записи, 97861 отфильтрована; lost_deal_communications: ~50+ записей; lost_deal_analyses: 2 записи с ai_* = null)
- [x] Прогнать вторым батчем оставшиеся сделки 108811, 109919 + добить до ~20-30 исторических
- [x] Починить блокировку claudemcpcontent.com у Сани → полный MCP вернётся
- [ ] Перепрогнать batch по всем сделкам lost_deals — проверить что lose_reason, lose_date, days_in_lost, lead_id заполнены
- [ ] Проверочная сделка: 97161 (Виктория) — ожидается lose_reason = "Заказал у других"

## Валидация прототипа на трёх сделках (14.04.2026)

Модель: Claude Opus 4.6 (anthropic/claude-opus-4.6 через Polza) для обеих ролей (Judge + Writer).

Сделка 113759 "Наталья Владимировна / расчет":
— 6 коммуникаций (2 транскрипта, 3 CRM-коммента)
— verdict=неправомерен, class=manager_dropped, recoverable=высокий
— 13/13 пруфов валидны
— Ключевое: "нашёл дешевле" из crm_comment НЕ приписано клиенту, Writer прямо пишет что подтверждения нет
— Writer вытащил номер ЛПР (913-980-08-83) из транскрипта, построил план звонка с учётом возраста клиентки и её реакции на цену

Сделка 113585 "Владимир, дорого":
— 23 коммуникации (8 коротких звонков-обрывков + 15 чатов Max)
— verdict=правомерен, class=competitor
— 6/6 пруфов валидны
— Ключевое: Opus дочитал до последнего сообщения клиента "Уже нет спасибо, нашёл окна дешевле" — цитирует дословно с правильной датой

Сделка 111149 "Леонид Флотилия, передумал":
— 30 коммуникаций (0 звонков, 23 чата, 5 комментов)
— verdict=правомерен, class=regulatory
— 3/3 пруфов валидны
— Ключевое: клиент переслал менеджеру официальный отказ УК про паспорт фасада, Opus корректно классифицировал как внешний регуляторный запрет

Стоимость: ~25-27k токенов на "неправомерен" (Judge+Writer), ~10-12k токенов на "правомерен" (только Judge). При 500 отказах в месяц — примерно $8-12/мес на API.

Известные шероховатости (пока не блокеры):
— Writer на Opus 4.6 иногда вставляет мягкие "если-то" в Цель звонка (113759), но не явные скрипты ответов. Граница допустимого.
— PowerShell на Windows иногда рендерит UTF-8 с битыми байтами, в самом файле output/*.txt всё чисто.

## Миграция мульти-агента в n8n — лог (16.04.2026)

### Выполнено
- Добавлены 2 Set-ноды ("Set: Judge System Prompt", "Set: Writer System Prompt") с промптами из prototype/prompts/. Обе с includeOtherFields=true для проброса body вебхука.
- Добавлены 7 новых нод в GLQ2iuzRaCQZM7QU: agent-facts-assembler, agent-judge-call, agent-judge-parse, verdict-router (IF), agent-writer-call, agent-writer-parse, final-output. Пайплайн: b4.5 Comm Analytics → facts-assembler → judge-call → judge-parse → verdict-router → (если неправомерен) writer-call + writer-parse, затем → final-output.
- Нода "Возврат без AI" удалена (была disabled:true, связь b4.5 → Возврат без AI удалена, т.к. нода работала pass-through и конкурировала с final-output за responseMode:lastNode).
- Нода "Подготовить SQL" в WF4 BhPWB9S6W5dlMUvV обновлена: читает r.multi_agent_analysis и мапит 16 новых колонок в lost_deal_analyses (ai_verdict, ai_verdict_reason_short, ai_closure_correctness, ai_closure_reason_class, ai_recoverable_now, ai_recovery_probability, ai_recovery_route, ai_manager_mistakes jsonb, ai_final_comment, ai_recovery_script, ai_facts_json jsonb, ai_judge_json jsonb, ai_proof_warnings jsonb, ai_facts_count, judge_model, judge_prompt_tokens, judge_completion_tokens, writer_model, writer_prompt_tokens, writer_completion_tokens) и 5 новых в lost_deals (last_ai_closure_correctness, last_ai_closure_reason_class, last_ai_recoverable_now, last_ai_recovery_probability, last_ai_recovery_route). prompt_version обновлён с v1.1 на v2.0.
- Нода "Обработать 1 сделку" в WF4 — добавлен проброс multi_agent_analysis из ответа WF2.

### Баги найденные и починенные
- Set-ноды (typeVersion 3.4) по дефолту includeOtherFields=false — затирали body вебхука, Config + Фильтр звонков получал {content:"..."} вместо данных. Фикс: includeOtherFields=true.
- "Возврат без AI" с disabled:true всё равно выполнялась (pass-through), конкурируя с final-output за responseMode:lastNode. Фикс: удаление ноды и связи.
- "Обработать 1 сделку" не прокидывала multi_agent_analysis в return — новые колонки БД оставались NULL. Фикс: добавлена строка `multi_agent_analysis: block345Result.multi_agent_analysis || null`.

### AI-комментарий в Битрикс (16.04.2026)
- Добавлены 2 ноды в WF4 BhPWB9S6W5dlMUvV после "Записать в Supabase": "Собрать AI-комментарий" (Code) → "B24: Добавить AI-комментарий в карточку" (HTTP Request, continueOnFail).
- Метод crm.timeline.comment.add — пишет форматированный AI-анализ прямо в таймлайн карточки сделки.
- Комментарий содержит: вердикт, класс причины, уровень возврата, полный текст Writer (для неправомерных), футер с моделью и токенами.
- Баг: deal_id приходил строкой → Битрикс возвращал OWNER_NOT_FOUND. Фикс: Number(r.deal_id) + валидация.
- Баг: "Записать в Supabase" (Postgres) возвращает только {success:true}, затирая данные сделки. Фикс: чтение из $('Обработать 1 сделку') вместо $input.
- Валидация на 108213: комментарий успешно записан в карточку.

### Валидация на сделке 108213
- verdict=неправомерен, closure_correctness=premature, closure_reason_class=manager_dropped, recoverable_now=yes_medium, probability=50, misplaced=true, correct_stage=Приостановленные
- 24 факта, 4 manager_mistakes, 4 key_signals, 4 risk_factors
- final_comment присутствует (Вывод → Рекомендация РОПу → Сообщение менеджеру → План), без запрещённых скриптов "если-то"
- Judge 10722+1693 токенов, Writer 12242+1296 токенов (~26k total), processing_time ~200 сек
- 2/12 proof_warnings по типизации proof_type — known issue, не блокер

## Открытые вопросы

- Минорно: Judge (Opus 4.6) путает proof_type на кейсах с посредниками (не прямой клиент). Пример 108213: 2/12 пруфов с некорректной типизацией. Вердикт при этом корректен. Фикс — уточнить промпт Judge с примерами правильной типизации.
- Минорно: recovery_probability маппинг low=0 в "Подготовить SQL" теряет разницу между "низкий шанс" и "нет шанса". Исправить на 25 согласно прототипу.
