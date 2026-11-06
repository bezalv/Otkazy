import assert from 'node:assert/strict';
import test from 'node:test';
import { persistResult, lookupOperation, loadResumableResult, CommitOutcomeUnknownError } from '../../app/src/persistence/index.mjs';
import { existsSync, readFileSync } from 'node:fs';

function mockPool({ failAt, emptyQueue = false, invalidLease = false, expiredAtFinish = false, existing = null, lookup = null, resumable = null, silent = true, triggerType = 'batch', requestKey = 'test-key' } = {}) {
  const calls = [];
  let released;
  const connection = {
    async query(query) {
      const text = typeof query === 'string' ? query : query.text;
      calls.push(query);
      if (failAt && (typeof failAt === 'string' ? text.includes(failAt) : failAt(text))) throw new Error('Ошибка с секретом');
      if (text.includes('FROM public.lost_processing_jobs') && text.includes('FOR UPDATE')) {
        return invalidLease ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ deal_id: 42, lose_date: '2026-11-02T00:00:00Z', silent, screenshots: false, trigger_type: triggerType, request_key: requestKey }] };
      }
      if (text.includes('SELECT j.deal_id, j.silent')) return { rowCount: resumable ? 1 : 0, rows: resumable ? [resumable] : [] };
      if (text.includes('FROM public.lost_processing_jobs j')) return { rowCount: lookup ? 1 : 0, rows: lookup ? [lookup] : [] };
      if (text.includes('SELECT id, deal_id, pipeline_error FROM public.lost_deal_analyses')) return { rowCount: existing ? 1 : 0, rows: existing ? [existing] : [] };
      if (text.includes('SELECT id FROM public.lost_processing_jobs') && expiredAtFinish) return { rowCount: 0, rows: [] };
      if (text.includes('UPDATE public.lost_processing_jobs') && expiredAtFinish) return { rowCount: 0, rows: [] };
      if (text.includes('INSERT INTO public.lost_deal_analyses') && text.includes('RETURNING id')) {
        return { rowCount: 1, rows: [{ id: '71' }] };
      }
      if (text.includes('RETURNING deal_id')) return { rowCount: emptyQueue ? 0 : 1, rows: emptyQueue ? [] : [{ deal_id: 42 }] };
      return { rowCount: 1, rows: [] };
    },
    release(error) { released = error || null; },
  };
  return { pool: { async connect() { return connection; } }, calls, released: () => released };
}

const audioWait = {
  origin_stage_history_id: '101',
  lose_date: '2026-11-02T00:00:00Z', first_seen_at: '2026-11-02T00:01:00Z',
  deadline_at: '2026-11-03T00:01:00Z', next_check_at: '2026-11-02T00:06:00Z',
  pending_calls: ['12'], observations: { 12: { activity_id: '12' } },
};
const operationId = '00000000-0000-4000-8000-000000000001';
const leaseToken = '00000000-0000-4000-8000-000000000002';
const lease = { operation_id: operationId, lease_token: leaseToken };
const deal = {
  deal_id: 42, title: "Тестовая'; DROP TABLE lost_deals; --", stage_id: 'C23:LOSE',
  lose_date: '2026-11-02T00:00:00Z', lose_reason: 'Цена', product_type: ['окна'],
};
const communication = {
  type: 'call', activity_id: 12, date: '2026-11-01T11:00:00Z',
  duration_start: '2026-11-01T11:00:00Z', duration_end: '2026-11-01T11:02:00Z',
  _needs_transcription: true, transcript: 'Менеджер: Добрый день', transcript_engine: 'reserve:gigaam',
  screenshot_files: [{ id: 42 }], screenshot_turns: [{ speaker: 'client', text: 'Добрый день' }],
};
const processed = {
  ...lease, deal_id: 42, deal_data: deal, _status: 'processed', prompt_version: 'v2.8-sol',
  classification: { summary: 'Итог', exact_reason: 'Причина', reason_class: 'price', reactivation_probability: 50 },
  multi_agent_analysis: { verdict: 'неправомерен', recoverable_level: 'средний', closure_reason_class: 'price', final_comment: 'Разбор', facts_packet: { facts: [] } },
  llm_meta: { model: 'openai/gpt-6-sol' }, comm_stats: { total_events: 1, calls: 1 },
  communications_with_transcripts: [communication], full_prompt_text: 'Журнал', journal_text: 'События',
  comm_analytics: { calls_total: 1 }, screenshot_stats: {}, silent: true,
};

const texts = (calls) => calls.map((call) => typeof call === 'string' ? call : call.text);

test('анализ и коммуникации записываются параметрами в одной транзакции', async () => {
  const mock = mockPool();
  const result = await persistResult(mock.pool, processed);
  const statements = texts(mock.calls);
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-1), 'COMMIT');
  assert.equal(result.analysisId, '71');
  assert.equal(result.status, 'processed');
  assert.equal(statements[1].includes('FOR UPDATE'), true);
  assert.equal(statements[2].includes('pg_advisory_xact_lock'), true);
  assert.equal(statements.at(-2).includes("status='done'"), true);
  assert.equal(statements.some((text) => text.includes(deal.title)), false);
  assert.equal(mock.calls.some((call) => typeof call !== 'string' && call.values.includes(deal.title)), true);
  assert.equal(statements.some((text) => text.includes('COALESCE(EXCLUDED.lose_date, lost_deals.lose_date)')), true);
  assert.equal(statements.some((text) => text.includes('COALESCE(EXCLUDED.transcript_engine, lost_deal_communications.transcript_engine)')), true);
  assert.equal(mock.released(), null);
});

test('наборы сохраняемых колонок совпадают с выгрузкой n8n', {
  skip: !existsSync('tmp/backup/sql-posle.js'),
}, async () => {
  const source = readFileSync('tmp/backup/sql-posle.js', 'utf8');
  const old = new Function('$input', source)({ first: () => ({ json: processed }) })[0].json.sql;
  const mock = mockPool();
  await persistResult(mock.pool, processed);
  for (const table of ['lost_deals', 'lost_deal_analyses', 'lost_deal_communications']) {
    const pattern = new RegExp(`INSERT INTO (?:public\\.)?${table} \\(([^)]+)\\) VALUES`);
    const oldColumns = old.match(pattern)?.[1].split(',').map((part) => part.trim()).sort();
    const currentText = texts(mock.calls).find((text) => text.includes(`INSERT INTO public.${table} `));
    const currentColumns = currentText?.match(pattern)?.[1].split(',').map((part) => part.trim()).filter((column) => column !== 'pipeline_operation_id').sort();
    assert.ok(oldColumns, `нет исходной записи ${table}`);
    assert.deepStrictEqual(currentColumns, oldColumns);
  }
});

test('ожидающая аудиозапись ставится без анализа', async () => {
  const mock = mockPool();
  await persistResult(mock.pool, { ...lease, deal_id: 42, _status: 'waiting_audio', audio_wait: audioWait, silent: true });
  assert.equal(texts(mock.calls).some((text) => text.includes('INSERT INTO public.lost_audio_wait')), true);
  assert.equal(texts(mock.calls).some((text) => text.includes('lost_deal_analyses')), false);
  assert.deepStrictEqual(texts(mock.calls).filter((text) => text === 'BEGIN' || text === 'COMMIT'), ['BEGIN', 'COMMIT']);
});

test('сбой проверки аудио двигает только её актуальную очередь до завершения задачи', async () => {
  const mock = mockPool({ triggerType: 'audio_wait', requestKey: 'audio-wait:test' });
  await persistResult(mock.pool, { ...lease, deal_id: 42, _status: 'error', _error: 'тест' });
  const statements = texts(mock.calls);
  const update = mock.calls.find((call) => typeof call !== 'string' && call.text.includes('UPDATE public.lost_audio_wait w'));
  assert.deepStrictEqual(update.values, [42, '2026-11-02T00:00:00Z', 'audio-wait:test']);
  assert.match(update.text, /w\.lose_date=\$2 AND w\.state='waiting'/);
  assert.match(update.text, /w\.next_check_at <= retry_clock\.at/);
  assert.ok(statements.indexOf(update.text) < statements.findIndex((text) => text.includes("SET status='done'")));
  assert.equal(statements.at(-1), 'COMMIT');
});

test('сбой обычного задания не меняет расписание аудио', async () => {
  const mock = mockPool();
  await persistResult(mock.pool, { ...lease, deal_id: 42, _status: 'error', _error: 'тест' });
  assert.equal(texts(mock.calls).some((text) => text.includes('UPDATE public.lost_audio_wait w')), false);
});

test('ошибка изменения расписания откатывает запись сбоя и завершение задачи', async () => {
  const mock = mockPool({ triggerType: 'audio_wait', failAt: 'UPDATE public.lost_audio_wait w' });
  await assert.rejects(persistResult(mock.pool, { ...lease, deal_id: 42, _status: 'error' }));
  assert.equal(texts(mock.calls).at(-1), 'ROLLBACK');
  assert.equal(texts(mock.calls).some((text) => text.includes("SET status='done'")), false);
});

test('нетихий разбор оставляет задачу под арендой для внешних действий', async () => {
  const mock = mockPool({ silent: false });
  const saved = await persistResult(mock.pool, processed);
  assert.equal(saved.needsExternalActions, true);
  assert.equal(texts(mock.calls).some((text) => text.includes("SET status='done'")), false);
  assert.equal(texts(mock.calls).at(-1), 'COMMIT');
});

test('уже сохранённый нетихий разбор не записывается повторно', async () => {
  const mock = mockPool({ silent: false, existing: { id: '71', deal_id: 42, pipeline_error: null } });
  const saved = await persistResult(mock.pool, processed);
  assert.equal(saved.status, 'already_committed');
  assert.equal(saved.needsExternalActions, true);
  assert.equal(texts(mock.calls).some((text) => text.startsWith('INSERT')), false);
  assert.equal(texts(mock.calls).some((text) => text.includes("SET status='done'")), false);
});

for (const expired of [false, true]) {
  test(`сохранение и завершение очереди аудио атомарны, expired=${expired}`, async () => {
    const mock = mockPool();
    const input = {
      ...processed,
      multi_agent_analysis: { ...processed.multi_agent_analysis, verdict: expired ? 'недостаточно_данных' : 'неправомерен' },
      communications_with_transcripts: expired ? [] : processed.communications_with_transcripts,
      audio_wait: audioWait,
      audio_wait_expired: expired,
    };
    await persistResult(mock.pool, input);
    const finish = mock.calls.find((call) => typeof call !== 'string' && call.text.includes('UPDATE public.lost_audio_wait SET state=$1'));
    assert.equal(finish.values[0], expired ? 'expired' : 'done');
    assert.equal(finish.values[6], JSON.stringify(audioWait.pending_calls));
    assert.equal(texts(mock.calls).at(-1), 'COMMIT');
  });
}

test('потеря очереди аудио откатывает всю транзакцию', async () => {
  const mock = mockPool({ emptyQueue: true });
  await assert.rejects(persistResult(mock.pool, { ...processed, audio_wait: audioWait }), /Не удалось завершить/);
  assert.equal(texts(mock.calls).at(-1), 'ROLLBACK');
  assert.equal(texts(mock.calls).includes('COMMIT'), false);
});

test('дубли сохраняют карточку без анализа и отменяют ожидание', async () => {
  const mock = mockPool();
  await persistResult(mock.pool, { ...lease, deal_id: 42, deal_data: deal, _status: 'skipped_by_reason', audio_origin_stage_history_id: '101' });
  assert.equal(texts(mock.calls).some((text) => text.includes('INSERT INTO public.lost_deals')), true);
  assert.equal(texts(mock.calls).some((text) => text.includes('INSERT INTO public.lost_deal_analyses')), false);
  assert.equal(texts(mock.calls).some((text) => text.includes("state='cancelled'")), true);
});

test('без подтверждённого ID отмена очереди по одной дате не выполняется', async () => {
  const mock = mockPool();
  await persistResult(mock.pool, { ...lease, deal_id: 42, deal_data: deal, _status: 'skipped_by_reason' });
  assert.equal(texts(mock.calls).some(text => text.includes("state='cancelled'")), false);
});

test('ошибка сохраняется без вердикта и с очисткой секрета', async () => {
  const mock = mockPool();
  await persistResult(mock.pool, { ...lease, deal_id: 42, _status: 'error', _error: 'Ошибка https://site/rest/65/secretvalue/crm.deal.get' });
  const insert = mock.calls.find((call) => typeof call !== 'string' && call.text.includes('lost_deal_analyses'));
  assert.equal(insert.values.join(' ').includes('secretvalue'), false);
  assert.equal(texts(mock.calls).some((text) => text.includes('INSERT INTO public.lost_deals')), false);
});

test('сбой записи откатывает всё без повтора', async () => {
  const mock = mockPool({ failAt: 'INSERT INTO public.lost_deal_communications' });
  await assert.rejects(persistResult(mock.pool, processed));
  assert.equal(texts(mock.calls).at(-1), 'ROLLBACK');
  assert.equal(texts(mock.calls).includes('COMMIT'), false);
  assert.equal(texts(mock.calls).filter((text) => text.includes('INSERT INTO public.lost_deal_analyses')).length, 1);
});

test('неизвестный исход COMMIT нельзя автоматически повторить', async () => {
  const mock = mockPool({ failAt: 'COMMIT' });
  await assert.rejects(persistResult(mock.pool, processed), (error) => error instanceof CommitOutcomeUnknownError && error.code === 'COMMIT_OUTCOME_UNKNOWN' && error.operationId === operationId);
  assert.equal(texts(mock.calls).filter((text) => text === 'COMMIT').length, 1);
  assert.equal(texts(mock.calls).includes('ROLLBACK'), false);
  assert.ok(mock.released() instanceof Error);
});

test('устаревшая аренда не позволяет выполнить запись', async () => {
  const mock = mockPool({ invalidLease: true });
  await assert.rejects(persistResult(mock.pool, processed), /аренда истекла/);
  assert.equal(texts(mock.calls).some((text) => text.startsWith('INSERT')), false);
  assert.equal(texts(mock.calls).at(-1), 'ROLLBACK');
});

test('истечение аренды перед завершением откатывает все записи', async () => {
  const mock = mockPool({ expiredAtFinish: true });
  await assert.rejects(persistResult(mock.pool, processed), /Аренда задачи истекла/);
  assert.equal(texts(mock.calls).at(-1), 'ROLLBACK');
  assert.equal(texts(mock.calls).includes('COMMIT'), false);
});

test('сохранённая операция не создаёт второй анализ и повторные записи', async () => {
  const mock = mockPool({ existing: { id: '71', deal_id: 42, pipeline_error: null } });
  const result = await persistResult(mock.pool, processed);
  assert.equal(result.status, 'already_committed');
  assert.equal(result.analysisId, '71');
  assert.equal(texts(mock.calls).some((text) => text.startsWith('INSERT')), false);
  assert.equal(texts(mock.calls).at(-1), 'COMMIT');
});

test('совпавший operation_id другой сделки отклоняется', async () => {
  const mock = mockPool({ existing: { id: '71', deal_id: 99, pipeline_error: null } });
  await assert.rejects(persistResult(mock.pool, processed), /другому результату/);
  assert.equal(texts(mock.calls).at(-1), 'ROLLBACK');
});

test('состояние операции после неизвестного COMMIT читается отдельно без записи', async () => {
  const mock = mockPool({ lookup: { job_id: operationId, job_status: 'done', deal_id: 42, analysis_id: '71', pipeline_error: null } });
  const result = await lookupOperation(mock.pool, operationId);
  assert.deepStrictEqual(result, { operationId, dealId: 42, jobStatus: 'done', analysisId: '71', analysisStatus: 'processed' });
  assert.equal(mock.calls.length, 1);
  assert.match(texts(mock.calls)[0], /^SELECT/);
});

test('повторный захват читает готовый разбор без записи и вызова модели', async () => {
  const mock = mockPool({ resumable: {
    deal_id: 42, silent: false, screenshots: true, analysis_id: '71', pipeline_error: null,
    prompt_version: 'v2.8-sol', ai_judge_json: processed.multi_agent_analysis, title: 'Сделка',
  } });
  const loaded = await loadResumableResult(mock.pool, lease);
  assert.equal(loaded.analysisId, '71');
  assert.equal(loaded.result.multi_agent_analysis.verdict, 'неправомерен');
  assert.equal(loaded.result.prompt_version, 'v2.8-sol');
  assert.equal(mock.calls.length, 1);
  assert.match(texts(mock.calls)[0], /^SELECT/);
});

test('загрузка сохранённого результата требует действующей аренды', async () => {
  const mock = mockPool();
  await assert.rejects(loadResumableResult(mock.pool, lease), /аренда истекла/);
  assert.equal(mock.calls.length, 1);
});

test('неполный результат и чужая карточка не начинают транзакцию', async () => {
  const mock = mockPool();
  await assert.rejects(persistResult(mock.pool, { ...processed, pipeline_error: 'сбой' }), /Неполный результат/);
  await assert.rejects(persistResult(mock.pool, { ...processed, deal_id: 43 }), /Карточка не соответствует/);
  assert.equal(mock.calls.length, 0);
});
