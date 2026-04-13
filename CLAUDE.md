# Отказы Б24 — правила для Claude Code

Язык проекта — русский. Детали бизнес-логики и стека — в BRIEFING.md, не дублировать здесь.

## n8n 2.12.3 — ограничения
- `process.env.X` и `$env.X` в Code-нодах **НЕ работают** (N8N_BLOCK_ENV_ACCESS_IN_NODE=true)
- `$env.X` работает только в expression-полях (URL, headers, body HTTP Request, Set, IF)
- Code-ноды не ходят в сеть — HTTP только через HTTP Request ноды
- SplitInBatches v3: сбор результатов только через `$input.all()`
- Webhook ноды: webhookId должен совпадать с path, иначе молчаливый 404
- `n8n_autofix_workflow` ломает typeVersions — не использовать

## Запуск воркфлоу
- Только через `n8n_test_workflow` MCP, **НЕ** через curl/bash (песочница → 403)
- После запуска — **СТОП**, ждать подтверждения пользователя «закончилось»
- Не проверять статус execution самому — это делает пользователь

## Секреты
- `service_role_key` и `db_password` — **никогда в чат**, только в `.env` или credentials n8n
- Утечка секрета → немедленная ротация

## Webhook paths
- Префикс `lost-*` обязателен (lost-trigger, lost-batch, lost-transcription, lost-analysis)
- НЕ `reactivation-*` — это проект Приостановленных

## Git
- Коммиты на русском
- После каждой фазы: `git commit` + `git push`
- Прогресс фиксировать в Project.md
