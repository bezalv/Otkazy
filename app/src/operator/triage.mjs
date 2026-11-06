import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { getCACertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readMainConfig } from '../main.mjs';
import { createDeadlinePool } from '../db/deadline-pool.mjs';
import { reviewSummary } from './report.mjs';

/** Параметры получаются через тот же валидатор, что и активное приложение. */
export function databaseConfig(env, readCertificate = readFileSync) {
  const { databaseUrl } = readMainConfig({ OTKAZY_MODE: 'active', TZ: 'UTC', DATABASE_URL: env.DATABASE_URL,
    BITRIX_DOMAIN: 'example.invalid', BITRIX_REST_BASE: 'https://example.invalid/',
    BITRIX_EVENT_TOKEN: 'unused', BITRIX_MEMBER_ID: 'unused', POLZA_API_KEY: 'unused', LIVE_ENABLED_AT: '2000-01-01T00:00:00Z' });
  const certificate = new X509Certificate(readCertificate(new URL('../../certs/supabase-root-ca-2021.crt', import.meta.url), 'utf8'));
  if (!certificate.ca || certificate.fingerprint256.replaceAll(':', '') !== '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA') throw new Error('Сертификат не подтверждён');
  return { connectionString: databaseUrl, ssl: { rejectUnauthorized: true, ca: [...getCACertificates('default'), certificate.toString()] },
    max: 1, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, keepAlive: true };
}

/** Запускается явно; никаких слушателей, воркеров и операций записи. */
export async function runTriage({ env = process.env, makePool = async config => {
  const { default: pg } = await import('pg');
  return new pg.Pool(config);
}, report = reviewSummary } = {}) {
  const config = databaseConfig(env);
  const raw = await makePool(config);
  raw.on?.('error', () => {});
  const pool = createDeadlinePool(raw);
  try { return await report(pool); }
  finally { await pool.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error('Параметры командной строки не поддерживаются');
    process.exitCode = 1;
  } else {
    runTriage().then(result => console.log(JSON.stringify(result))).catch(() => {
      console.error('Не удалось получить отчёт о доставке');
      process.exitCode = 1;
    });
  }
}
