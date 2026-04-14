/**
 * Proof Validator — детерминированная проверка пруфов Judge.
 *
 * Проверяет:
 * 1. Каждый proof_fact_id (fXXX) реально существует в facts[]
 * 2. proof_type соответствует source факта
 * 3. metric:* ссылки указывают на существующие поля в metrics
 *
 * Возвращает { valid: bool, issues: string[], stats: {...} }
 */
export function validateProofs(judgeResult, facts, metrics) {
  const issues = [];

  // Индекс фактов по ID
  const factMap = new Map();
  for (const f of facts) {
    factMap.set(f.id, f);
  }

  // Какие proof_type допустимы для каких source
  const typeToSource = {
    client_statement:  ['call_transcript', 'chat'],
    manager_statement: ['call_transcript', 'chat'],
    crm_comment:       ['crm_comment'],
    metric:            [], // проверяется отдельно
    absence:           [], // может ссылаться на любые факты или не ссылаться
  };

  let totalRefs = 0;
  let validRefs = 0;
  let metricRefs = 0;
  let metricValid = 0;

  // Собрать все массивы с пруфами
  const proofArrays = [
    { name: 'manager_mistakes', items: judgeResult.manager_mistakes || [] },
    { name: 'key_signals',      items: judgeResult.key_signals || [] },
    { name: 'risk_factors',     items: judgeResult.risk_factors || [] },
  ];

  for (const { name, items } of proofArrays) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const prefix = `${name}[${i}]`;
      const proofType = item.proof_type;
      const factIds = item.proof_fact_ids || [];

      // Проверить proof_type
      if (!proofType || !typeToSource.hasOwnProperty(proofType)) {
        issues.push(`${prefix}: неизвестный proof_type "${proofType}"`);
      }

      for (const ref of factIds) {
        totalRefs++;

        // metric:* ссылки
        if (typeof ref === 'string' && ref.startsWith('metric:')) {
          metricRefs++;
          const metricName = ref.slice(7);
          if (metrics && metrics.hasOwnProperty(metricName)) {
            metricValid++;
            validRefs++;
          } else {
            issues.push(`${prefix}: metric:"${metricName}" не найдена в metrics`);
          }
          continue;
        }

        // fXXX ссылки
        const fact = factMap.get(ref);
        if (!fact) {
          issues.push(`${prefix}: fact "${ref}" не найден в facts[]`);
          continue;
        }

        validRefs++;

        // Проверить соответствие proof_type и source факта
        if (proofType && proofType !== 'absence' && proofType !== 'metric') {
          const allowedSources = typeToSource[proofType];
          if (allowedSources && allowedSources.length > 0 && !allowedSources.includes(fact.source)) {
            issues.push(
              `${prefix}: proof_type="${proofType}" ожидает source IN [${allowedSources}], но ${ref} имеет source="${fact.source}"`
            );
          }
        }
      }

      // absence без ссылок — нормально, но если proof_type не absence и нет ссылок — подозрительно
      if (factIds.length === 0 && proofType !== 'absence') {
        issues.push(`${prefix}: proof_type="${proofType}", но proof_fact_ids пуст`);
      }
    }
  }

  // Проверки на уровне вердикта
  if (judgeResult.verdict === 'неправомерен') {
    if (!judgeResult.manager_mistakes || judgeResult.manager_mistakes.length === 0) {
      issues.push('verdict="неправомерен", но manager_mistakes пуст');
    }
    if (!judgeResult.recoverable_level) {
      issues.push('verdict="неправомерен", но recoverable_level не указан');
    }
  }

  if (judgeResult.verdict === 'правомерен') {
    if (judgeResult.manager_mistakes && judgeResult.manager_mistakes.length > 0) {
      issues.push('verdict="правомерен", но manager_mistakes не пуст — по промпту должен быть []');
    }
    if (judgeResult.recoverable_level) {
      issues.push('verdict="правомерен", но recoverable_level указан — должен быть null');
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    stats: {
      total_refs: totalRefs,
      valid_refs: validRefs,
      invalid_refs: totalRefs - validRefs,
      metric_refs: metricRefs,
      metric_valid: metricValid,
    },
  };
}
