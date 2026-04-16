# План миграции мульти-агентного анализа в n8n

## Контекст

Прототип мульти-агентного анализа Отказов работает локально (Node.js, `prototype/`). Три успешных прогона на Opus 4.6 (113759, 113585, 111149). Архитектура:

```
Facts Assembler (детерминированный) → Judge (LLM, JSON) → Proof Validator (детерминированный) → Writer (LLM, plain text, только если неправомерен)
```

Файлы прототипа:
- `prototype/lib/facts_assembler.js` — сборщик фактов из Supabase (**в n8n работать иначе**, см. ниже)
- `prototype/lib/judge.js` — HTTP к Polza
- `prototype/lib/proof_validator.js` — валидация пруфов
- `prototype/lib/writer.js` — HTTP к Polza
- `prototype/prompts/judge_v1.md` — системный промпт Judge
- `prototype/prompts/writer_v1.md` — системный промпт Writer
- `prototype/lib/models.js` — константы моделей (обе = `anthropic/claude-opus-4.6`)

Задача — портировать пайплайн в воркфлоу n8n `GLQ2iuzRaCQZM7QU` (Отказ: Анализ сделки).

## Что поменять в текущем воркфлоу

Текущая структура (активные ноды):

```
Webhook Блок 3 → Config + Фильтр звонков → IF → Транскрибировать/Пропуск → Собрать итог
  → Блок 4: Хронологический журнал → b4.5 Comm Analytics → Возврат без AI (финал)
```

Три отключённые ноды (b5-prepare / b5-llm-request / b5-parse) — это **старая заготовка для монолитного LLM-анализа Приостановленных**. Их **использовать НЕ будем** — удалить после тестов новой схемы.

Целевая структура после миграции:

```
... b4.5 Comm Analytics →
  ① agent-facts-assembler (Code, новая) →
  ② agent-judge-call (HTTP Request, новая, Polza + Opus 4.6) →
  ③ agent-judge-parse (Code, новая — парсинг JSON + proof validator) →
  ④ verdict-router (IF, новая — проверка verdict=="неправомерен") →
    ├─ TRUE  → ⑤ agent-writer-call (HTTP Request, новая) → ⑥ agent-writer-parse (Code) → ⑦ merge
    └─ FALSE → ⑦ merge (сразу)
  → ⑧ final-output (Code, новая — формирует итоговый пакет для вызывающего воркфлоу)
```

«Возврат без AI» **не удаляем**, оставляем отключённым (`disabled: true`) — как аварийный fallback на случай если Polza упадёт.

## Важно про данные

В n8n НЕ нужно читать из Supabase в Facts Assembler. Все данные уже в потоке:

- `$input.first().json.communications` — массив коммуникаций (см. структуру в коде ноды `Блок 4: Хронологический журнал`). Поля: `type`, `date`, `direction`, `text`, `transcript`, `transcript_client_text`, `transcript_manager_text`, `author_name`, `role`, `channel`, `title`, `status`.
- `$input.first().json.comm_analytics` — агрегированные метрики (построены в `b4.5`).
- `$input.first().json.deal_id`, `.title`, `.opportunity`, `.lose_reason`, `.lose_date`, `.days_in_lost` — поля карточки (уже в потоке с самого начала).

Это сильно упрощает Facts Assembler по сравнению с Node.js версией — чистая трансформация, без запросов к БД.

## Маппинг Facts

`communications[i]` → `facts[]`:

| `comm.type` | Как разметить |
|---|---|
| `call` с `transcript_manager_text` | один факт: `source=call_transcript, actor=manager, content=transcript_manager_text` |
| `call` с `transcript_client_text` | отдельный факт: `source=call_transcript, actor=client, content=transcript_client_text` |
| `call` без транскрипта | `source=call_event, actor=system, content="Звонок <direction>, <duration>"` |
| `chat` (пропустить если `role===unknown` в системных типа «начал работу с диалогом») | `source=chat, actor=(role или из direction), content=text` |
| `comment` | `source=crm_comment, actor=manager, content=text` |
| `task` | `source=crm_task, actor=manager, content=title` |

ID фактов: `f001`, `f002`, … в порядке `event_date`.

## Полный код нод (копировать в n8n)

### Нода ① `agent-facts-assembler` (Code, typeVersion 2)

Берёт input от `b4.5 Comm Analytics`, формирует `facts_packet` для Judge.

```javascript
var input = $input.first().json;
var comms = input.communications || [];
var analytics = input.comm_analytics || {};

// Сортируем коммуникации по дате
function parseDate(d) { if (!d) return 0; var t = new Date(d).getTime(); return isNaN(t) ? 0 : t; }
comms = comms.slice().sort(function(a, b) { return parseDate(a.date) - parseDate(b.date); });

var facts = [];
var idx = 0;
function nextId() { idx++; return 'f' + String(idx).padStart(3, '0'); }

for (var i = 0; i < comms.length; i++) {
  var c = comms[i];
  var ts = c.date;

  if (c.type === 'call') {
    var hasMgr = c.transcript_manager_text && c.transcript_manager_text.trim().length > 0;
    var hasCli = c.transcript_client_text && c.transcript_client_text.trim().length > 0;
    if (hasMgr) {
      facts.push({
        fact_id: nextId(), source: 'call_transcript', actor: 'manager',
        ts: ts, direction: c.direction || null,
        content: c.transcript_manager_text.trim()
      });
    }
    if (hasCli) {
      facts.push({
        fact_id: nextId(), source: 'call_transcript', actor: 'client',
        ts: ts, direction: c.direction || null,
        content: c.transcript_client_text.trim()
      });
    }
    if (!hasMgr && !hasCli) {
      var dur = c.duration_seconds || 0;
      facts.push({
        fact_id: nextId(), source: 'call_event', actor: 'system',
        ts: ts, direction: c.direction || null,
        content: 'Звонок ' + (c.direction || '?') + ', ' + dur + ' сек, без транскрипта'
      });
    }
  } else if (c.type === 'chat') {
    var txt = (c.text || '').trim();
    // Фильтр системных сообщений Wazzup
    if (!txt) continue;
    if (txt.indexOf('[USER=') === 0 && (txt.indexOf('начал работу с диалогом') !== -1 || txt.indexOf('завершил работу') !== -1 || txt.indexOf('Обращение направлено на') !== -1)) continue;
    var actor = 'unknown';
    if (c.role === 'client' || (c.direction === 'incoming' && c.author_name === 'Клиент')) actor = 'client';
    else if (c.role === 'manager' || c.direction === 'outgoing') actor = 'manager';
    facts.push({
      fact_id: nextId(), source: 'chat', actor: actor,
      ts: ts, channel: c.channel || null, author_name: c.author_name || null,
      content: txt
    });
    // Если у chat есть голосовой транскрипт — отдельный факт
    if (c.transcript && c.transcript.trim().length > 0) {
      facts.push({
        fact_id: nextId(), source: 'chat_voice_transcript', actor: actor,
        ts: ts, channel: c.channel || null,
        content: c.transcript.trim()
      });
    }
  } else if (c.type === 'comment') {
    if (!c.text || !c.text.trim()) continue;
    facts.push({
      fact_id: nextId(), source: 'crm_comment', actor: 'manager',
      ts: ts, content: c.text.trim()
    });
  } else if (c.type === 'task') {
    if (!c.title) continue;
    facts.push({
      fact_id: nextId(), source: 'crm_task', actor: 'manager',
      ts: ts, task_status: c.status || null, content: c.title
    });
  }
}

var deal_card = {
  deal_id: input.deal_id,
  title: input.title,
  opportunity: input.opportunity,
  currency: input.currency,
  lose_reason: input.lose_reason,
  lose_date: input.lose_date,
  days_in_lost: input.days_in_lost,
  stage_id: input.stage_id,
  stage_name: input.stage_name,
  date_create: input.date_create,
  assigned_by_id: input.assigned_by_id,
  source: input.source
};

var facts_packet = {
  deal_card: deal_card,
  metrics: analytics,
  facts: facts
};

// Формируем тело запроса к Polza для Judge
var JUDGE_MODEL = 'anthropic/claude-opus-4.6';
var JUDGE_SYSTEM_PROMPT = $('Set: Judge System Prompt').first().json.content;

var judge_request_body = {
  model: JUDGE_MODEL,
  messages: [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(facts_packet, null, 2) }
  ],
  max_tokens: 4000,
  temperature: 0
};

return [{
  json: {
    deal_id: input.deal_id,
    facts_packet: facts_packet,
    facts_count: facts.length,
    judge_request_body: judge_request_body,
    // прокидываем данные которые понадобятся позже
    deal_card: deal_card,
    communications: comms,
    journal_text: input.journal_text,
    analytics_text: input.analytics_text,
    transcription_stats: input.transcription_stats,
    _block: 'agent_facts_assembled'
  }
}];
```

### Нода подачи системного промпта Judge (Set-нода «Set: Judge System Prompt», ставится ОДИН РАЗ где-то в начале workflow до agent-facts-assembler)

Тип: **Set** (n8n-nodes-base.set, typeVersion 3.4).

Поле:
- Name: `content`
- Type: `String`
- Value: **полный текст из `prototype/prompts/judge_v1.md`** (скопировать целиком, экранирование в Set не требуется).

Такую же Set-ноду сделать для Writer: «Set: Writer System Prompt» с текстом `prototype/prompts/writer_v1.md`.

Обе Set-ноды **вставить параллельно основному пайплайну** (не включать в поток main), чтобы они не блокировали выполнение — или воткнуть первыми после Webhook. Рекомендую второй вариант для простоты.

### Нода ② `agent-judge-call` (HTTP Request, typeVersion 4.2)

- Method: POST
- URL: `https://api.polza.ai/api/v1/chat/completions`
- Authentication: Generic Credential Type → HTTP Header Auth → переиспользовать `Priostanovlenie: Polza.ai (HTTP)` (credential ID `DHlZN13kcEu6VU2o`)
- Headers: `Content-Type: application/json`
- Body: JSON
- jsonBody: `={{ JSON.stringify($json.judge_request_body) }}`
- Options → Timeout: `180000` (3 минуты — Opus отвечает дольше чем Sonnet)

### Нода ③ `agent-judge-parse` (Code, typeVersion 2)

Парсит ответ Judge + прогоняет proof validation.

```javascript
var input = $input.first().json;
var prev = $('agent-facts-assembler').first().json;
var factsPacket = prev.facts_packet || {};
var facts = factsPacket.facts || [];
var metrics = factsPacket.metrics || {};

// 1. Достаём текст ответа
var content = '';
try {
  if (input.choices && input.choices[0] && input.choices[0].message) {
    content = input.choices[0].message.content || '';
  } else if (input.content) {
    content = input.content;
  }
} catch (e) { content = ''; }

if (!content) {
  return [{ json: { error: true, message: 'Empty LLM response', raw: JSON.stringify(input).substring(0, 500), _block: 'judge_error' } }];
}

// 2. Парсим JSON: direct → regex
var judge = null;
var parseMethod = 'direct';
try { judge = JSON.parse(content.trim()); }
catch (e1) {
  parseMethod = 'regex';
  var m = content.match(/\{[\s\S]*\}/);
  if (m) { try { judge = JSON.parse(m[0]); } catch (e2) { judge = null; } }
}

if (!judge) {
  return [{ json: { error: true, message: 'Failed to parse JSON', raw: content.substring(0, 1000), _block: 'judge_error' } }];
}

// 3. Валидация структуры
var required = ['verdict', 'verdict_reason_short', 'closure_reason_class', 'misplaced', 'exact_reason', 'manager_mistakes', 'key_signals', 'risk_factors'];
var missing = [];
for (var rf = 0; rf < required.length; rf++) {
  if (judge[required[rf]] === undefined) missing.push(required[rf]);
}
if (missing.length > 0) {
  return [{ json: { error: true, message: 'Missing fields: ' + missing.join(', '), judge: judge, _block: 'judge_error' } }];
}

// 4. Proof Validator
var factIdSet = {};
for (var fi = 0; fi < facts.length; fi++) factIdSet[facts[fi].fact_id] = facts[fi];

var warnings = [];
var errorCount = 0;

function validateProofs(items, category) {
  for (var i = 0; i < (items || []).length; i++) {
    var item = items[i];
    var proofIds = item.proof_fact_ids || [];
    var proofType = item.proof_type || null;
    for (var p = 0; p < proofIds.length; p++) {
      var pid = proofIds[p];
      if (pid.indexOf('metric:') === 0) {
        var metricName = pid.substring(7);
        if (metrics[metricName] === undefined) {
          warnings.push({ path: category + '[' + i + ']', issue: 'metric ' + metricName + ' не существует', severity: 'error' });
          errorCount++;
        }
        continue;
      }
      var fact = factIdSet[pid];
      if (!fact) {
        warnings.push({ path: category + '[' + i + ']', issue: 'fact_id ' + pid + ' не существует', severity: 'error' });
        errorCount++;
        continue;
      }
      // Проверка соответствия proof_type и характеристик факта
      if (proofType === 'client_statement') {
        if (fact.actor !== 'client' || ['call_transcript','chat','chat_voice_transcript'].indexOf(fact.source) === -1) {
          warnings.push({ path: category + '[' + i + ']', issue: 'proof_type=client_statement, но ' + pid + '.actor=' + fact.actor + ', source=' + fact.source, severity: 'error' });
          errorCount++;
        }
      } else if (proofType === 'manager_statement') {
        if (fact.actor !== 'manager' || ['call_transcript','chat','chat_voice_transcript'].indexOf(fact.source) === -1) {
          warnings.push({ path: category + '[' + i + ']', issue: 'proof_type=manager_statement, но ' + pid + '.actor=' + fact.actor + ', source=' + fact.source, severity: 'error' });
          errorCount++;
        }
      } else if (proofType === 'crm_comment') {
        if (fact.source !== 'crm_comment') {
          warnings.push({ path: category + '[' + i + ']', issue: 'proof_type=crm_comment, но source=' + fact.source, severity: 'error' });
          errorCount++;
        }
      }
    }
  }
}

validateProofs(judge.manager_mistakes, 'manager_mistakes');
validateProofs(judge.key_signals, 'key_signals');
validateProofs(judge.risk_factors, 'risk_factors');

// Usage
var usage = input.usage || {};

// Формируем тело запроса к Writer (заранее, даже если не пригодится)
var WRITER_MODEL = 'anthropic/claude-opus-4.6';
var WRITER_SYSTEM_PROMPT = $('Set: Writer System Prompt').first().json.content;

var writer_input = {
  deal_card: factsPacket.deal_card,
  facts: facts,
  metrics: metrics,
  judge: judge
};

var writer_request_body = {
  model: WRITER_MODEL,
  messages: [
    { role: 'system', content: WRITER_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(writer_input, null, 2) }
  ],
  max_tokens: 2500,
  temperature: 0.2
};

return [{
  json: {
    deal_id: prev.deal_id,
    judge: judge,
    judge_model: input.model || WRITER_MODEL,
    judge_usage: usage,
    judge_parse_method: parseMethod,
    proof_warnings: warnings,
    proof_errors_count: errorCount,
    writer_request_body: writer_request_body,
    facts_packet: factsPacket,
    // пробрасываем остальное
    deal_card: prev.deal_card,
    communications: prev.communications,
    journal_text: prev.journal_text,
    analytics_text: prev.analytics_text,
    transcription_stats: prev.transcription_stats,
    _block: 'judge_parsed'
  }
}];
```

### Нода ④ `verdict-router` (IF, typeVersion 2.2)

- Condition: `{{ $json.judge.verdict }}` equals `неправомерен`
- TRUE → agent-writer-call
- FALSE → merge (пропускает Writer, final_comment="Отказ правомерен")

### Нода ⑤ `agent-writer-call` (HTTP Request)

Идентично agent-judge-call:
- Method: POST
- URL: `https://api.polza.ai/api/v1/chat/completions`
- Authentication: `Priostanovlenie: Polza.ai (HTTP)`
- jsonBody: `={{ JSON.stringify($json.writer_request_body) }}`
- Timeout: `180000`

### Нода ⑥ `agent-writer-parse` (Code)

```javascript
var input = $input.first().json;
var prev = $('agent-judge-parse').first().json;

var content = '';
try {
  if (input.choices && input.choices[0] && input.choices[0].message) {
    content = input.choices[0].message.content || '';
  }
} catch (e) { content = ''; }

var usage = input.usage || {};

return [{
  json: {
    deal_id: prev.deal_id,
    judge: prev.judge,
    judge_model: prev.judge_model,
    judge_usage: prev.judge_usage,
    proof_warnings: prev.proof_warnings,
    proof_errors_count: prev.proof_errors_count,
    final_comment: content.trim(),
    writer_model: input.model || 'anthropic/claude-opus-4.6',
    writer_usage: usage,
    facts_packet: prev.facts_packet,
    deal_card: prev.deal_card,
    communications: prev.communications,
    journal_text: prev.journal_text,
    analytics_text: prev.analytics_text,
    transcription_stats: prev.transcription_stats,
    _block: 'writer_done'
  }
}];
```

### Нода ⑦ `merge-verdict` (Merge, typeVersion 3)

- Mode: `Combine` → Position → `Pass-through` не нужен, просто возьмём данные из того плеча, которое сработало.

**Проще**: вместо Merge-ноды сделать **две отдельные ветки, сходящиеся в одну финальную Code-ноду** `final-output`. Она сама определит откуда пришло.

Для FALSE-ветки IF (verdict=="правомерен") добавить промежуточную Code-ноду `skip-writer`:

```javascript
var prev = $input.first().json;
return [{
  json: {
    deal_id: prev.deal_id,
    judge: prev.judge,
    judge_model: prev.judge_model,
    judge_usage: prev.judge_usage,
    proof_warnings: prev.proof_warnings,
    proof_errors_count: prev.proof_errors_count,
    final_comment: 'Отказ правомерен',
    writer_model: null,
    writer_usage: null,
    facts_packet: prev.facts_packet,
    deal_card: prev.deal_card,
    communications: prev.communications,
    journal_text: prev.journal_text,
    analytics_text: prev.analytics_text,
    transcription_stats: prev.transcription_stats,
    _block: 'writer_skipped'
  }
}];
```

Обе ветки (agent-writer-parse и skip-writer) → `final-output`.

### Нода ⑧ `final-output` (Code)

Формирует итоговый ответ для вызывающего воркфлоу (формат должен быть совместим с тем, что ожидает Пакетный прогон / Сбор данных для записи в БД).

**Здесь CC должен сначала прочитать воркфлоу Пакетного прогона `BhPWB9S6W5dlMUvV` и Сбор данных `qNPqFd0LE4dlYQDH` через n8n MCP**, чтобы понять какой формат ответа они ждут и где делается запись в БД. Без этого точный код `final-output` нельзя написать. Текущая нода «Возврат без AI» возвращает:

```
{ classification: null, llm_meta: {...}, communications: [...], transcription_stats: {...}, journal_text, full_prompt_text, journal_stats, comm_analytics, analytics_text, _block, _ready_for }
```

Значит минимум надо:
1. Оставить все эти поля (`communications`, `transcription_stats`, `journal_text`, `comm_analytics`, `analytics_text`) — прокидываются как есть.
2. Заменить `classification: null` на новое поле `multi_agent_analysis` (или аналог) со структурой:

```javascript
{
  verdict: judge.verdict,
  verdict_reason_short: judge.verdict_reason_short,
  recoverable_level: judge.recoverable_level,
  closure_reason_class: judge.closure_reason_class,
  misplaced: judge.misplaced,
  correct_stage: judge.correct_stage,
  exact_reason: judge.exact_reason,
  manager_mistakes: judge.manager_mistakes,
  key_signals: judge.key_signals,
  risk_factors: judge.risk_factors,
  questions_for_manager: judge.questions_for_manager,
  final_comment: final_comment,
  judge_model: judge_model,
  judge_usage: judge_usage,
  writer_model: writer_model,
  writer_usage: writer_usage,
  proof_warnings: proof_warnings,
  facts_json: facts_packet
}
```

3. Для обратной совместимости — замапить новую структуру на старые поля `last_ai_*` из `lost_deals` и `ai_*` из `lost_deal_analyses`. Маппинг:
   - `ai_closure_correctness`: `correct` если verdict=правомерен, иначе `premature`
   - `ai_recoverable_now`: `no` если правомерен, `yes_high`/`yes_medium` по recoverable_level
   - `ai_closure_reason_class` = `judge.closure_reason_class`
   - `ai_misplaced` = `judge.misplaced`
   - Новое поле `ai_final_comment` = `final_comment`
   - Новое `ai_verdict` = `judge.verdict`
   - И т.д. — см. колонки в `lost_deal_analyses` (миграция 002)

## План работ для CC

1. **Прочитать** через n8n MCP `n8n_get_workflow` полный JSON воркфлоу:
   - `BhPWB9S6W5dlMUvV` — Отказ: Пакетный прогон
   - `qNPqFd0LE4dlYQDH` — Отказ: Сбор данных сделки
   
   Определить где именно идёт запись в Supabase (Postgres-нода), какие поля она ожидает. Это влияет на формат `final-output`.

2. **Создать две Set-ноды** с системными промптами Judge и Writer (контент из `prototype/prompts/*.md`). Вставить в начало воркфлоу сразу после Webhook.

3. **Добавить 7 новых нод** по схеме выше, соединить их после `b4.5 Comm Analytics`. «Возврат без AI» отключить (`disabled: true`), не удалять — как safety fallback.

4. **Тестировать на сделке 113759** через `n8n_test_workflow` MCP-инструмент (либо через вебхук `/webhook-test/lost-analysis`). Webhook-path: `lost-analysis`. Триггер-тип: webhook.

5. **Сравнить результат** с локальным прогоном прототипа — должны получиться те же verdict, closure_reason_class, recoverable_level и похожий `final_comment`. Проверить что `proof_errors_count === 0`.

6. После успеха на 113759 — прогнать через Пакетный прогон на 113585 и 111149.

## Известные ограничения

- Polza Opus 4.6: Judge ~30 сек, Writer ~60-90 сек. Итого до ~2 минут на сделку. Timeout HTTP-нод — 180 сек.
- `jsonBody` в HTTP Request через expression `={{ JSON.stringify($json.judge_request_body) }}` — проверенный паттерн, работает.
- Credentials для Polza — переиспользуем существующий `Priostanovlenie: Polza.ai (HTTP)` (id `DHlZN13kcEu6VU2o`). Новый под Отказы создавать не нужно.

## Правила работы Саня/CC/n8n

- Воркфлоу **только через n8n MCP**. Руками в UI — только если CC не справляется.
- Тест запуска — только через `n8n_test_workflow`. НЕ curl, НЕ bash — sandbox блокирует bezalv.ru.
- После запуска — Саня сам смотрит результат в n8n UI, CC не проверяет executions сам.
- `n8n_autofix_workflow` не использовать — ломает typeVersions.