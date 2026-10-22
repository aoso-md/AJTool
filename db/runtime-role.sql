-- Dedicated AJTool database only. Run as administrator AFTER migrate.sql:
-- psql -X -v runtime_role=ajtool_runtime -f db/runtime-role.sql <owner connection>
-- Create the LOGIN role and provision its password through your secret manager.
-- It must not own objects or belong to an owner/privileged role.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SELECT set_config('ajtool.runtime_role', :'runtime_role', true);
DO $preflight$
DECLARE target oid;
BEGIN
  SELECT oid INTO STRICT target FROM pg_roles WHERE rolname=current_setting('ajtool.runtime_role');
  IF EXISTS (SELECT 1 FROM pg_roles WHERE oid=target
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT 1 FROM pg_roles WHERE oid<>target AND pg_has_role(target,oid,'MEMBER'))
    OR EXISTS (SELECT 1 FROM pg_database WHERE datdba=target AND datname=current_database())
    OR EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass
      AND refobjid=target AND deptype='o'
      AND dbid IN (0,(SELECT oid FROM pg_database WHERE datname=current_database())))
    OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=target)
    OR EXISTS (SELECT 1 FROM pg_class WHERE relowner=target)
    OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner=target) THEN
    RAISE EXCEPTION 'runtime_contract: use a dedicated non-owner role without memberships or administrative attributes';
  END IF;
END $preflight$;
SELECT current_database() AS database_name \gset
REVOKE CREATE, TEMPORARY ON DATABASE :"database_name" FROM PUBLIC;
REVOKE ALL ON DATABASE :"database_name" FROM :"runtime_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"runtime_role";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM :"runtime_role";
GRANT USAGE ON SCHEMA public TO :"runtime_role";
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"runtime_role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"runtime_role";
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM :"runtime_role";
-- Table-level REVOKE does not remove column-level grants inherited from PUBLIC.
DO $columns$
DECLARE col record;
BEGIN
  FOR col IN SELECT c.relname,a.attname FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','f')
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES (%I) ON TABLE public.%I FROM PUBLIC, %I',
      col.attname,col.relname,current_setting('ajtool.runtime_role'));
  END LOOP;
END $columns$;
GRANT SELECT, INSERT, UPDATE ON studies, consumer_cursors, spec_cache, settings TO :"runtime_role";
GRANT SELECT, INSERT ON settings_history TO :"runtime_role";
GRANT USAGE, SELECT ON SEQUENCE settings_history_id_seq TO :"runtime_role";
GRANT SELECT ON schema_migrations TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.ajtool_validate_schema() TO :"runtime_role";
COMMIT;
