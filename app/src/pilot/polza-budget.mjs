// Ограничитель ТОЛЬКО ручных тестов. Не управляет серверным лимитом Polza.
// getUsage и persistState — доверенные адаптеры; последний обязан надёжно
// сохранить переданное состояние до разрешения платного вызова.

const EPSILON = 1e-8;
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const copy = state => Object.freeze({ ...state, outstanding: state.outstanding && Object.freeze({ ...state.outstanding }) });
const cancelled = signal => { signal.throwIfAborted(); };

/**
 * Все суммы — рубли. Счётчик usage принадлежит общему API-ключу. Для
 * безопасности прибавляем стоимость подтверждённых ответов к полному приросту
 * usage от baseline: собственные вызовы могут посчитаться дважды. Это учёт
 * с запасом, а не обещание, что провайдер не спишет больше резерва.
 * priorReservedRub — прежние неподтверждённые резервы, которые оператор
 * уже учёл во внешнем журнале. Это не фактическая стоимость.
 *
 * persistState(snapshot) должен обеспечить долговременную запись без секретов,
 * включая сбои процесса. Сам guard сериализует вызовы только одного экземпляра:
 * вызывающий обязан эксклюзивно занять журнал для всех процессов до создания
 * guard. При восстановлении передайте последний объект persistState в state.
 * Незавершённый резерв невозможно снять этим интерфейсом: его исход
 * нужно сначала установить вне этого объекта, затем начать отдельный бюджет
 * с учётом фактических расходов и согласованного лимита.
 *
 * callback вызывается один раз и получает только signal. Внешний код обязан
 * отключить сетевые повторы и ограничить стоимость одной попытки резервом.
 * runUnpriced — отдельный opt-in только для доверенного адаптера STT, который
 * проверил HTTP 200 и полностью прочитал JSON. Он возвращает строго
 * {http_status: 200, body: {text: 'непустой текст'}}. При таком ответе без
 * цены весь резерв навсегда учитывается как расход лимита, но не как цена.
 * runUnpricedAudio с явным allowEmptyText=true также допускает ровно пустой
 * текст аудиофрагмента; он не доказывает, что в аудио была тишина. Успешный
 * резерв сохраняется с blocked=true: только текущий процесс после успешного
 * persist может продолжить; после перезапуска требуется разбор журнала.
 */
export function createPolzaBudgetGuard({ baselineRub, limitRub = 500, priorReservedRub = 0, getUsage, persistState, signal, state: restored } = {}) {
  if (!money(baselineRub) || !money(limitRub) || limitRub <= 0 || limitRub > 500
      || !money(priorReservedRub) || priorReservedRub > limitRub
      || typeof getUsage !== 'function' || typeof persistState !== 'function'
      || !signal || typeof signal.throwIfAborted !== 'function') throw new TypeError('Некорректная настройка бюджета');
  let ledger = { version: 2, baseline_rub: baselineRub, limit_rub: limitRub,
    max_usage_rub: baselineRub, confirmed_rub: 0, unpriced_reserved_rub: priorReservedRub, outstanding: null, blocked: false };
  if (restored != null) {
    const keys = ['version', 'baseline_rub', 'limit_rub', 'max_usage_rub', 'confirmed_rub', 'outstanding', 'blocked'];
    const v2Keys = [...keys, 'unpriced_reserved_rub'];
    const out = restored?.outstanding;
    const validVersion = restored?.version === 1
      ? Object.keys(restored).length === keys.length && keys.every(k => Object.hasOwn(restored, k))
      : restored?.version === 2 && Object.keys(restored).length === v2Keys.length && v2Keys.every(k => Object.hasOwn(restored, k));
    if (!restored || typeof restored !== 'object' || Array.isArray(restored)
        || !validVersion || restored.baseline_rub !== baselineRub || restored.limit_rub !== limitRub
        || !money(restored.max_usage_rub) || restored.max_usage_rub < baselineRub
        || !money(restored.confirmed_rub) || typeof restored.blocked !== 'boolean'
        || (restored.version === 2 && (!money(restored.unpriced_reserved_rub)
          || restored.unpriced_reserved_rub < priorReservedRub || restored.unpriced_reserved_rub > limitRub))
        || (out !== null && (!out || typeof out !== 'object' || Array.isArray(out)
          || Object.keys(out).length !== 2 || !money(out.reserve_rub) || out.reserve_rub <= 0
          || !money(out.before_usage_rub) || out.before_usage_rub < baselineRub))) {
      throw new TypeError('Некорректный сохранённый бюджет');
    }
    ledger = { ...restored, version: 2,
      unpriced_reserved_rub: restored.version === 2 ? restored.unpriced_reserved_rub : priorReservedRub,
      outstanding: out === null ? null : { ...out }, blocked: restored.blocked || out !== null };
  }
  let busy = false;
  const conservativeSpent = () => Math.max(0, ledger.max_usage_rub - baselineRub) + ledger.confirmed_rub + ledger.unpriced_reserved_rub;
  const snapshot = () => copy({ ...ledger, conservative_spent_rub: conservativeSpent() });
  // В persist передаём только поля состояния, пригодные для восстановления.
  async function persist() { await persistState(copy(ledger)); }
  async function observe() {
    cancelled(signal);
    const usage = await getUsage({ signal });
    cancelled(signal);
    if (!money(usage) || usage + EPSILON < ledger.max_usage_rub) throw new Error('Счётчик Polza не подтверждён');
    ledger.max_usage_rub = Math.max(ledger.max_usage_rub, usage);
  }
  async function perform(reserveRub, callback, unpriced, allowEmptyAudio = false) {
    if (!money(reserveRub) || reserveRub <= 0 || reserveRub > limitRub || typeof callback !== 'function') {
      throw new TypeError('Некорректный резерв');
    }
    if (busy || ledger.blocked || ledger.outstanding) throw new Error('Бюджет занят или исход прошлого вызова не подтверждён');
    busy = true;
    try {
      await observe();
      if (conservativeSpent() + reserveRub > limitRub + EPSILON) throw new Error('Недостаточно бюджета с учётом резерва');
      ledger.outstanding = { reserve_rub: reserveRub, before_usage_rub: ledger.max_usage_rub };
      // До отправки должна быть надёжная запись о возможном списании.
      try { await persist(); } catch { ledger.blocked = true; throw new Error('Резерв не сохранён'); }
      let response;
      try { cancelled(signal); response = await callback({ signal }); cancelled(signal); }
      catch (error) {
        ledger.blocked = true;
        try { await persist(); } catch { /* резерв уже должен быть сохранён */ }
        throw error;
      }
      const cost = response?.usage?.cost_rub;
      const isUnpricedResponse = unpriced === true && response && typeof response === 'object' && !Array.isArray(response)
        && Object.keys(response).length === 2 && Object.hasOwn(response, 'http_status')
        && response.http_status === 200 && Object.hasOwn(response, 'body')
        && response.body && typeof response.body === 'object' && !Array.isArray(response.body)
        && Object.keys(response.body).length === 1 && Object.hasOwn(response.body, 'text') && typeof response.body.text === 'string'
        && response.body.text.length <= 30000
        && (!!response.body.text.trim() || (allowEmptyAudio && response.body.text === ''));
      if (unpriced ? !isUnpricedResponse : !money(cost) || cost > reserveRub + EPSILON) {
        ledger.blocked = true;
        try { await persist(); } catch { /* резерв уже должен быть сохранён */ }
        return { response, settled: false, budget: snapshot() };
      }
      // Не отдаём наружу изменяемый объект адаптера после асинхронной сверки
      // usage и журнала: текст должен оставаться тем, который прошёл проверку.
      if (isUnpricedResponse) response = Object.freeze({ http_status: 200,
        body: Object.freeze({ text: response.body.text }) });
      try {
        await observe();
        if (isUnpricedResponse) ledger.unpriced_reserved_rub += reserveRub;
        else ledger.confirmed_rub += cost;
        ledger.outstanding = null;
        const overLimit = conservativeSpent() > limitRub + EPSILON;
        // При ошибке, произошедшей после фактической записи, нельзя знать,
        // успел ли журнал сохранить новый снимок. Для unpriced итоговый
        // снимок всегда заблокирован; продолжает только текущий процесс,
        // убедившись, что persistState вернулся успешно.
        ledger.blocked = isUnpricedResponse || overLimit;
        await persist();
        if (isUnpricedResponse) {
          cancelled(signal);
          if (!overLimit) ledger.blocked = false;
        }
      } catch {
        // Не освобождать резерв, даже если стоимость уже включена в счётчик.
        ledger.outstanding = { reserve_rub: reserveRub, before_usage_rub: ledger.max_usage_rub };
        ledger.blocked = true;
        try { await persist(); } catch { /* предыдущее состояние хранит резерв */ }
        return { response, settled: false, budget: snapshot() };
      }
      return { response, settled: true, ...(isUnpricedResponse ? { accounted_as: 'unpriced_reserve',
        ...(allowEmptyAudio && response.body.text === '' ? { empty_audio_text: true } : {}) } : {}), budget: snapshot() };
    } finally { busy = false; }
  }
  const run = (reserveRub, callback) => perform(reserveRub, callback, false);
  const runUnpriced = (reserveRub, callback) => perform(reserveRub, callback, true);
  const runUnpricedAudio = (reserveRub, callback, options) => {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).length !== 1 || options.allowEmptyText !== true) {
      throw new TypeError('Для пустого аудио нужно явное разрешение');
    }
    return perform(reserveRub, callback, true, true);
  };
  return Object.freeze({ run, runUnpriced, runUnpricedAudio, snapshot });
}
