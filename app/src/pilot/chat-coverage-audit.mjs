// Только ограниченный read-only аудит видимых сессий. Не подключён к очереди,
// доставке и сбору доказательств; текущая CRM-привязка не подтверждает прошлую.
import { isDeepStrictEqual } from 'node:util';
import { exactMillisTimestamp } from '../time-precision.mjs';

const PAGE_SIZE = 200;
const MAX_PAGES = 20;
const MAX_CHATS = 20;
const MAX_ACTIVITIES = 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const KNOWN_CRM_TYPES = new Set(['deal', 'lead', 'contact', 'company']);
const id = value => {
  const text = String(value ?? '');
  return /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
};
const time = value => exactMillisTimestamp(value)?.getTime() ?? null;
const fail = reason => ({ status: 'unverified', history_coverage: 'unverified', reason });

/**
 * Входные chatId/lineId получаются доверенным вызывающим из доступного списка
 * чатов сделки и их историй. Этот модуль не устанавливает их принадлежность,
 * не загружает историю сообщений и не выдаёт идентификаторы сторонних сессий.
 * Повторный одинаковый снимок снижает риск сдвига offset, но не доказывает
 * полноту выдачи, права доступа или историческую связь с CRM.
 */
export async function auditChatCoverage({ client, dealId, chats, activitySessionIds = [], from, cutoff,
  maxPages = MAX_PAGES, signal } = {}) {
  const deal = id(dealId), first = time(from), last = time(cutoff);
  if (!client || typeof client.request !== 'function' || !deal || first === null || last === null
      || first > last || last - first > MAX_WINDOW_MS || !Array.isArray(chats) || chats.length > MAX_CHATS
      || !Array.isArray(activitySessionIds) || activitySessionIds.length > MAX_ACTIVITIES
      || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES
      || (signal != null && typeof signal.throwIfAborted !== 'function')) return fail('invalid_input');

  const targets = new Map(), lines = new Set(), activities = new Set();
  for (const item of chats) {
    const chat = id(item?.chatId), line = id(item?.lineId);
    if (!chat || !line || targets.has(chat)) return fail('invalid_input');
    targets.set(chat, line); lines.add(line);
  }
  for (const value of activitySessionIds) {
    const session = id(value);
    if (!session || activities.has(session)) return fail('invalid_input');
    activities.add(session);
  }

  const start = new Date(first).toISOString(), end = new Date(last).toISOString();
  async function scan(line) {
    const rows = [], seen = new Set(); let previous = null;
    for (let page = 0; page < maxPages; page++) {
      signal?.throwIfAborted();
      const response = await client.request('imopenlines.v2.Session.list', {
        configId: Number(line), dateCreateFrom: start, dateCreateTo: end,
        limit: PAGE_SIZE, offset: page * PAGE_SIZE, order: 'dateCreate', orderDirection: 'desc',
      }, signal ? { signal } : undefined);
      signal?.throwIfAborted();
      const pageRows = response?.result?.sessions, more = response?.result?.hasNextPage;
      if (!Array.isArray(pageRows) || pageRows.length > PAGE_SIZE || typeof more !== 'boolean'
          || (more && pageRows.length !== PAGE_SIZE) || (page > 0 && pageRows.length === 0)) return { error: 'invalid_page' };
      for (const [position, raw] of pageRows.entries()) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_row' };
        const session = id(raw.id), rowLine = id(raw.configId), created = time(raw.dateCreate);
        if (!session || rowLine !== line || created === null || created < first || created > last
            || (previous !== null && created > previous)) return { error: 'invalid_row' };
        if (seen.has(session)) return { error: 'duplicate_session' };
        // При равном времени на границе offset может скрыть строку, даже если
        // два чтения показали одинаковый набор.
        if (page > 0 && position === 0 && created === previous) return { error: 'unstable_page_boundary' };
        const chat = id(raw.chatId), crmId = id(raw.crmEntityId);
        const crmType = typeof raw.crmEntityType === 'string' && /^[A-Za-z_]{1,64}$/.test(raw.crmEntityType)
          ? raw.crmEntityType.toLowerCase() : null;
        const hasClose = raw.dateClose !== undefined && raw.dateClose !== null && raw.dateClose !== '';
        const closed = hasClose ? time(raw.dateClose) : null;
        if (hasClose && (closed === null || closed < created)) return { error: 'invalid_row' };
        rows.push({ session, line, created, chat, crmId, crmType, closed });
        seen.add(session); previous = created;
      }
      if (!more) return { rows, pages: page + 1 };
    }
    return { error: 'pagination_incomplete' };
  }

  try {
    const results = new Map(), globalSessions = new Set();
    for (const line of lines) {
      const firstPass = await scan(line);
      if (firstPass.error) return fail(firstPass.error);
      const secondPass = await scan(line);
      if (secondPass.error) return fail(secondPass.error);
      if (!isDeepStrictEqual(firstPass, secondPass)) return fail('unstable_snapshot');
      for (const row of firstPass.rows) {
        if (globalSessions.has(row.session)) return fail('duplicate_session');
        globalSessions.add(row.session);
      }
      results.set(line, firstPass);
    }
    const matchedActivities = new Set();
    const outChats = [...targets].map(([chat, line]) => {
      const group = results.get(line).rows.filter(row => row.chat === chat);
      const counts = { crm_match: 0, crm_other: 0, crm_unknown: 0, with_activity: 0, without_activity: 0,
        crm_match_without_activity: 0, crm_other_without_activity: 0, crm_unknown_without_activity: 0 };
      for (const row of group) {
        const category = !KNOWN_CRM_TYPES.has(row.crmType) || !row.crmId ? 'crm_unknown'
          : row.crmType === 'deal' && row.crmId === deal ? 'crm_match' : 'crm_other';
        counts[category]++;
        if (activities.has(row.session)) { counts.with_activity++; matchedActivities.add(row.session); }
        else { counts.without_activity++; counts[`${category}_without_activity`]++; }
      }
      return { chat_id: chat, line_id: line, visible_sessions: group.length, ...counts };
    });
    const outLines = [...results].map(([line, result]) => ({ line_id: line, pages_per_scan: result.pages,
      // Неизвестный chatId может относиться к сделке, поэтому он виден отдельно.
      sessions_with_unknown_chat: result.rows.filter(row => !row.chat).length }));
    return { status: 'audited', history_coverage: 'unverified', scope: { from: start, cutoff: end },
      lines: outLines, chats: outChats, activities_not_seen_in_known_chats: activities.size - matchedActivities.size,
      limitations: ['current_binding_not_historical_proof', 'bounded_window', 'unknown_prior_lines',
        'permissions_may_hide_sessions', 'matching_snapshots_do_not_prove_completeness'] };
  } catch {
    return fail(signal?.aborted ? 'cancelled' : 'request_unavailable');
  }
}
