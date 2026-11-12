-- Prepared adapter for the existing dedicated AJTool project; NEVER an automatic deployment.
-- Changes RLS to private SQL ACLs atomically, only after explicit operator approval and backup.
-- Refuses unrelated public objects. Auth/storage/other schemas and other Supabase projects untouched.
\set ON_ERROR_STOP on
\if :{?ajtool_private_sql_approved}
\else
DO $missing_approval$ BEGIN RAISE EXCEPTION 'private_adoption: explicit private-SQL approval required'; END $missing_approval$;
\endif
\if :{?backup_manifest_sha256}
\else
DO $missing_backup$ BEGIN RAISE EXCEPTION 'private_adoption: verified backup manifest required'; END $missing_backup$;
\endif
BEGIN;
SET LOCAL search_path=pg_catalog,public;
SET LOCAL lock_timeout='10s';
SELECT set_config('ajtool.private_sql_approved',:'ajtool_private_sql_approved',true);
SELECT set_config('ajtool.backup_manifest_sha256',:'backup_manifest_sha256',true);
SELECT set_config('ajtool.runtime_role',:'runtime_role',true);
SELECT pg_advisory_xact_lock(746221,1);
DO $scope$
DECLARE required text;
BEGIN
 IF current_setting('ajtool.private_sql_approved')<>'I_APPROVE_PRIVATE_AJTOOL_SQL' OR current_setting('ajtool.backup_manifest_sha256')!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'private_adoption: explicit reviewed approval and backup evidence required';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  LEFT JOIN pg_roles recipient ON recipient.oid=a.grantee
  WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user)
   AND d.defaclnamespace=0 AND d.defaclobjtype IN ('r','S')
   AND (a.grantee=0 OR recipient.rolname IN ('anon','authenticated','service_role'))) THEN
  RAISE EXCEPTION 'private_adoption: global migrator defaults grant Data API access; separate administrator review required';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('information_schema','public')
  AND c.relkind IN ('r','p','v','m','f','S') AND has_schema_privilege(current_setting('ajtool.runtime_role'),n.oid,'USAGE') AND CASE WHEN c.relkind='S'
   THEN has_sequence_privilege(current_setting('ajtool.runtime_role'),c.oid,'USAGE,SELECT,UPDATE')
   ELSE has_table_privilege(current_setting('ajtool.runtime_role'),c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege(current_setting('ajtool.runtime_role'),c.oid,'SELECT,INSERT,UPDATE,REFERENCES') END)
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND p.prosecdef
  AND has_schema_privilege(current_setting('ajtool.runtime_role'),n.oid,'USAGE')
  AND has_function_privilege(current_setting('ajtool.runtime_role'),p.oid,'EXECUTE')) THEN
  RAISE EXCEPTION 'private_adoption: runtime access outside application contract; provider ACL review required before changes';
 END IF;
 FOREACH required IN ARRAY ARRAY['studies','consumer_cursors','spec_cache','settings','settings_history'] LOOP
  IF to_regclass('public.'||required) IS NULL THEN RAISE EXCEPTION 'private_adoption: existing AJTool legacy tables required'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND c.relname NOT IN
 ('studies','consumer_cursors','spec_cache','settings','settings_history','schema_migrations','runtime_identity','event_inbox','event_rejections','event_outbox','outbox_attempts','manual_commands','delivery_gates'))
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname !~ '^ajtool_')
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' AND c.relname NOT IN
 ('settings_history_id_seq','event_rejections_rejection_id_seq','event_outbox_outbox_id_seq','outbox_attempts_id_seq')) THEN
  RAISE EXCEPTION 'private_adoption: unrelated public objects detected; no cross-project changes allowed';
 END IF;
END $scope$;
-- Keep other existing roles' effective database/schema capabilities when PUBLIC is restricted.
CREATE TEMP TABLE ajtool_prior_capabilities ON COMMIT DROP AS
 SELECT rolname,has_database_privilege(rolname,current_database(),'TEMP') AS temporary,
 has_database_privilege(rolname,current_database(),'CREATE') AS database_create,
 has_schema_privilege(rolname,'public','CREATE') AS schema_create
 FROM pg_roles WHERE rolname<>current_setting('ajtool.runtime_role');
DO $rls$
DECLARE item record;
BEGIN
 FOR item IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' LOOP
  EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY',item.relname);
  EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY',item.relname);
 END LOOP;
END $rls$;
-- No RLS/ACL changes become visible until schema, grants and API denials all pass.
SELECT set_config('ajtool.external_migration','private-supabase-v1',true);
\set ajtool_external_transaction 1
\ir migrate.sql
\ir runtime-role.sql
DO $private_acl$
DECLARE r record; t record; col record; proc record; cap record;
BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  -- Only future public objects of the executing application migrator are affected.
  -- Provider-role defaults and auth/storage/extension objects are not modified.
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I',r.rolname);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',r.rolname);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I',r.rolname);
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' LOOP
   EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',t.relname,r.rolname);
   FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('public.'||quote_ident(t.relname))::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES (%I) ON TABLE public.%I FROM %I',col.attname,t.relname,r.rolname);
   END LOOP;
   IF has_table_privilege(r.rolname,'public.'||quote_ident(t.relname),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.rolname,'public.'||quote_ident(t.relname),'SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'private_adoption: Data API role still has application-table access';
   END IF;
  END LOOP;
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' LOOP
   EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM %I',t.relname,r.rolname);
  END LOOP;
  FOR proc IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' LOOP
   EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',proc.signature,r.rolname);
  END LOOP;
 END LOOP;
 ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
 ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
 -- PostgreSQL's built-in PUBLIC EXECUTE default is global; a per-schema REVOKE
 -- cannot subtract it. Do not change that global/provider default here. Any new
 -- application function must revoke PUBLIC EXECUTE in its owning transaction.
 FOR cap IN SELECT * FROM ajtool_prior_capabilities LOOP
  IF cap.temporary THEN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO %I',current_database(),cap.rolname); END IF;
  IF cap.database_create THEN EXECUTE format('GRANT CREATE ON DATABASE %I TO %I',current_database(),cap.rolname); END IF;
  IF cap.schema_create THEN EXECUTE format('GRANT CREATE ON SCHEMA public TO %I',cap.rolname); END IF;
 END LOOP;
END $private_acl$;
SELECT public.ajtool_validate_schema();
\unset ajtool_external_transaction
COMMIT;
