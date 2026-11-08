// Узкая защита от приписывания клиенту отказа, известного только из CRM.
// Наличие другой клиентской реплики НЕ доказывает конкретную причину отказа:
// полную смысловую сверку обоснования этот контроль не заменяет.
const CLIENT_SOURCES = new Set(['call_transcript', 'chat', 'chat_voice_transcript', 'screenshot_chat']);
const CLIENT_REASON_CLASSES = new Set(['price', 'competitor', 'no_need', 'no_money', 'timing']);
// Само по себе приветствие не подтверждает решение об отказе. Список намеренно
// узкий: любые дополнительные слова оставляются судье, включая короткое «нет».
const GREETING_ONLY = /^\s*(?:здравствуйте|здравствуй|привет|добрый\s+день|добрый\s+вечер|доброе\s+утро|алло)[\s.!?,…]*$/iu;
const FACTORY_SOURCES = new Set(['crm_comment', 'call_transcript', 'chat', 'chat_voice_transcript', 'screenshot_chat']);
const FACTORY_CLAIM = /(?:техническ[^.!?;\n]{0,25}(?:отказ|невозмож)|(?:завод|производств|цех|монтажник)[^.!?;\n]{0,45}(?:отказ|не\s+(?:производ|изготов|может|бер)|невозмож)|отказ[^.!?;\n]{0,30}(?:завод|производств|цех|монтажник))/iu;
const FACTORY_SUPPORT = /(?:технически\s+(?:не\s*возможно|невозможно)|техническ[^.!?;\n]{0,25}невозмож|не\s+(?:производим|изготавливаем|делаем\s+такое)|не\s+наш\s+профиль|не\s+попадает\s+в\s+производство|не\s+та\s+серия|регион\s+не\s+обслуживаем|засыпной\s+дом|деревянный\s+сруб|плохие\s+перекрытия|(?:завод[ауыом]*|производств[ауыом]*|цех[ауыом]*|монтажник[аыов]*)\s+(?:(?:нам|официально|технически|сам|само)\s+){0,2}(?:отказ|не\s+(?:производ|изготов|может|бер)|невозмож)|отказ(?:а|у|ом|е|ы|ов|ам|ами|ах)?\s+(?:завод[ауыом]*|производств[ауыом]*|цех[ауыом]*|монтажник[аыов]*))/iu;
const FACTORY_NEGATION = /(?:(?:завод|производств|цех|монтажник)[^.!?;\n]{0,30}не\s+отказ|отказ[^.!?;\n]{0,40}не\s+(?:было|поступал|последовал|подтвержд|зафиксирован)|(?:нет|отсутствует)\s+(?:технического\s+)?отказ|не\s+(?:засыпной\s+дом|деревянный\s+сруб|плохие\s+перекрытия))/iu;

// Ловим только прямые формулировки. Не пытаемся считать каждое упоминание CRM
// утверждением клиента: «менеджер указал ..., подтверждения нет» допустимо.
const DIRECT_CLIENT_DECISION = /(?:^|[^\p{L}])клиент(?:ка|ки|ке|ку|ом|а|у|ы)?\s+(?:(?:сам(?:а)?|лично|прямо|уже|окончательно)\s+){0,3}(?:отказал(?:ся|ась|ись)|передумал(?:а|и)?|купил(?:а|и)?|заказал(?:а|и)?|выбрал(?:а|и)?|отменил(?:а|и)?)(?:$|[^\p{L}])/iu;
const REPORTED_CLIENT_DECISION = /(?:^|[^\p{L}])клиент(?:ка|ки|ке|ку|ом|а|у|ы)?\s+(?:(?:сам(?:а)?|лично|прямо|уже|окончательно)\s+){0,3}(?:сообщил(?:а|и)?|написал(?:а|и)?|сказал(?:а|и)?|заявил(?:а|и)?|подтвердил(?:а|и)?)[^.!?;\n]{0,70}(?:отказал(?:ся|ась|ись)|передумал(?:а|и)?|купил(?:а|и)?|заказал(?:а|и)?|выбрал(?:а|и)?|отменил(?:а|и)?|не\s+актуальн|не\s+нужн)/iu;
function assertsDecision(value) {
  if (typeof value !== 'string') return false;
  const matches = [DIRECT_CLIENT_DECISION, REPORTED_CLIENT_DECISION]
    .flatMap(pattern => [...value.matchAll(new RegExp(pattern.source, 'giu'))]);
  for (const match of matches) {
    const before = value.slice(Math.max(0, match.index - 120), match.index).split(/[.!?;\n]|,\s*но(?:\s+|$)/iu).at(-1);
    // Указание на источник или прямое отрицание доказанности не является
    // утверждением, что клиент действительно произнёс эти слова.
    if (/(?:менеджер|комментар(?:ий|ии|ия)|\bcrm\b)[^.!?\n]{0,65}(?:указал|написал|отметил|сообщил|утверждает|зафиксировал)/iu.test(before)
        || /(?:(?:нет|отсутствует|не получено|не найдено)\s+(?:(?:прямого|достоверного|какого-либо)\s+)?(?:подтверждения|доказательств(?:а)?|сведений|фактов)|нельзя утверждать|не подтверждено|не доказано)[^.!?;\n]{0,70}$/iu.test(before)) continue;
    return true;
  }
  return false;
}

/**
 * Проверяется только очевидная ситуация с CRM-комментарием без клиентских
 * слов или только с приветствием. Это не проверка смысла иных реплик клиента.
 * Технический отказ завода остаётся на оценку судьи по подтверждающим фактам;
 * поле причины само по себе ничего не доказывает.
 */
export function managerCommentGuard(judge, facts) {
  if (!judge || typeof judge !== 'object' || !Array.isArray(facts)) return { block: false };
  const hasComment = facts.some(f => f?.source === 'crm_comment' && typeof f.content === 'string' && f.content.trim());
  if (!hasComment) return { block: false };
  const hasClientWords = facts.some(f => f?.actor === 'client' && CLIENT_SOURCES.has(f.source)
    && typeof f.content === 'string' && !!f.content.trim() && !GREETING_ONLY.test(f.content));
  const claimsFactory = judge.verdict === 'правомерен' && [judge.verdict_reason_short, judge.exact_reason]
    .some(value => typeof value === 'string' && FACTORY_CLAIM.test(value));
  const factorySupport = facts.some(f => FACTORY_SOURCES.has(f?.source)
    && typeof f.content === 'string' && (f.content.match(/[^.!?;\n]+[.!?;]?/gu) || [])
      .some(sentence => !sentence.trimEnd().endsWith('?')
        && FACTORY_SUPPORT.test(sentence) && !FACTORY_NEGATION.test(sentence)));
  // Это только предварительный фильтр на наличие подходящего факта, а не
  // доказательство того, что распознанная формулировка действительно отказ.
  if (claimsFactory && !factorySupport) return { block: true, reason: 'factory_refusal_without_fact' };
  if (hasClientWords) return { block: false };
  const clientReason = judge.verdict === 'правомерен' && CLIENT_REASON_CLASSES.has(judge.closure_reason_class);
  const assertedDecision = [judge.verdict_reason_short, judge.exact_reason].some(assertsDecision);
  if (clientReason || assertedDecision) return { block: true, reason: 'client_refusal_without_client_words' };
  return { block: false };
}
