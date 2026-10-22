-- Explicit owner-only migrator. 001 remains immutable; 002 validates adoption.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path = public;
SET LOCAL lock_timeout = '10s';
SELECT pg_catalog.pg_advisory_xact_lock(746221, 1);
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migrations WHERE version NOT IN ('001','002'))
    OR (EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='002')
      AND NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='001')) THEN
    RAISE EXCEPTION 'schema_contract: unsupported migration version/order';
  END IF;
END $preflight$;
SELECT NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='001') AS apply_001 \gset
\if :apply_001
\ir migrations/001-initial.sql
\endif
SELECT NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='002') AS apply_002 \gset
\if :apply_002
\ir migrations/002-schema-contract.sql
-- Only an actual 001->002 upgrade may backfill the old ledger without checksum.
UPDATE public.schema_migrations SET checksum='5c5f8eed8ade4a6c6438bcf84f47d85d1da96a6cb5748f87638614c706331ccb' WHERE version='001' AND checksum='';
\endif
-- Refuse incompatible tables/indexes before recording either new version.
SELECT public.ajtool_validate_schema();
INSERT INTO public.schema_migrations(version,checksum) VALUES ('001','5c5f8eed8ade4a6c6438bcf84f47d85d1da96a6cb5748f87638614c706331ccb') ON CONFLICT(version) DO NOTHING;
INSERT INTO public.schema_migrations(version,checksum) VALUES ('002','ded1fdb5fee5bd1cae54d6f2cf63653a8f341df39a05c38918cce896e7a37f3e') ON CONFLICT(version) DO NOTHING;
DO $versions$
BEGIN
  IF (SELECT count(*) FROM public.schema_migrations)<>2 OR EXISTS (
    SELECT 1 FROM public.schema_migrations WHERE checksum IS DISTINCT FROM CASE version
      WHEN '001' THEN '5c5f8eed8ade4a6c6438bcf84f47d85d1da96a6cb5748f87638614c706331ccb' WHEN '002' THEN 'ded1fdb5fee5bd1cae54d6f2cf63653a8f341df39a05c38918cce896e7a37f3e' END
  ) THEN RAISE EXCEPTION 'schema_contract: migration checksum/version mismatch'; END IF;
END $versions$;
COMMIT;
