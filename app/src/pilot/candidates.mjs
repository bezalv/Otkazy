/**
 * Изолированное чтение эталонов для ручного пилота. Этот модуль не запускает
 * обработчик, не пишет в БД и не отправляет данные наружу. Факты возвращаются
 * только вызывающему коду и могут содержать персональные данные: не логировать.
 */

const TABLES = ['lost_deals', 'lost_deal_analyses', 'lost_audio_wait', 'lost_audio_wait_config'];
const VERDICTS = new Set(['правомерен', 'неправомерен', 'недостаточно_данных']);
const MAX_DEAL_ID = 2147483647n;

function parseDealIds(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 5) throw new TypeError('Нужно выбрать от одной до пяти сделок');
  const seen = new Set();
  return values.map(value => {
    if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d{0,9}$/.test(String(value))
        || (typeof value === 'number' && !Number.isSafeInteger(value)) || BigInt(value) > MAX_DEAL_ID
        || seen.has(String(value))) throw new TypeError('Некорректный список сделок');
    seen.add(String(value));
    return Number(value);
  });
}

function iso(value) {
  if (!(value instanceof Date) && typeof value !== 'string') throw new Error('Некорректная дата эталона');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Некорректная дата эталона');
  return date.toISOString();
}

function normalizeRow(row, includeFacts) {
  if (!row || !Number.isInteger(Number(row.deal_id)) || Number(row.deal_id) < 1
      || !/^[1-9]\d*$/.test(String(row.analysis_id)) || !VERDICTS.has(row.ai_verdict)) {
    throw new Error('Некорректные метаданные эталона');
  }
  if (includeFacts && (!row.ai_facts_json || typeof row.ai_facts_json !== 'object'
      || Array.isArray(row.ai_facts_json) || !Array.isArray(row.ai_facts_json.facts))) {
    throw new Error('Нет сохранённых фактов эталона');
  }
  const base = {
    deal_id: Number(row.deal_id), analysis_id: String(row.analysis_id),
    processed_at: iso(row.processed_at), prompt_version: row.prompt_version ?? null,
    judge_model: row.judge_model ?? null, ai_verdict: row.ai_verdict,
    ai_reason_class: row.ai_reason_class ?? null,
    lose_date: row.lose_date == null ? null : iso(row.lose_date), stage_id: row.stage_id ?? null,
    // Дата и стадия — значения текущей карточки БД, не снимок на момент анализа.
    card_snapshot_may_have_changed: true, historical_transition_unverified: true,
    // NULL pipeline_operation_id отличает известные новые записи, но не доказывает источник остальных.
    legacy_origin_verified: false,
  };
  if (includeFacts) return { ...base, ai_facts_json: row.ai_facts_json, ai_judge_json: row.ai_judge_json ?? null };
  for (const field of ['has_call_facts', 'has_chat_facts', 'has_voice_facts', 'has_screenshot_facts']) {
    if (typeof row[field] !== 'boolean') throw new Error('Некорректная сводка источников');
    base[field] = row[field];
  }
  return base;
}

async function readOnlySnapshot(pool, read) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Нужен пул PostgreSQL');
  let connection;
  try { connection = await pool.connect(); }
  catch { throw new Error('Не удалось безопасно прочитать эталоны'); }
  let releaseError;
  try {
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const mode = await connection.query("SELECT current_setting('transaction_read_only') AS read_only");
    if (mode.rows?.length !== 1 || mode.rows[0].read_only !== 'on') throw new Error('Транзакция не защищена от записи');
    const visibility = await connection.query(`SELECT count(*)::integer AS table_count,
        bool_and(c.relkind IN ('r','p')) AS all_tables,
        bool_or(row_security_active(c.oid)) AS rls_active,
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.lost_deal_analyses')
          AND attname='pipeline_operation_id' AND NOT attisdropped) AS has_operation_column
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])`, [TABLES]);
    const access = visibility.rows?.[0];
    if (!access || Number(access.table_count) !== TABLES.length || access.all_tables !== true
        || access.rls_active !== false || typeof access.has_operation_column !== 'boolean') {
      throw new Error('Нельзя подтвердить полную видимость исходных таблиц');
    }
    const result = await read(connection, access.has_operation_column);
    await connection.query('COMMIT');
    return result;
  } catch {
    try { await connection.query('ROLLBACK'); } catch (error) { releaseError = error; }
    // Текст и детали SQL-ошибки могут содержать секреты/содержимое сделки.
    throw new Error('Не удалось безопасно прочитать эталоны');
  } finally { connection.release(releaseError); }
}

function sourceFlag(name) {
  // Значение name не приходит извне: только константы ниже.
  return `EXISTS (SELECT 1 FROM jsonb_array_elements(a.ai_facts_json->'facts') f WHERE f->>'source' ${name})`;
}

/**
 * Метаданные не более пяти свежих кандидатов, с приоритетом разных вердиктов.
 * Без заголовков сделок, телефонов, текстов коммуникаций и фактов.
 */
export async function listPilotCandidates(pool, { limit = 5 } = {}) {
  if (!Number.isInteger(limit) || limit < 3 || limit > 5) throw new TypeError('Лимит — от трёх до пяти');
  return readOnlySnapshot(pool, async (connection, hasOperationColumn) => {
    const result = await connection.query(`WITH latest AS (
        SELECT DISTINCT ON (a.deal_id) a.deal_id, a.id::text AS analysis_id, a.processed_at,
          a.prompt_version, a.judge_model, a.ai_verdict, COALESCE(a.ai_reason_class,a.ai_closure_reason_class) AS ai_reason_class,
          d.lose_date, d.stage_id,
          ${sourceFlag("IN ('call_transcript','call_event')")} AS has_call_facts,
          ${sourceFlag("= 'chat'")} AS has_chat_facts,
          ${sourceFlag("= 'chat_voice_transcript'")} AS has_voice_facts,
          ${sourceFlag("= 'screenshot_chat'")} AS has_screenshot_facts
        FROM public.lost_deal_analyses a JOIN public.lost_deals d ON d.deal_id=a.deal_id
        WHERE a.pipeline_error IS NULL AND a.ai_verdict IN ('правомерен','неправомерен','недостаточно_данных')
          AND jsonb_typeof(a.ai_facts_json)='object' AND jsonb_typeof(a.ai_facts_json->'facts')='array'
          AND d.stage_id='C23:LOSE' ${hasOperationColumn ? 'AND a.pipeline_operation_id IS NULL' : ''}
        ORDER BY a.deal_id, a.processed_at DESC, a.id DESC
      ), ordered AS (
        SELECT *, CASE WHEN ai_verdict='неправомерен' THEN 1
          WHEN ai_verdict='правомерен' AND ai_reason_class='price' THEN 2
          WHEN ai_verdict='недостаточно_данных' THEN 3 ELSE 4 END AS bucket
        FROM latest
      ), ranked AS (
        SELECT *, row_number() OVER (PARTITION BY bucket ORDER BY processed_at DESC, analysis_id::bigint DESC) AS position
        FROM ordered
      ) SELECT deal_id, analysis_id, processed_at, prompt_version, judge_model, ai_verdict, ai_reason_class,
          lose_date, stage_id, has_call_facts, has_chat_facts, has_voice_facts, has_screenshot_facts
        FROM ranked ORDER BY position, bucket, processed_at DESC, analysis_id::bigint DESC LIMIT $1`, [limit]);
    if (!Array.isArray(result.rows) || result.rows.length > limit) throw new Error('Некорректная выборка');
    const rows = result.rows.map(row => normalizeRow(row, false));
    if (new Set(rows.map(row => row.deal_id)).size !== rows.length) throw new Error('Повтор сделки');
    return rows;
  });
}

/** Возвращает эталоны и настройки ожидания только для явно выбранных ID. */
export async function loadPilotBaselines(pool, { dealIds } = {}) {
  const ids = parseDealIds(dealIds);
  return readOnlySnapshot(pool, async (connection, hasOperationColumn) => {
    const config = await connection.query('SELECT enabled_at FROM public.lost_audio_wait_config WHERE id=true');
    if (config.rows?.length !== 1) throw new Error('Дата включения аудио не подтверждена');
    const enabledAt = iso(config.rows[0].enabled_at);
    const result = await connection.query(`SELECT DISTINCT ON (a.deal_id)
        a.deal_id, a.id::text AS analysis_id, a.processed_at, a.prompt_version, a.judge_model,
        a.ai_verdict, COALESCE(a.ai_reason_class,a.ai_closure_reason_class) AS ai_reason_class,
        a.ai_facts_json, a.ai_judge_json, d.lose_date, d.stage_id
      FROM public.lost_deal_analyses a JOIN public.lost_deals d ON d.deal_id=a.deal_id
      WHERE a.deal_id=ANY($1::integer[]) AND a.pipeline_error IS NULL
        AND a.ai_verdict IN ('правомерен','неправомерен','недостаточно_данных')
        AND jsonb_typeof(a.ai_facts_json)='object' AND jsonb_typeof(a.ai_facts_json->'facts')='array'
        ${hasOperationColumn ? 'AND a.pipeline_operation_id IS NULL' : ''}
      ORDER BY a.deal_id, a.processed_at DESC, a.id DESC`, [ids]);
    if (!Array.isArray(result.rows) || result.rows.length !== ids.length) throw new Error('Не все эталоны найдены');
    const rows = result.rows.map(row => normalizeRow(row, true));
    const byId = new Map(rows.map(row => [row.deal_id, row]));
    if (byId.size !== ids.length || ids.some(id => !byId.has(id))) throw new Error('Неполная выборка эталонов');
    const wait = await connection.query('SELECT * FROM public.lost_audio_wait WHERE deal_id=ANY($1::bigint[])', [ids]);
    if (!Array.isArray(wait.rows) || wait.rows.length > ids.length) throw new Error('Некорректная очередь аудио');
    const waitingById = new Map();
    for (const row of wait.rows) {
      const id = Number(row.deal_id);
      if (!ids.includes(id) || waitingById.has(id)) throw new Error('Некорректная очередь аудио');
      waitingById.set(id, row);
    }
    return { audio_wait_enabled_at: enabledAt,
      baselines: ids.map(id => ({ ...byId.get(id), saved_audio_wait: waitingById.get(id) ?? null })) };
  });
}
