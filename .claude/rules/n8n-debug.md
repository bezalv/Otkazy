# Правила отладки n8n воркфлоу

## Запуск воркфлоу
- Запускать ТОЛЬКО через `n8n_test_workflow` MCP (workflowId, webhookPath, triggerType='webhook', data, waitForResponse=false)
- НИКОГДА curl или bash — песочница блокирует bezalv.ru (403)
- После запуска — СТОП. Ждать подтверждения Сани "закончилось"
- НЕ проверять статус execution самостоятельно

## Редактирование воркфлоу через MCP
- Использовать `n8n_update_partial_workflow` для точечных изменений (меняем только нужные ноды)
- `n8n_update_full_workflow` — когда нужно обновить весь воркфлоу целиком
- ПЕРЕД любым обновлением — сначала `n8n_get_workflow` чтобы увидеть текущее состояние
- ПОСЛЕ обновления — `n8n_validate_workflow` для проверки

## Типичные ошибки
1. **Молчаливый 404 на webhook** — webhookId не совпадает с path. Проверить оба значения
2. **$env не работает в Code-ноде** — перенести в expression-поле HTTP Request ноды
3. **SplitInBatches не собирает результаты** — использовать ТОЛЬКО $input.all() в collect-ноде
4. **n8n_autofix_workflow** — НЕ ИСПОЛЬЗОВАТЬ, ломает typeVersions
5. **Пустая транскрипция** — проверить двухпроходную логику (stereo → mono fallback)

## Диагностика
- Логи execution смотреть через n8n UI (делает Саня)
- Для отладки SQL — проверить через Supabase MCP execute_sql
- При ошибке воркфлоу — сначала проверить что credential правильный (Otkaz:*, не Priostanovlenie:*)

## Webhook paths этого проекта
- `lost-trigger` — триггер сбора данных
- `lost-batch` — пакетный прогон
- `lost-transcription` — транскрипция звонка
- `lost-analysis` — анализ сделки
