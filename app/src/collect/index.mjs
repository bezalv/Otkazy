import { exactMillisTimestamp } from '../time-precision.mjs';
import { getRoleSessionContextScope } from '../worker/role-session-context.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

const SOURCE_LABELS = {
  calls: 'звонки',
  openlines: 'открытые линии',
  comments: 'комментарии',
  tasks: 'задачи',
};

// Подтверждаем ID и сопоставляем только содержимое, используемое при разборе.
// Прочие поля chat могут меняться между последовательными чтениями.
function openlineId(value) {
  const text = String(value ?? '');
  return /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
}
function sameOpenlineHistory(first, second, chatId) {
  const sameField = key => isDeepStrictEqual(first?.[key], second?.[key]);
  return ['message', 'users', 'files'].every(sameField)
    && isDeepStrictEqual(first?.chat?.[chatId]?.entityId, second?.chat?.[chatId]?.entityId);
}

const STAGE_NAMES = {
  'C23:NEW': 'Технический этап',
  'C23:PREPARATION': 'Предварительный расчет стоимости',
  'C23:PREPAYMENT_INVOIC': 'Замер',
  'C23:EXECUTING': 'Расчет стоимости',
  'C23:FINAL_INVOICE': 'Презентация и согласование КП',
  'C23:UC_GDK5HI': 'Подписание договора и оплата',
  'C23:UC_F0XO84': 'Приостановленные',
  'C23:WON': 'Сделка успешна',
  'C23:LOSE': 'Отказ',
};

const PAUSE_REASONS = {
  2989: 'Думает', 2991: 'В отпуске', 2993: 'После праздников',
  2995: 'Нет бюджета', 3161: 'Ждем данные для расчета',
  3163: 'Сдвиг срока строительства', 3189: 'Нет строителэной готовности',
  3277: 'Не удобно разговаривать, позже', 3283: 'Не берет трубку',
};

const SKIP_REASONS = {
  3297: 'дубль',
  3131: 'дополнительный контакт',
};

const CALL_FIELDS = [
  'ID', 'SUBJECT', 'CREATED', 'START_TIME', 'END_TIME', 'DIRECTION',
  'RESPONSIBLE_ID', 'DESCRIPTION', 'SETTINGS', 'PROVIDER_ID',
  'PROVIDER_TYPE_ID', 'COMPLETED', 'FILES', 'COMMUNICATIONS',
];

const TASK_FIELDS = [
  'ID', 'TITLE', 'DESCRIPTION', 'STATUS', 'CREATED_DATE', 'CLOSED_DATE',
  'RESPONSIBLE_ID', 'CREATED_BY',
];

const defaultWait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function safeError(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return `HTTP ${status}`;
  }
  return 'ошибка запроса к Битриксу';
}

async function request(client, method, body, wait, onAttempts = () => {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      onAttempts(attempt);
      const response = await client.request(method, body);
      if (!response || typeof response !== 'object' || response.error || !('result' in response)) {
        throw new Error('Некорректный ответ Битрикса');
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await wait(attempt * 2000);
    }
  }
  throw lastError;
}

async function list(client, method, body, itemsOf, wait, onAttempts, { strictHistory = false } = {}) {
  const items = [];
  const seen = new Set();
  let start = 0;
  let historyTotal = null;
  while (true) {
    if (seen.has(String(start))) throw new Error('Повтор курсора Битрикса');
    seen.add(String(start));
    const response = await request(client, method, { ...body, start }, wait, onAttempts);
    const page = itemsOf(response.result);
    if (!Array.isArray(page)) throw new Error('Некорректная страница Битрикса');
    if (strictHistory) {
      if (page.length > 50) throw new Error('Некорректная страница истории');
      if (response.total !== undefined && response.total !== null) {
        const total = Number(response.total);
        if (!Number.isSafeInteger(total) || total < 0 || start + page.length > total) throw new Error('Некорректный размер истории');
        if (historyTotal !== null && historyTotal !== total) throw new Error('Размер истории изменился');
        historyTotal = total;
        if ((response.next === undefined || response.next === null || response.next === false) && start + page.length !== total) throw new Error('История стадий неполная');
        if (response.next !== undefined && response.next !== null && response.next !== false && start + page.length >= total) throw new Error('Пагинация истории противоречит размеру');
      } else if (page.length === 50 && (response.next === undefined || response.next === null || response.next === false)) {
        throw new Error('Полнота истории стадий не подтверждена');
      }
      if (historyTotal !== null && (response.next === undefined || response.next === null || response.next === false)
        && start + page.length !== historyTotal) throw new Error('История стадий неполная');
      if (response.next !== undefined && response.next !== null && response.next !== false
        && (!page.length || Number(response.next) !== start + page.length)) throw new Error('Некорректный переход страницы истории');
    }
    items.push(...page);
    if (response.next === undefined || response.next === null || response.next === false) {
      return items;
    }
    if (!Number.isSafeInteger(Number(response.next)) || Number(response.next) < 0) {
      throw new Error('Некорректный курсор Битрикса');
    }
    start = Number(response.next);
  }
}

// История события должна быть полной и отсортированной. ID не используется
// для разрешения совпадающих дат: Bitrix не гарантирует такой порядок.
function validateEventHistory(history) {
  if (!Array.isArray(history) || !history.length) throw new Error('Пустая история стадий');
  const ids = new Set();
  let previous = Infinity;
  let latest = null;
  for (const [index, event] of history.entries()) {
    const id = String(event?.ID ?? '');
    const parsed = exactMillisTimestamp(event?.CREATED_TIME);
    if (!/^[1-9]\d{0,29}$/.test(id) || ids.has(id) || typeof event?.STAGE_ID !== 'string' || !event.STAGE_ID || !parsed) {
      throw new Error('Некорректная запись истории стадий');
    }
    const time = parsed.getTime();
    if (!Number.isFinite(time) || time > previous || (index === 1 && time === latest)) throw new Error('Неоднозначный порядок истории стадий');
    ids.add(id);
    if (index === 0) latest = time;
    previous = time;
  }
  if (history[0].STAGE_ID !== 'C23:LOSE') throw new Error('История стадий ещё не подтверждает текущий отказ');
}

/** Достоверный текущий переход для повтора, до любой платной обработки. */
export async function resolveCurrentTransition({ client, dealId, loseDate, wait = defaultWait }) {
  const id = Number(dealId);
  const expected = exactMillisTimestamp(loseDate instanceof Date ? loseDate.toISOString() : loseDate);
  if (!client || typeof client.request !== 'function' || !Number.isSafeInteger(id) || id <= 0 || !expected) {
    throw new TypeError('Не заданы данные для проверки перехода');
  }
  const deal = await request(client, 'crm.deal.get', { id }, wait);
  if (!deal.result || typeof deal.result !== 'object' || Array.isArray(deal.result)
      || typeof deal.result.STAGE_ID !== 'string' || !deal.result.STAGE_ID) throw new Error('Некорректная стадия сделки');
  if (deal.result.STAGE_ID !== 'C23:LOSE') return { status: 'obsolete' };
  const history = await list(client, 'crm.stagehistory.list', {
    entityTypeId: 2, filter: { OWNER_ID: id }, order: { CREATED_TIME: 'DESC' },
    select: ['ID', 'STAGE_ID', 'CREATED_TIME', 'CATEGORY_ID'],
  }, page => Array.isArray(page) ? page : page?.items, wait, undefined, { strictHistory: true });
  validateEventHistory(history);
  const current = exactMillisTimestamp(history[0].CREATED_TIME);
  if (current.getTime() > expected.getTime()) return { status: 'obsolete' };
  if (current.getTime() !== expected.getTime()) throw new Error('История не подтверждает дату отказа');
  return { status: 'current', stageHistoryId: String(history[0].ID) };
}

function skipReason(id, text) {
  const key = String(id ?? '').trim();
  const byId = Object.hasOwn(SKIP_REASONS, key) ? SKIP_REASONS[key] : null;
  if (byId) return byId;
  const normalized = String(text ?? '').trim().toLowerCase();
  return Object.values(SKIP_REASONS).includes(normalized) ? normalized : null;
}

function hasHistoryMessages(result) {
  return result && typeof result === 'object' &&
    result.message !== null && typeof result.message === 'object';
}

function mapDeal(deal, reasons, history, now) {
  const deferred = deal.UF_CRM_67EB5BE405D11 || null;
  let loseDate = null;
  let pauseDate = null;
  let previousStageId = null;
  let loseSeen = false;
  for (const event of history) {
    const stage = event?.STAGE_ID;
    if (stage === 'C23:LOSE') {
      if (!loseDate) loseDate = event.CREATED_TIME;
      loseSeen = true;
      continue;
    }
    if (stage === 'C23:UC_F0XO84' && !pauseDate) pauseDate = event.CREATED_TIME;
    if (loseSeen && !previousStageId && stage) previousStageId = stage;
  }

  return {
    deal_id: deal.ID,
    title: deal.TITLE,
    assigned_by_id: deal.ASSIGNED_BY_ID,
    stage_id: deal.STAGE_ID,
    stage_name: STAGE_NAMES[deal.STAGE_ID] || deal.STAGE_ID,
    category_id: deal.CATEGORY_ID,
    opportunity: deal.OPPORTUNITY,
    currency: deal.CURRENCY_ID,
    date_create: deal.DATE_CREATE,
    date_modify: deal.DATE_MODIFY,
    pause_reason_id: deal.UF_CRM_67EB5BE54B439 || null,
    pause_reason: PAUSE_REASONS[deal.UF_CRM_67EB5BE54B439] || 'Не указана',
    deferred_until: deferred,
    days_until_deferred: deferred ? Math.ceil((new Date(deferred).getTime() - now) / 86400000) : null,
    pause_flag: deal.UF_CRM_67EB5BE689486,
    department: deal.UF_CRM_67EB6B894AB19 || null,
    product_type: deal.UF_CRM_1584702679332 || [],
    client_type: deal.UF_CRM_5E7D8119011E5 || null,
    source: deal.SOURCE_ID || null,
    source_description: deal.SOURCE_DESCRIPTION || null,
    utm_source: deal.UTM_SOURCE || null,
    utm_medium: deal.UTM_MEDIUM || null,
    utm_campaign: deal.UTM_CAMPAIGN || null,
    contact_id: deal.CONTACT_ID || null,
    company_id: deal.COMPANY_ID || null,
    lose_reason_id: deal.UF_CRM_1584703948317 || null,
    lose_reason: reasons[String(deal.UF_CRM_1584703948317)] || '',
    lead_id: deal.LEAD_ID ? Number(deal.LEAD_ID) : null,
    previous_stage_id: previousStageId,
    previous_stage_name: previousStageId ? (STAGE_NAMES[previousStageId] || previousStageId) : null,
    pause_date: pauseDate,
    stage_history_count: history.length,
    lose_date: loseDate,
    days_in_lost: loseDate ? Math.floor((now - new Date(loseDate).getTime()) / 86400000) : null,
  };
}

/** Собирает первичные данные. Нормализация чатов и распознавание выполняются отдельно. */
export async function collectDeal({ client, dealId, silent = false, now = Date.now(), wait = defaultWait, expectedHistoryId = null, expectedLoseDate = null, requireCurrentHistory = false, verifyLatestSession, roleSessionContext }) {
  if (!client || typeof client.request !== 'function') throw new TypeError('Нужен client.request');
  const id = Number(dealId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('Некорректный ID сделки');
  if (expectedHistoryId !== null && (typeof expectedHistoryId !== 'string' || !/^[1-9]\d{0,29}$/.test(expectedHistoryId))) throw new TypeError('Некорректный ID перехода');
  const roleScope = getRoleSessionContextScope(roleSessionContext);
  const checkedLoseDate = exactMillisTimestamp(expectedLoseDate);
  const trustedRole = roleScope && roleScope.dealId === String(id) && roleScope.stageHistoryId === expectedHistoryId
    && checkedLoseDate && roleScope.cutoff === checkedLoseDate.toISOString() && verifyLatestSession === roleSessionContext.verify;
  if (verifyLatestSession !== undefined && (typeof verifyLatestSession !== 'function' || (silent !== true && !trustedRole)
      || requireCurrentHistory !== true || expectedHistoryId === null || !exactMillisTimestamp(expectedLoseDate))) {
    throw new TypeError('Подтверждение новой сессии доступно только для закреплённого тихого перехода');
  }
  const sources = Object.fromEntries(Object.entries(SOURCE_LABELS).map(([key, label]) => [
    key, { label, complete: false, error: null, attempts: 0 },
  ]));
  // Завершённые вызовы API не доказывают, что обнаружены все прошлые сессии.
  sources.openlines.history_coverage = 'unverified';
  sources.openlines.history_scope = 'activity_and_latest';
  const result = { deal_id: id, silent: silent === true, _sources: sources, ready_for_analysis: false };

  let deal;
  let reasons;
  let history;
  try {
    const response = await request(client, 'crm.deal.userfield.list', {
      filter: { FIELD_NAME: 'UF_CRM_1584703948317' },
    }, wait);
    if (!Array.isArray(response.result) || !Array.isArray(response.result[0]?.LIST)) {
      throw new Error('Некорректный справочник причин');
    }
    reasons = Object.fromEntries(response.result[0].LIST.map(item => [String(item.ID), item.VALUE]));
    const dealResponse = await request(client, 'crm.deal.get', { id }, wait);
    deal = dealResponse.result;
    if (!deal || typeof deal !== 'object' || Array.isArray(deal)) throw new Error('Некорректная сделка');
    if (deal.STAGE_ID !== 'C23:LOSE') {
      return {
        ...result, _status: 'error', _step: 'check_stage',
        _error: 'Not in suspended stage', _reason: 'not_in_lost_stage',
      };
    }
    if (String(deal.ASSIGNED_BY_ID) === '20903') {
      return { ...result, _status: 'skipped', _reason: 'excluded_responsible' };
    }
    history = await list(client, 'crm.stagehistory.list', {
      entityTypeId: 2,
      filter: { OWNER_ID: id },
      order: { CREATED_TIME: 'DESC' },
      select: ['ID', 'STAGE_ID', 'CREATED_TIME', 'CATEGORY_ID'],
    }, page => Array.isArray(page) ? page : page?.items, wait, undefined, { strictHistory: requireCurrentHistory || expectedHistoryId !== null });
    // Карточка и история могут обновляться не одновременно. Старый отказ в
    // истории не доказывает, что новый переход уже записан.
    if (!history.length || history[0]?.STAGE_ID !== 'C23:LOSE' || !history[0]?.CREATED_TIME
      || !Number.isFinite(new Date(history[0].CREATED_TIME).getTime())) {
      throw new Error('История стадий ещё не подтверждает текущий отказ');
    }
    if (requireCurrentHistory || expectedHistoryId !== null) validateEventHistory(history);
    if (expectedHistoryId !== null) {
      const expectedMs = new Date(expectedLoseDate).getTime();
      const actualMs = Date.parse(history[0].CREATED_TIME);
      if (!expectedLoseDate || !Number.isFinite(expectedMs)) throw new Error('Неизвестна дата перехода');
      if (actualMs > expectedMs) return { ...result, _status: 'obsolete_transition' };
      if (actualMs < expectedMs || String(history[0].ID) !== expectedHistoryId) throw new Error('История не подтверждает ожидаемый переход');
    }
  } catch (error) {
    return { ...result, _status: 'error', _step: 'deal_or_history', _error: safeError(error) };
  }

  const dealData = mapDeal(deal, reasons, history, now);
  result.deal_data = dealData;
  result.stage_history = history;
  const reason = skipReason(dealData.lose_reason_id, dealData.lose_reason);
  if (reason) {
    dealData.communications = [];
    dealData.comm_stats = {
      total_events: 0, calls: 0, calls_with_audio: 0, comments: 0, chat_messages: 0,
      chat_messages_raw: 0, tasks: 0, chats_count: 0, screenshots_found: 0,
    };
    return { ...result, _status: 'skipped_by_reason', _skip_reason_key: reason };
  }

  // Для свежего отказа даём Voximplant завершить запись: исходный пакет
  // ждал до пяти минут от перехода, если сделка моложе десяти минут.
  const loseMs = new Date(dealData.lose_date).getTime();
  const age = now - loseMs;
  if (!Number.isFinite(age) || age < -600000) {
    return { ...result, _status: 'error', _step: 'fresh_deal_wait', _error: 'Некорректное время перехода в отказ' };
  }
  const delayMs = age < 600000 ? Math.max(0, 300000 - age) : 0;
  if (delayMs > 0) {
    try {
      await wait(delayMs);
      const current = await request(client, 'crm.deal.get', { id }, wait);
      if (!current.result || typeof current.result.STAGE_ID !== 'string') throw new Error('Неизвестна текущая стадия');
      if (current.result.STAGE_ID !== 'C23:LOSE') {
        return { ...result, _status: 'skipped', _reason: 'not_in_lost_stage' };
      }
      let latest;
      if (requireCurrentHistory || expectedHistoryId !== null) {
        const refreshed = await list(client, 'crm.stagehistory.list', {
          entityTypeId: 2, filter: { OWNER_ID: id }, order: { CREATED_TIME: 'DESC' },
          select: ['ID', 'STAGE_ID', 'CREATED_TIME', 'CATEGORY_ID'],
        }, page => Array.isArray(page) ? page : page?.items, wait, undefined, { strictHistory: true });
        validateEventHistory(refreshed);
        latest = refreshed[0];
      } else {
        const refreshed = await request(client, 'crm.stagehistory.list', {
          entityTypeId: 2, filter: { OWNER_ID: id }, order: { CREATED_TIME: 'DESC' },
          select: ['ID', 'STAGE_ID', 'CREATED_TIME', 'CATEGORY_ID'], start: 0,
        }, wait);
        latest = (Array.isArray(refreshed.result) ? refreshed.result : refreshed.result?.items)?.[0];
      }
      const latestMs = latest?.CREATED_TIME ? new Date(latest.CREATED_TIME).getTime() : NaN;
      if (latest?.STAGE_ID !== 'C23:LOSE' || !Number.isFinite(latestMs) || latestMs < loseMs) {
        throw new Error('История стадий ещё не подтверждает текущий отказ');
      }
      if (latestMs > loseMs) return { ...result, _status: 'obsolete_transition' };
      if ((requireCurrentHistory || expectedHistoryId !== null) && String(latest.ID) !== String(history[0].ID)) throw new Error('История не подтверждает ожидаемый переход');
    } catch (error) {
      return { ...result, _status: 'error', _step: 'fresh_deal_wait', _error: safeError(error) };
    }
  }

  const raw = { calls: [], comments: [], tasks: [], chats: [], openline_activities: [], sessions: [] };
  result.raw = raw;
  async function source(key, action) {
    let attempts = 0;
    const onAttempts = count => { attempts = Math.max(attempts, count); };
    try {
      await action(onAttempts);
      sources[key].complete = true;
      sources[key].attempts = attempts;
    } catch (error) {
      sources[key].error = safeError(error);
      if (key === 'openlines' && error?.code === 'OPENLINES_LATEST_SESSION_UNVERIFIED') {
        sources[key].reason = 'latest_session_link_unverified';
      }
      sources[key].attempts = attempts;
    }
  }
  await source('calls', async onAttempts => {
    raw.calls = await list(client, 'crm.activity.list', {
      filter: { OWNER_TYPE_ID: 2, OWNER_ID: id, TYPE_ID: 2 },
      select: CALL_FIELDS, order: { CREATED: 'ASC' },
    }, page => page, wait, onAttempts);
  });
  await source('comments', async onAttempts => {
    raw.comments = await list(client, 'crm.timeline.comment.list', {
      filter: { ENTITY_ID: id, ENTITY_TYPE: 'deal' },
      select: ['ID', 'CREATED', 'AUTHOR_ID', 'COMMENT', 'FILES'],
    }, page => page, wait, onAttempts);
  });
  await source('openlines', async onAttempts => {
    const chatResponse = await request(client, 'imopenlines.crm.chat.get', {
      CRM_ENTITY_TYPE: 'deal', CRM_ENTITY: id, ACTIVE_ONLY: 'N',
    }, wait, onAttempts);
    if (!Array.isArray(chatResponse.result)) throw new Error('Некорректный список чатов');
    raw.chats = chatResponse.result;
    raw.openline_activities = await list(client, 'crm.activity.list', {
      filter: { OWNER_TYPE_ID: 2, OWNER_ID: id, PROVIDER_ID: 'IMOPENLINES_SESSION' },
      select: ['ID', 'ASSOCIATED_ENTITY_ID'], order: { CREATED: 'ASC' },
    }, page => page, wait, onAttempts);
    const sessionIds = new Set();
    const loadedSessions = new Map();
    const sessionsByChat = new Map();
    async function recoverLatest(chatId, latest) {
      if (typeof verifyLatestSession !== 'function') return false;
      const chat = openlineId(chatId), session = openlineId(latest?.sessionId);
      const cutoff = exactMillisTimestamp(dealData.lose_date), expected = exactMillisTimestamp(expectedLoseDate);
      const entity = chat && latest?.chat?.[chat]?.entityId;
      const parts = typeof entity === 'string' && entity.length <= 1024 ? entity.split('|') : [];
      const line = parts.length === 4 && parts.every(x => x && x.trim() === x) ? openlineId(parts[1]) : null;
      if (!chat || !session || openlineId(latest?.chatId) !== chat || !line || !cutoff || !expected
          || cutoff.getTime() !== expected.getTime() || String(history[0]?.ID) !== expectedHistoryId) return false;
      let serialized, chatSnapshot, stagesSnapshot;
      try {
        serialized = JSON.stringify(latest); chatSnapshot = JSON.stringify(raw.chats); stagesSnapshot = JSON.stringify(history);
        if (typeof serialized !== 'string' || serialized.length > 5_000_000) return false;
      } catch { return false; }
      const hash = createHash('sha256').update(serialized).digest('hex');
      const input = Object.freeze({ deal_id:String(id), chat_id:chat, session_id:session, line_id:line,
        transition_id:expectedHistoryId, cutoff:cutoff.toISOString(), history_sha256:hash, history:JSON.parse(serialized) });
      let proof;
      try { proof = await verifyLatestSession(input); } catch { return false; }
      const proofCutoff = exactMillisTimestamp(proof?.cutoff), created = exactMillisTimestamp(proof?.session_created_at);
      const checks = proof?.checks;
      const keys = ['kind','deal_id','chat_id','session_id','line_id','cutoff','history_sha256','session_created_at','checks'];
      const checkKeys = ['chat_bound_to_deal','session_matches_chat','session_matches_line','session_crm_matches_deal',
        'direct_session_history_matches','current_chat_history_matches'];
      if (!proof || typeof proof !== 'object' || Array.isArray(proof) || Object.keys(proof).length !== keys.length
          || !keys.every(key => Object.hasOwn(proof,key)) || proof.kind !== 'verified_fallback_session_v1'
          || openlineId(proof.deal_id) !== String(id) || openlineId(proof.chat_id) !== chat
          || openlineId(proof.session_id) !== session || openlineId(proof.line_id) !== line
          || !proofCutoff || proofCutoff.getTime() !== cutoff.getTime() || proof.history_sha256 !== hash
          || !created || created.getTime() > cutoff.getTime() || !checks || typeof checks !== 'object'
          || Array.isArray(checks) || Object.keys(checks).length !== checkKeys.length
          || !checkKeys.every(key => checks[key] === true)
          || JSON.stringify(latest) !== serialized || JSON.stringify(input.history) !== serialized
          || JSON.stringify(raw.chats) !== chatSnapshot || JSON.stringify(history) !== stagesSnapshot
          || exactMillisTimestamp(dealData.lose_date)?.getTime() !== cutoff.getTime()
          || String(history[0]?.ID) !== expectedHistoryId) return false;
      // Используем прежний fallback ID сообщения; право на доставку не выдаётся.
      raw.sessions.push({ chat_id:Number(chat), history:latest });
      return true;
    }
    for (const activity of raw.openline_activities) {
      // Без ID нельзя доказать, что в альтернативном списке найден именно этот чат.
      if (!activity.ASSOCIATED_ENTITY_ID) throw new Error('Отсутствует ID сессии открытой линии');
      const sessionId = Number(activity.ASSOCIATED_ENTITY_ID);
      if (!Number.isSafeInteger(sessionId) || sessionId <= 0) throw new Error('Некорректный ID сессии');
      if (sessionIds.has(sessionId)) continue;
      sessionIds.add(sessionId);
      const response = await request(client, 'imopenlines.session.history.get', { SESSION_ID: sessionId }, wait, onAttempts);
      if (!hasHistoryMessages(response.result)) throw new Error('Некорректная история сессии');
      const returnedSessionId = openlineId(response.result.sessionId);
      const returnedChatId = openlineId(response.result.chatId);
      if (returnedSessionId !== String(sessionId) || !returnedChatId) throw new Error('Не подтверждены ID истории сессии');
      const saved = { session_id: sessionId, history: response.result };
      raw.sessions.push(saved);
      loadedSessions.set(returnedSessionId, { chatId: returnedChatId, saved });
      if (!sessionsByChat.has(returnedChatId)) sessionsByChat.set(returnedChatId, new Set());
      sessionsByChat.get(returnedChatId).add(returnedSessionId);
    }
    const checkedChatIds = new Set();
    for (const chat of raw.chats) {
      const chatId = Number(chat.CHAT_ID);
      if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error('Некорректный ID чата');
      if (checkedChatIds.has(String(chatId))) throw new Error('Повтор ID чата открытой линии');
      checkedChatIds.add(String(chatId));
      const response = await request(client, 'imopenlines.session.history.get', { CHAT_ID: chatId }, wait, onAttempts);
      if (!hasHistoryMessages(response.result)) throw new Error('Некорректная история чата');
      const returnedChatId = openlineId(response.result.chatId);
      const returnedSessionId = openlineId(response.result.sessionId);
      if (returnedChatId !== String(chatId) || !returnedSessionId) throw new Error('Не подтверждены ID последней сессии чата');
      const existing = loadedSessions.get(returnedSessionId);
      if (existing) {
        if (existing.chatId !== returnedChatId) throw new Error('Истории одной сессии открытой линии расходятся');
        if (!sameOpenlineHistory(existing.saved.history, response.result, returnedChatId)) {
          // Приход нового сообщения между чтениями не означает повреждение.
          // До двух дополнительных пар; используем только согласованный снимок.
          let stable = false;
          for (let attempt = 0; attempt < 2; attempt++) {
            const bySession = await request(client, 'imopenlines.session.history.get',
              { SESSION_ID: Number(returnedSessionId) }, wait, onAttempts);
            const byChat = await request(client, 'imopenlines.session.history.get', { CHAT_ID: chatId }, wait, onAttempts);
            if (!hasHistoryMessages(bySession.result) || !hasHistoryMessages(byChat.result)
                || openlineId(bySession.result.sessionId) !== returnedSessionId
                || openlineId(bySession.result.chatId) !== returnedChatId
                || openlineId(byChat.result.chatId) !== returnedChatId) {
              throw new Error('Не подтверждены ID повторной истории сессии');
            }
            const latestId = openlineId(byChat.result.sessionId);
            if (!latestId) throw new Error('Не подтверждены ID повторной истории сессии');
            if (latestId !== returnedSessionId) {
              if (sameOpenlineHistory(existing.saved.history, bySession.result, returnedChatId)
                  && await recoverLatest(chatId, byChat.result)) { stable = true; break; }
              const error = new Error('Последняя сессия чата отсутствует в activity: привязка к сделке не подтверждена');
              error.code = 'OPENLINES_LATEST_SESSION_UNVERIFIED';
              throw error;
            }
            if (sameOpenlineHistory(bySession.result, byChat.result, returnedChatId)) {
              existing.saved.history = bySession.result;
              stable = true;
              break;
            }
          }
          if (!stable) throw new Error('Истории одной сессии открытой линии нестабильны');
        }
        continue;
      }
      if (sessionsByChat.has(returnedChatId)) {
        if (await recoverLatest(chatId, response.result)) continue;
        // CHAT_ID возвращает текущую последнюю сессию. Без отдельной сверки
        // её связи со сделкой и отказом нельзя считать её коммуникацией сделки.
        const error = new Error('Последняя сессия чата отсутствует в activity: привязка к сделке не подтверждена');
        error.code = 'OPENLINES_LATEST_SESSION_UNVERIFIED';
        throw error;
      }
      // Сохраняем прежний fallback для чата, для которого activity отсутствует;
      // получение последней сессии не доказывает полноту исторических сессий.
      if (typeof verifyLatestSession === 'function') {
        if (await recoverLatest(chatId, response.result)) continue;
        const error = new Error('Связь последней сессии со сделкой не подтверждена');
        error.code = 'OPENLINES_LATEST_SESSION_UNVERIFIED';
        throw error;
      }
      raw.sessions.push({ chat_id: chatId, history: response.result });
    }
  });
  await source('tasks', async onAttempts => {
    raw.tasks = await list(client, 'tasks.task.list', {
      filter: { UF_CRM_TASK: [`D_${id}`] },
      select: TASK_FIELDS, order: { CREATED_DATE: 'ASC' },
    }, page => page?.tasks, wait, onAttempts);
  });

  const incomplete = Object.values(sources).filter(item => !item.complete);
  if (incomplete.length) {
    result._status = 'error';
    result._step = 'collect_incomplete';
    result._error = `сбор неполный: ${incomplete.map(item => item.label).join(', ')}`;
  } else {
    result._status = 'pending_normalization';
  }
  return result;
}
