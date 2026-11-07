import test from 'node:test';
import assert from 'node:assert/strict';
import { runWazzupRetest } from '../../app/src/pilot/wazzup-retest.mjs';

test('фиксированная сделка передаёт только безопасный признак причины блокировки', async () => {
  const result = await runWazzupRetest({ dealId: '127114', analysisId: '1968',
    async processFn() { return { status: 'blocked', pipelineGate: { kind: 'author_ambiguous', pipeline_error: 'СЕКРЕТ' } }; },
    async caseRunner({ processFn, dealId, analysisId }) {
      await processFn({});
      return { status: 'blocked', deal_id: dealId, analysis_id: analysisId, detail: null, service_closed: true };
    },
  });
  assert.equal(result.block_kind, 'author_ambiguous');
  assert.doesNotMatch(JSON.stringify(result), /СЕКРЕТ/);
});

test('при любой другой причине блокировки не заявляем неопределённого автора', async () => {
  const result = await runWazzupRetest({ dealId: '127114', analysisId: '1968',
    async processFn() { return { status: 'blocked', pipelineGate: { kind: 'collect' } }; },
    async caseRunner({ processFn, dealId, analysisId }) {
      await processFn({});
      return { status: 'blocked', deal_id: dealId, analysis_id: analysisId, detail: null, service_closed: true };
    },
  });
  assert.equal(result.block_kind, 'other');
});

test('повтор сохраняет нормальный результат Wappi и не допускает двойной запуск', async () => {
  const fake = async () => ({ status: 'processed' });
  const report = { status: 'processed', deal_id: '126964', analysis_id: '1986', detail: {}, service_closed: true };
  const result = await runWazzupRetest({ dealId: '126964', analysisId: '1986', processFn: fake,
    async caseRunner({ processFn }) { await processFn({}); return report; },
  });
  assert.equal(result.report.status, 'processed');
  assert.equal(result.block_kind, 'other');
  await assert.rejects(runWazzupRetest({ dealId: '126964', analysisId: '1986', processFn: fake,
    async caseRunner({ processFn }) { await processFn({}); await processFn({}); return report; },
  }), /не подтверждён/);
});

test('посторонние пары и незакрытый пилот отклоняются до выдачи результата', async () => {
  await assert.rejects(runWazzupRetest({ dealId: '1', analysisId: '1968' }), /не разрешён/);
  await assert.rejects(runWazzupRetest({ dealId: '127114', analysisId: '1986' }), /не разрешён/);
  await assert.rejects(runWazzupRetest({ dealId: '127114', analysisId: '1968',
    async caseRunner() { return { status: 'blocked', deal_id: '127114', analysis_id: '1968', service_closed: false }; },
  }), /не подтверждён/);
});
