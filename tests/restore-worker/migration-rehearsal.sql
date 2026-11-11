\set ON_ERROR_STOP on
-- Полностью синтетическая схема, без выгрузки клиентских данных.
\i tests/restore-persistence/synthetic-schema.sql
CREATE ROLE service_role BYPASSRLS;
-- Supabase default privileges проверены родительским агентом read-only:
-- новые таблицы изначально доступны всем трём ролям, миграции должны явно
-- отозвать права у anon/authenticated и сохранить их у service_role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
\i db/migrations/lost_007_zavisshie.sql

INSERT INTO public.lost_deals (deal_id, title) VALUES (100, 'синтетический тест');
INSERT INTO public.lost_deal_analyses (deal_id, pipeline_error, processed_at)
SELECT n, CASE WHEN n = 100 THEN 'сбор неполный' ELSE NULL END,
       '2026-01-01 00:00:00+00'::timestamptz + n * interval '1 second'
FROM generate_series(1, 2176) n;
CREATE TEMP TABLE baseline_analyses AS SELECT to_jsonb(t) AS row FROM public.lost_deal_analyses t;
CREATE TEMP TABLE baseline_attention AS SELECT to_jsonb(t) AS row FROM public.lost_pipeline_attention t;

\i db/proposals/worker-migration-fixtures/20261105052525_lost_processing_jobs.sql
\i db/proposals/worker-migration-fixtures/20261105065540_lost_bitrix_events.sql
\i db/proposals/worker-migration-fixtures/20261105065551_lost_overwrite_history.sql
\i db/proposals/worker-migration-fixtures/20261106031734_lost_audio_wait_origins.sql

DO $$
DECLARE n integer; item text; permission text;
BEGIN
  IF EXISTS (SELECT row FROM baseline_analyses EXCEPT SELECT to_jsonb(t) - 'pipeline_operation_id' FROM public.lost_deal_analyses t)
     OR EXISTS (SELECT to_jsonb(t) - 'pipeline_operation_id' FROM public.lost_deal_analyses t EXCEPT SELECT row FROM baseline_analyses) THEN
    RAISE EXCEPTION 'Existing analyses changed';
  END IF;
  IF EXISTS (SELECT row FROM baseline_attention EXCEPT SELECT to_jsonb(t) FROM public.lost_pipeline_attention t)
     OR EXISTS (SELECT to_jsonb(t) FROM public.lost_pipeline_attention t EXCEPT SELECT row FROM baseline_attention) THEN
    RAISE EXCEPTION 'Attention view changed';
  END IF;
  SELECT count(*) INTO n FROM public.lost_deal_analyses;
  IF n <> 2176 THEN RAISE EXCEPTION 'Existing row count changed'; END IF;
  IF EXISTS (SELECT 1 FROM public.lost_live_config) OR EXISTS (SELECT 1 FROM public.lost_processing_jobs)
     OR EXISTS (SELECT 1 FROM public.lost_bitrix_events) THEN RAISE EXCEPTION 'Migration unexpectedly started processing'; END IF;
  FOREACH item IN ARRAY ARRAY['lost_processing_jobs','lost_nightly_retry_runs','lost_live_config','lost_bitrix_events','lost_overwrite_history'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace nsp ON nsp.oid=c.relnamespace
                   WHERE nsp.nspname='public' AND c.relname=item AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'RLS disabled on %', item;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace nsp ON nsp.oid=c.relnamespace,
               LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
               WHERE nsp.nspname='public' AND c.relname=item AND a.grantee=0) THEN
      RAISE EXCEPTION 'PUBLIC access on %', item;
    END IF;
    FOREACH permission IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF has_table_privilege('anon', 'public.'||item, permission)
         OR has_table_privilege('authenticated', 'public.'||item, permission) THEN
        RAISE EXCEPTION 'Anonymous % access on %', permission, item;
      END IF;
      IF NOT has_table_privilege('service_role', 'public.'||item, permission) THEN
        RAISE EXCEPTION 'No service % access on %', permission, item;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- Все тестовые записи новых объектов отменяются отдельной транзакцией.
BEGIN;
INSERT INTO public.lost_processing_jobs (id, request_key, deal_id, lose_date, trigger_type, origin_stage_history_id)
VALUES ('00000000-0000-4000-8000-000000000001', 'manual:test', 100, now(), 'manual', '12345');
INSERT INTO public.lost_live_config (enabled_at) VALUES ('2026-01-01 00:00:00+00');
DO $$
BEGIN
  BEGIN
    UPDATE public.lost_live_config SET enabled_at=now();
    RAISE EXCEPTION 'immutable trigger did not prevent update';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'lost_live_config immutable' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.lost_processing_jobs (id, request_key, deal_id, lose_date, trigger_type, origin_stage_history_id)
    VALUES ('00000000-0000-4000-8000-000000000002', 'manual:invalid', 100, now(), 'manual', 'invalid');
    RAISE EXCEPTION 'invalid history ID accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.lost_processing_jobs) OR EXISTS (SELECT 1 FROM public.lost_live_config) THEN
    RAISE EXCEPTION 'Smoke test did not roll back';
  END IF;
END $$;
SELECT 'migration_rehearsal_passed' AS result;
