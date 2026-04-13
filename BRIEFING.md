Отказы Б24 — стартовый брифинг
Контекст
Этот проект — клон рабочей системы "Приостановленные Б24" с адаптацией под другую бизнес-задачу. Архитектурно почти всё переиспользуется как есть, меняется стадия-триггер, схема AI-классификации и целевой Supabase-проект.
Я (Саня) — начинающий вайбкодер. Ты — архитектор и технический лид. Говорим по-русски, ты объясняешь на пальцах что куда нажать. Я копирую твои промпты в Claude Code (CC), активирую воркфлоу в n8n UI, подтверждаю результаты. Технические решения ты принимаешь сам.
Бизнес-задача
Dinal (производство окон и дверей, Новосибирск) теряет сделки в стадии "Отказ" в Bitrix24. Часть отказов преждевременные: менеджер не дожал, не перезвонил, не отработал возражение. Система для каждой проигранной сделки отвечает на два вопроса:

Был ли отказ корректным, или менеджер закрыл ошибочно
Можно ли вернуть клиента прямо сейчас и каким способом (звонок, спецпредложение, смена менеджера, подождать N месяцев)

Что строим
AI-driven pipeline в n8n, который для каждой сделки в стадии Отказ:

Собирает данные сделки + историю коммуникаций из Bitrix24
Транскрибирует звонки и голосовые из чатов (Yandex SpeechKit)
Строит хронологический журнал событий
Считает 30+ метрик коммуникации (тренд, инициатива, разрывы, качество контактов)
Прогоняет через LLM (Claude Sonnet 3.7 через Polza.ai) с промптом «постмортем + возможность реанимации»
Пишет результат в Supabase

Сначала batch по историческим сделкам. Лайв-триггер от Битрикса — позже, после валидации промпта.
Что отличается от Приостановленных
ПараметрПриостановленныеОтказыСтадия-триггерC23:UC_F0XO84C23:LOSESupabase-проектqmxtuchlbjvlleffwmewwdosxmyemhdschannoarТаблицы БДdeals, deal_communications, deal_analyseslost_deals, lost_deal_communications, lost_deal_analysesВоркфлоу в n8n4 штуки (свои ID)4 штуки (свои ID, уже продублированы)Схема AI-классификации12 полей (maturity, reactivation_route, etc)10 полей (closure_correctness, recoverable_now, recovery_route, etc)
Всё остальное идентично — стек, принципы, паттерны.
Стек (наследуется как есть)

n8n self-hosted, bezalv.ru, версия 2.12.3, Docker Compose
Bitrix24 REST API (dinalnsk.bitrix24.ru/rest/65/<token>/) — токен в path URL, хардкод в HTTP Request нодах
Yandex SpeechKit — longRunningRecognize, S3 бакет n8n-transcription-audio, credential FQYoK9n3AGNz0G16
Polza.ai — https://api.polza.ai/api/v1, модель anthropic/claude-3.7-sonnet
Supabase — новый проект под этот репо (см. доступы ниже)

Воронка Bitrix24 — категория 23 (СЧП)
SORTSTATUS_IDНазвание20C23:NEWТехнический этап30C23:PREPARATIONПредварительный расчет стоимости40C23:PREPAYMENT_INVOICЗамер50C23:EXECUTINGРасчет стоимости60C23:FINAL_INVOICEПрезентация и согласование КП70C23:UC_GDK5HIПодписание договора и оплата80C23:UC_F0XO84Приостановленные90C23:WONСделка успешна100C23:LOSEОтказ ← ТРИГГЕР ЭТОГО ПРОЕКТА
Supabase — новый проект

URL: https://wdosxmyemhdschannoar.supabase.co
Project ID (для MCP): wdosxmyemhdschannoar
Publishable key: sb_publishable_-mC_LnCCanMZW-quPHvV1Q_VIQolKDA
Database password: в .env файле проекта (не в чате!)
Service role key: в .env файле проекта (не в чате!)
Connection string: postgresql://postgres:<password>@db.wdosxmyemhdschannoar.supabase.co:5432/postgres

БД пустая. Первая задача нового ассистента — создать миграцию 001_initial_schema.sql и применить через Supabase MCP.
Воркфлоу в n8n — уже продублированы
Саня уже сделал Duplicate в n8n UI. 4 воркфлоу в папке "Отказ" проекта n8n:
Имя воркфлоуНазначениеСтатусОтказ: Сбор данных сделкиТриггер + данные сделки + коммуникации (Блоки 1+2)Published, не активировать пока не поменяем webhook pathОтказ: Анализ сделкиТранскрипция + журнал + аналитика + AI (Блоки 3+4+4.5+5)Published, не активироватьОтказ: Транскрипция звонкаSub-workflow: звонок → SpeechKit → транскриптPublished, не активироватьОтказ: Пакетный прогонBatch по N сделкам через SplitInBatchesPublished, не активировать
ID новых воркфлоу я (Саня) пришлю в новой сессии — посмотрю в URL каждого воркфлоу.
Важно: после Duplicate у клонов остались webhook paths оригиналов (reactivation-*). Если активировать сейчас — будут конфликтовать с проектом Приостановленные. Перед активацией через n8n MCP поменять все пути на lost-* (например lost-trigger, lost-batch, lost-transcription, lost-analysis).
Sub-workflow транскрипции
Двойственное решение: клон Отказ: Транскрипция звонка уже сделан, но технически можно было переиспользовать оригинал из Приостановленных (iyBRlObTboHJdFYj) — он универсальный. Оба варианта рабочие. Решение: оставляем клон для полной изоляции проектов (ни одна зависимость между репо), но первый тест можно сделать и на оригинале если свой клон даёт сбой.
n8n-инстанс общий
Важно: n8n один на оба проекта. Это значит:

Credentials в n8n видны из любого воркфлоу — можно переиспользовать Priostanovlenie: Yandex SpeechKit, Priostanovlenie: Polza.ai (HTTP), Yandex Object Storage как есть
Для нового Supabase-проекта — создать новые credentials: Otkaz: Supabase Postgres и Otkaz: Supabase REST (anon) (эти креды смотрят на новый проект wdosxmyemhdschannoar)
Webhook paths должны быть уникальны по всему инстансу — префикс lost- обязателен

БД — схема (план)
lost_deals
Мастер-запись проигранной сделки. Структура идентична deals из Приостановленных — это осознанное решение: минимум правок в коде batch-prepare-sql (только имена таблиц в SQL). Поля pause_reason_id, pause_reason, pause_date, deferred_until, times_suspended остаются физически (в Битриксе они могут быть не заполнены для Отказов, но пусть будут — не мешают).
Дополнительные поля:

lose_reason_id (varchar) — ID причины отказа из Битрикса (если есть кастомное поле)
lose_reason (text) — текст причины отказа
lose_date (timestamptz) — когда перешла в Отказ
days_in_lost (int) — вычисляемое, сколько дней в отказе

Полный список колонок получить из проекта Приостановленные через Supabase:list_tables(qmxtuchlbjvlleffwmew, verbose=true).
lost_deal_communications
Идентично deal_communications из Приостановленных. Ничего не меняется.
lost_deal_analyses
Новая схема под задачу Отказов:
ПолеТипЗначения / описаниеidbigserial PKdeal_idintFK на lost_deals.deal_idai_summarytext2-3 предложения что произошлоai_exact_reasontextточная причина отказа своими словамиai_closure_correctnessvarcharcorrect / premature / manager_error / unclearai_closure_reason_classvarcharprice / competitor / no_need / no_money / timing / manager_dropped / customer_unreachable / otherai_recoverable_nowvarcharyes_high / yes_medium / yes_low / no / unclearai_recovery_probabilityint0-100ai_recovery_routevarcharurgent_call / special_offer / manager_change / wait_3m / wait_6m / close_permanently / otherai_manager_mistakesjsonbмассив строк — что менеджер сделал не такai_recovery_scripttextчто говорить при контакте с клиентомai_key_signalsjsonbмассив сигналов в пользу восстановленияai_risk_factorsjsonbмассив рисковai_misplacedboolпопала ли сделка в Отказ по ошибке стадии (например должна быть в WON)ai_correct_stagetextесли misplaced=true — какая стадия правильнаяllm_model, llm_*tokens, llm_warnings—идентично Приостановленнымcomm_total_at_run, calls_transcribed_at_run—идентичноfull_prompt_text, journal_text, prompt_chars, prompt_approx_tokens—идентичноprocessing_time_sec, prompt_version, pipeline_error, trigger_type, processed_at, created_at—идентично
batch_lock
Точная копия из Приостановленных (защита от параллельных batch-прогонов).
Важно: при создании записать в batch_lock строку (id=1, is_locked=false) — в Приостановленных эту строку забыли и lock никогда не работал. Не повторяй эту ошибку.
Стратегия запуска
Фаза 1: инфраструктура (первая сессия)

Создать миграцию 001_initial_schema.sql — 4 таблицы + начальная строка в batch_lock
Применить через Supabase MCP в проекте wdosxmyemhdschannoar
Создать 2 credentials в n8n:

Otkaz: Supabase Postgres (postgres, port 5432, новый пароль)
Otkaz: Supabase REST (anon) (httpCustomAuth, headers apikey + Authorization Bearer, оба = publishable key)


Саня присылает ID новых воркфлоу Отказов из n8n UI

Фаза 2: адаптация клонов воркфлоу
Через n8n MCP в каждом из 4 воркфлоу:

Поменять webhook paths: reactivation-* → lost-*
В триггерном фильтре: C23:UC_F0XO84 → C23:LOSE
В SQL-запросах (batch-prepare-sql, batch-config, batch_lock): заменить имена таблиц на lost_*
Перепривязать Postgres credential с Supabase Priostanovlenniye на Otkaz: Supabase Postgres
Перепривязать REST credential с Priostanovlenie: Supabase REST (anon) на Otkaz: Supabase REST (anon)
Внутренние webhook-URL между воркфлоу (из Пакетного прогона в Сбор данных, из Анализа в Транскрипцию) — поменять на новые lost-* paths
AI оставить отключённым (b5-prepare/b5-llm-request/b5-parse disabled, активна нода "Возврат без AI")
Активировать все 4 воркфлоу

Фаза 3: тестовый прогон

Найти в Bitrix24 через MCP 2-3 свежие сделки в стадии C23:LOSE
Запустить Пакетный прогон через n8n MCP с deal_ids этих сделок
Проверить в Supabase через MCP: 3 таблицы заполнены корректно, журнал собран, транскрипции есть, ai_* поля null (AI отключён)
Если OK — прогнать batch по ~20-30 историческим отказам для накопления данных

Фаза 4: промпт под Отказы (отдельная большая задача)
Разработать промпт с учётом 10 новых полей классификации. Протестировать на подвыборке. Итеративно улучшать. Только после этого включать AI-анализ (enable 3 ноды, disable "Возврат без AI").
Фаза 5: лайв-триггер
Настроить webhook в Bitrix24 на переход в C23:LOSE. Не до полной валидации промпта.
Ключевые правила (наследуются)
n8n 2.12.3 — критические ограничения

process.env.X и $env.X в Code-нодах не работают (заблокировано настройкой N8N_BLOCK_ENV_ACCESS_IN_NODE=true)
$env.X работает только в expression-полях (URL, headers, body HTTP Request, Set, IF)
Code-ноды НЕ делают сетевых вызовов. Только JS-логика. Все HTTP — через HTTP Request ноды с credentials
SplitInBatches v3: сбор результатов loop'а в collect-ноде только через $input.all(). НЕ $('NodeName').all(), НЕ customData, НЕ staticData
Webhook ноды требуют webhookId совпадающий с path, иначе молчаливый 404
n8n_autofix_workflow ломает typeVersions — избегать

Запуск воркфлоу

Только через n8n_test_workflow MCP-инструмент. Параметры: workflowId, webhookPath, triggerType='webhook', data={...}, waitForResponse=false
НЕ через curl, НЕ через bash_tool — песочница блокирует bezalv.ru с 403
После запуска — СТОП, жди подтверждения Сани "закончилось"
Никогда не проверяй статус execution сам — это делает Саня

Bitrix24

URL с токеном хардкодится в HTTP Request нодах (токен в path, несовместим с credentials)
Пагинация crm.activity.list обязательна через цикл с параметром start
channelTag 1 = Менеджер ВСЕГДА (не зависит от direction звонка)
Загрузка чатов: crm.activity.list(PROVIDER_ID='IMOPENLINES_SESSION') → SESSION_ID → imopenlines.session.history.get(SESSION_ID). НЕ через CHAT_ID — вернёт только последнюю сессию
Scheduled activities (дела-напоминания) фильтруются по |START_TIME - CREATED| > 10 мин → обнуление call_duration_seconds
В crm.activity.list запрашивать поля PROVIDER_TYPE_ID, COMPLETED для диагностики

Транскрипция

Двухпроходная: pass1 = channel_count=2 (stereo), если formatted_dialog пустой → pass2 = channel_count=1 + speaker_role (mono fallback)
Эвристика по имени файла не используется (была источник багов)
Голосовые из чатов (mp3, mpga, ogg, opus, wav, m4a, oga) транскрибируются через тот же sub-workflow с channel_count=1
Voicemail-детекция в batch-prepare-sql: 9 паттернов автоответчиков операторов → transcript_status='voicemail'

Фильтры данных

Виталий Попов (assigned_by_id=20903) — исключается из обработки. Сохранить фильтр EXCLUDED_RESPONSIBLE = ['20903'] в batch-parse-input или эквиваленте
Файловые пустышки (PDF/JPEG без текста и без аудио) не попадают в БД
Системные сообщения Wazzup и Bitrix24 (20+ паттернов) фильтруются

Секреты

Publishable key и project ID можно упоминать в чате
Service role key и database password — никогда не в чат. Только в .env или credentials n8n
Если секрет случайно попал в чат — немедленно ротировать

Git и документация

После каждой фазы: git commit + push
Коммиты на русском, понятные
В Project.md фиксировать прогресс фаз и принятые решения
CLAUDE.md держать компактным — правила рабочего потока, не дублировать Project.md

Структура репо (план)
otkazy-b24/
├── CLAUDE.md              # правила работы Claude Code (компактно)
├── Project.md             # состояние проекта, прогресс, решения
├── BRIEFING.md            # этот файл, стартовый контекст
├── README.md              # краткое описание для внешних
├── .env                   # секреты (в .gitignore)
├── .env.example           # шаблон
├── .gitignore             # исключает .env, workflows/
├── db/
│   └── migrations/
│       └── 001_initial_schema.sql
└── .claude/
    └── rules/
        ├── n8n-debug.md
        └── server-ops.md
Папку workflows/ не делать пока JSON-дампы воркфлоу содержат захардкоженные токены Bitrix.