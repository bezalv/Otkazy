# Правила серверных операций

## Общие принципы
- Сервер n8n: bezalv.ru (Docker Compose)
- n8n один на оба проекта (Приостановленные + Отказы) — быть осторожным с общими ресурсами
- Credentials в n8n видны из любого воркфлоу — можно переиспользовать Yandex SpeechKit, Polza.ai, Yandex Object Storage

## Credentials этого проекта
Создать новые (НЕ переиспользовать из Приостановленных):
- `Otkaz: Supabase Postgres` — postgres, port 5432, пароль из .env
- `Otkaz: Supabase REST (anon)` — httpCustomAuth, headers apikey + Authorization Bearer = publishable key

Переиспользовать из Приостановленных:
- `Priostanovlenie: Yandex SpeechKit` — для транскрипции
- `Priostanovlenie: Polza.ai (HTTP)` — для LLM
- `Yandex Object Storage` — S3 бакет n8n-transcription-audio

## Supabase операции
- Миграции хранить в `db/migrations/`
- Применять через Supabase MCP: `apply_migration(project_id='wdosxmyemhdschannoar', ...)`
- Проверять результат через `execute_sql` или `list_tables`

## Bitrix24
- Домен: dinalnsk.bitrix24.ru
- Воронка: категория 23 (СЧП)
- Триггер этого проекта: C23:LOSE (sort=100)
- Токен в path URL хардкодом в HTTP Request нодах
- Исключённый менеджер: Виталий Попов (assigned_by_id=20903)

## Безопасность
- НЕ коммитить JSON-дампы воркфлоу (хардкод токенов)
- НЕ выводить в чат service role key и db password
- При утечке секрета — немедленная ротация
