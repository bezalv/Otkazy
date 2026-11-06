import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createDeadlinePool } from '../db/deadline-pool.mjs';
import { databaseConfig } from '../operator/triage.mjs';
import { startSttService } from '../stt/child.mjs';
import { loadPilotBaselines } from './candidates.mjs';
import { createPilotDependencies } from './dependencies.mjs';
import { createPilotRunner } from './index.mjs';
import { DIAGNOSTIC_CATEGORIES, DIAGNOSTIC_METHODS, DIAGNOSTIC_SOURCES, DIAGNOSTIC_MEDIA } from './diagnostics.mjs';

const STATUSES = new Set(['processed', 'waiting', 'skip', 'skipped', 'skipped_by_reason', 'blocked',
  'error', 'obsolete_transition', 'source_incomplete', 'unverified']);
const COMPARISONS = ['match', 'different', 'unavailable'];

export function parseSelectedIds(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 5) throw new TypeError('Нужно явно указать от одной до пяти сделок');
  const unique = new Set();
  return values.map(value => {
    if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || BigInt(value) > 2147483647n || unique.has(value)) {
      throw new TypeError('Некорректный список сделок');
    }
    unique.add(value);
    return Number(value);
  });
}

function counts() { return Object.fromEntries(COMPARISONS.map(key => [key, 0])); }
function namedCounts(names) { return Object.fromEntries(names.map(name => [name, 0])); }
function addDiagnostic(summary, value) {
  const category = DIAGNOSTIC_CATEGORIES.includes(value?.category) ? value.category : 'other';
  summary.categories[category]++;
  if (DIAGNOSTIC_METHODS.includes(value?.last_bitrix_method)) summary.last_bitrix_methods[value.last_bitrix_method]++;
  const status = value?.http_status;
  if (Number.isInteger(status) && status >= 400 && status <= 599) summary.http_statuses[String(status)] = (summary.http_statuses[String(status)] || 0) + 1;
  if (Array.isArray(value?.failed_sources)) {
    for (const name of new Set(value.failed_sources)) if (DIAGNOSTIC_SOURCES.includes(name)) summary.failed_sources[name]++;
  }
  for (const name of DIAGNOSTIC_MEDIA) {
    const count = value?.recognition_failures?.[name];
    if (Number.isSafeInteger(count) && count > 0 && count <= 10000) summary.recognition_failures[name] += count;
  }
}

/**
 * Только явно выбранные ID. Базу закрываем до анализа; очередь, HTTP-сервер
 * основного приложения и доставка не создаются. Для аудио временно запускается
 * отдельный STT на loopback. Возвращаем только сводные числа без фактов и текста.
 * Зависимости внедряются для синтетических тестов; в CLI используются реальные.
 */
export async function runPilotCommand({ ids, env = process.env,
  makePool = async config => { const { default: pg } = await import('pg'); return new pg.Pool(config); },
  readBaselines = loadPilotBaselines, startService = startSttService,
  makeDependencies = createPilotDependencies, makeRunner = createPilotRunner,
  readPrompts = async () => ({
    judgeSystemPrompt: await readFile(new URL('../../prompts/judge.md', import.meta.url), 'utf8'),
    writerSystemPrompt: await readFile(new URL('../../prompts/writer.md', import.meta.url), 'utf8'),
  }),
} = {}) {
  const selected = parseSelectedIds(ids);
  if (typeof env?.BITRIX_REST_BASE !== 'string' || !env.BITRIX_REST_BASE.trim()
      || typeof env?.POLZA_API_KEY !== 'string' || !env.POLZA_API_KEY.trim()) throw new Error('Не заданы параметры пилота');
  const config = databaseConfig(env);
  const raw = await makePool(config);
  raw.on?.('error', () => {});
  const pool = createDeadlinePool(raw);
  let originals;
  try { originals = await readBaselines(pool, { dealIds: selected }); }
  finally { await pool.end(); }
  if (!originals || !Array.isArray(originals.baselines) || originals.baselines.length !== selected.length
      || !originals.audio_wait_enabled_at || originals.baselines.some((row, i) => Number(row.deal_id) !== selected[i])) {
    throw new Error('Эталоны пилота не подтверждены');
  }
  const prompts = await readPrompts();
  let service, deps;
  try {
    service = await startService({ polzaKey: env.POLZA_API_KEY, env });
    deps = makeDependencies({ bitrixBaseUrl: env.BITRIX_REST_BASE, polzaKey: env.POLZA_API_KEY,
      sttUrl: service.address, sttKey: service.key, tempRoot: service.tempRoot });
    const runner = makeRunner({ ...deps, ...prompts });
    const output = { selected: selected.length, attempted: 0, statuses: {}, verdict: counts(),
      reason_class: counts(), exact_facts: counts(), screenshots_enabled: true,
      diagnostics: { categories: namedCounts(DIAGNOSTIC_CATEGORIES), last_bitrix_methods: namedCounts(DIAGNOSTIC_METHODS),
        failed_sources: namedCounts(DIAGNOSTIC_SOURCES), recognition_failures: namedCounts(DIAGNOSTIC_MEDIA), http_statuses: {} },
      limitations: ['legacy_origin_unverified', 'current_card_may_have_changed', 'historical_inputs_may_have_changed', 'historical_transition_not_verified',
        'model_responses_are_nondeterministic', 'semantic_equivalence_not_established'] };
    for (const baseline of originals.baselines) {
      let result;
      try { result = await runner.run({ dealId: baseline.deal_id,
        baseline: { ...baseline, audio_wait_enabled_at: originals.audio_wait_enabled_at }, screenshots: true }); }
      catch { output.statuses.error = (output.statuses.error || 0) + 1; output.attempted++;
        addDiagnostic(output.diagnostics, { category: 'processing_exception' }); break; }
      output.attempted++;
      addDiagnostic(output.diagnostics, result?.diagnostic);
      const status = STATUSES.has(result?.status) ? result.status : 'other';
      output.statuses[status] = (output.statuses[status] || 0) + 1;
      for (const [field, value] of [['verdict', result?.verdict], ['reason_class', result?.reason_class], ['exact_facts', result?.facts?.exact]]) {
        output[field][COMPARISONS.includes(value) ? value : 'unavailable']++;
      }
      // Ошибка или неподтверждённый случай требуют разбора до следующего вызова.
      if (['error', 'unverified', 'blocked', 'source_incomplete', 'other'].includes(status)) break;
    }
    return output;
  } finally {
    try { deps?.close(); }
    finally { if (service) await service.close(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPilotCommand({ ids: process.argv.slice(2) }).then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('Не удалось выполнить пилот; проверка остановлена');
    process.exitCode = 1;
  });
}
