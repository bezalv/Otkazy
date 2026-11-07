// Закреплённый повтор без записи в CRM/БД и без уведомлений.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processDeal } from '../process-deal.mjs';
import { runCohortCase } from './cohort20.mjs';
import { sealEvidenceReport } from './evidence-review.mjs';

const ALLOWED = new Map([['127114', '1968'], ['126964', '1986'], ['127132', '1990']]);

function permit(dealId, analysisId) {
  if (typeof dealId !== 'string' || typeof analysisId !== 'string' || ALLOWED.get(dealId) !== analysisId) {
    throw new TypeError('Случай не разрешён');
  }
}

export async function runWazzupRetest({ dealId, analysisId, caseRunner = runCohortCase, processFn = processDeal, ...options } = {}) {
  permit(dealId, analysisId);
  let observed = null, runs = 0;
  const report = await caseRunner({ ...options, dealId, analysisId, async processFn(args) {
    runs++;
    const result = await processFn(args);
    observed = result?.status === 'blocked' && result?.pipelineGate?.kind === 'author_ambiguous' ? 'author_ambiguous' : 'other';
    return result;
  } });
  if (!report || report.service_closed !== true || report.deal_id !== dealId || report.analysis_id !== analysisId || runs > 1) {
    throw new Error('Повтор не подтверждён');
  }
  const blockKind = report.status === 'blocked' && runs === 1 && observed === 'author_ambiguous' ? 'author_ambiguous' : 'other';
  return { report, block_kind: blockKind, service_closed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6 || process.argv[4] !== '--sealed') {
    console.error('Нужен защищённый режим'); process.exitCode = 1;
  } else Promise.resolve().then(() => {
    permit(process.argv[2], process.argv[3]);
    sealEvidenceReport({ service_closed: true }, process.argv[5]);
    return runWazzupRetest({ dealId: process.argv[2], analysisId: process.argv[3] });
  }).then(value => console.log(JSON.stringify(sealEvidenceReport(value, process.argv[5]))))
    .catch(() => { console.error('Проверка не завершена'); process.exitCode = 1; });
}
