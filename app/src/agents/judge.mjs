const PROOF_SOURCES = ['call_transcript', 'chat', 'chat_voice_transcript', 'screenshot_chat'];
const VERDICTS = ['правомерен', 'неправомерен', 'недостаточно_данных'];
const PROOF_TYPES = ['client_statement', 'manager_statement', 'crm_comment', 'metric', 'absence'];
const CLOSURE_CLASSES = ['price', 'competitor', 'no_need', 'no_money', 'timing', 'manager_dropped', 'customer_unreachable', 'regulatory', 'other'];

function parseContent(content) {
  try {
    return { judge: JSON.parse(content.trim()), method: 'direct' };
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return { judge: JSON.parse(match[0]), method: 'regex' };
    } catch {
      return null;
    }
  }
}

// Схема используется в запросе Judge. Дополнительная проверка нужна, если провайдер
// ответил ошибкой или проигнорировал response_format.
function validJudge(judge) {
  if (!judge || typeof judge !== 'object' || Array.isArray(judge)) return false;
  if (!VERDICTS.includes(judge.verdict)) return false;
  if (typeof judge.verdict_reason_short !== 'string' || typeof judge.exact_reason !== 'string') return false;
  if (!CLOSURE_CLASSES.includes(judge.closure_reason_class) || typeof judge.misplaced !== 'boolean') return false;
  if (judge.recoverable_level !== undefined && ![null, 'высокий', 'средний', 'низкий'].includes(judge.recoverable_level)) return false;
  if (judge.correct_stage != null && typeof judge.correct_stage !== 'string') return false;
  if (judge.questions_for_manager !== undefined
    && (!Array.isArray(judge.questions_for_manager) || !judge.questions_for_manager.every((q) => typeof q === 'string'))) return false;
  for (const field of ['manager_mistakes', 'key_signals', 'risk_factors']) {
    if (!Array.isArray(judge[field])) return false;
    for (const item of judge[field]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      if (!PROOF_TYPES.includes(item.proof_type)) return false;
      if (!Array.isArray(item.proof_fact_ids) || !item.proof_fact_ids.every((id) => typeof id === 'string')) return false;
      const textField = { manager_mistakes: 'mistake', key_signals: 'signal', risk_factors: 'factor' }[field];
      if (typeof item[textField] !== 'string') return false;
    }
  }
  return true;
}

function validateProofs(judge, facts, metrics) {
  const byId = new Map(facts.map((fact) => [fact.fact_id, fact]));
  const warnings = [];
  let errorCount = 0;
  for (const category of ['manager_mistakes', 'key_signals', 'risk_factors']) {
    judge[category].forEach((item, index) => {
      for (const id of item.proof_fact_ids) {
        const path = `${category}[${index}]`;
        let issue;
        let severity = 'error';
        if (id.startsWith('metric:')) {
          const name = id.slice(7);
          if (metrics[name] === undefined) issue = `metric ${name} не существует`;
        } else {
          const fact = byId.get(id);
          if (!fact) {
            issue = `fact_id ${id} не существует`;
          } else if (['client_statement', 'manager_statement'].includes(item.proof_type)
            && fact.actor === 'unknown' && PROOF_SOURCES.includes(fact.source)) {
            severity = 'warning';
            issue = `proof_type=${item.proof_type}, а ${id} — запись без разделения сторон (actor=unknown), слова нельзя приписать ни клиенту, ни менеджеру`;
          } else if (item.proof_type === 'client_statement'
            && (fact.actor !== 'client' || !PROOF_SOURCES.includes(fact.source))) {
            issue = `proof_type=client_statement, но ${id}.actor=${fact.actor}, source=${fact.source}`;
          } else if (item.proof_type === 'manager_statement'
            && (fact.actor !== 'manager' || !PROOF_SOURCES.includes(fact.source))) {
            issue = `proof_type=manager_statement, но ${id}.actor=${fact.actor}, source=${fact.source}`;
          } else if (item.proof_type === 'crm_comment' && fact.source !== 'crm_comment') {
            issue = `proof_type=crm_comment, но source=${fact.source}`;
          }
        }
        if (issue) {
          warnings.push({ path, issue, severity });
          if (severity === 'error') errorCount++;
        }
      }
    });
  }
  return { warnings, errorCount };
}

export function parseJudgeResponse(response, prepared, writerSystemPrompt, now = Date.now()) {
  const content = response?.choices?.[0]?.message?.content || response?.content;
  if (typeof content !== 'string' || !content.trim()) return { error: true, message: 'Пустой ответ судьи' };
  const parsed = parseContent(content);
  if (!parsed) return { error: true, message: 'Не удалось разобрать JSON судьи' };
  if (!validJudge(parsed.judge)) return { error: true, message: 'Ответ судьи не соответствует схеме' };

  const factsPacket = prepared.facts_packet || {};
  const facts = factsPacket.facts || [];
  const metrics = factsPacket.metrics || {};
  const { warnings, errorCount } = validateProofs(parsed.judge, facts, metrics);
  const cutoff = metrics.cutoff_at ? new Date(metrics.cutoff_at).getTime() : null;
  const daysSinceLose = cutoff !== null && !Number.isNaN(cutoff)
    ? Math.max(0, Math.round((new Date(now).getTime() - cutoff) / 86400000)) : null;
  const lastBeforeLose = typeof metrics.last_contact_days_before_lose === 'number'
    ? metrics.last_contact_days_before_lose : null;
  const daysSinceLastContact = daysSinceLose !== null && lastBeforeLose !== null
    ? daysSinceLose + lastBeforeLose : daysSinceLose;
  const writerInput = {
    deal_card: factsPacket.deal_card,
    facts,
    metrics,
    judge: parsed.judge,
    now: { days_since_lose: daysSinceLose, days_since_last_contact: daysSinceLastContact },
  };
  return {
    deal_id: prepared.deal_id,
    judge: parsed.judge,
    judge_model: response.model || 'openai/gpt-6-sol',
    judge_usage: response.usage || {},
    judge_parse_method: parsed.method,
    proof_warnings: warnings,
    proof_errors_count: errorCount,
    writer_request_body: {
      model: 'openai/gpt-6-sol',
      messages: [
        { role: 'system', content: writerSystemPrompt },
        { role: 'user', content: JSON.stringify(writerInput, null, 2) },
      ],
      provider: { order: ['openai/flex', 'openai'], allow_fallbacks: true },
      reasoning: { effort: 'low' },
      max_tokens: 16000,
      temperature: 0.2,
    },
    facts_packet: factsPacket,
    deal_card: prepared.deal_card,
    communications: prepared.communications,
    journal_text: prepared.journal_text,
    analytics_text: prepared.analytics_text,
    transcription_stats: prepared.transcription_stats,
    _block: 'judge_parsed',
  };
}
