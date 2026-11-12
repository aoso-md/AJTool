-- Explicit opt-in companion to immutable001-003. Never disables RLS.
-- Run in the migrator transaction on the restored copy before final validation.
SELECT set_config('ajtool.rls_runtime_role', :'runtime_role', true);
DO $rls_private$
DECLARE t text; api text; col record; definition text; original_guard text;
BEGIN
 IF current_setting('ajtool.rls_runtime_role')<>'ajtool_service' THEN
  RAISE EXCEPTION 'private_rls_contract: dedicated runtime required';
 END IF;
 FOREACH t IN ARRAY ARRAY['studies','consumer_cursors','spec_cache','settings','settings_history','schema_migrations','runtime_identity','event_inbox','event_rejections','event_outbox','outbox_attempts','manual_commands','delivery_gates'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=('public.'||t)::regclass AND polname='ajtool_private_runtime_v1') THEN
   EXECUTE format('CREATE POLICY ajtool_private_runtime_v1 ON public.%I TO %I USING (true) WITH CHECK (true)',t,current_setting('ajtool.rls_runtime_role'));
  END IF;
 END LOOP;
 FOREACH api IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=api) THEN
   EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I',api);
   EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I',api);
   EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I',api);
   FOR col IN SELECT c.relname,a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON TABLE public.%I FROM %I',col.attname,col.relname,api);
   END LOOP;
   EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I',api);
   EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',api);
  END IF;
 END LOOP;
 definition:=pg_get_functiondef('public.ajtool_validate_schema()'::regprocedure);
 definition:=replace(definition,E'\r\n',E'\n');
 original_guard:='c.relkind<>''r'' OR c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition';
 IF position(original_guard IN definition)=0 AND position('c.relkind<>''r'' OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR c.relispartition' IN definition)=0 THEN RAISE EXCEPTION 'private_rls_contract: expected immutable003 validator not found'; END IF;
 -- Retain all structural/index/constraint/default checks. Require enabled AND forced RLS.
 definition:=replace(definition,original_guard,'c.relkind<>''r'' OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR c.relispartition');
 definition:=replace(definition,'ordinary table without RLS or inheritance','ordinary table with forced RLS and without inheritance');
 -- Keep policy safety part of the runtime validator, not just installation-time checks.
 IF position('PERFORM public.ajtool_validate_private_rls()' IN definition)=0 THEN
  definition:=replace(definition,E'BEGIN\n',E'BEGIN\n  PERFORM public.ajtool_validate_private_rls();\n');
 END IF;
 IF position('PERFORM public.ajtool_validate_private_rls()' IN definition)=0 THEN RAISE EXCEPTION 'private_rls_contract: policy validator hook missing'; END IF;
 EXECUTE definition;
END $rls_private$;

CREATE OR REPLACE FUNCTION public.ajtool_validate_private_rls() RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $policy_contract$
BEGIN
 IF EXISTS(
  SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
   AND (0=ANY(p.polroles) OR NOT (SELECT coalesce(bool_and(r.rolname='ajtool_service'),false) FROM pg_roles r WHERE r.oid=ANY(p.polroles)))
 ) THEN RAISE EXCEPTION 'private_rls_contract: unknown policy role'; END IF;
 IF EXISTS(
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
   AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polcmd='*' AND p.polpermissive
    AND (SELECT oid FROM pg_roles WHERE rolname='ajtool_service')=ANY(p.polroles)
    AND pg_get_expr(p.polqual,p.polrelid)='true' AND pg_get_expr(p.polwithcheck,p.polrelid)='true')
 ) THEN RAISE EXCEPTION 'private_rls_contract: runtime policy missing'; END IF;
 IF EXISTS(
  SELECT 1 FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE r.rolname IN ('anon','authenticated','service_role') AND n.nspname='public' AND c.relkind='r'
   AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
 ) THEN RAISE EXCEPTION 'private_rls_contract: Data API grants forbidden'; END IF;
END $policy_contract$;
REVOKE ALL ON FUNCTION public.ajtool_validate_private_rls() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ajtool_validate_private_rls() TO :"runtime_role";
