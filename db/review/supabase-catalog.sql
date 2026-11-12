-- Authenticated project catalog only; no business rows, DDL or permission changes.
SELECT jsonb_build_object(
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'type',data_type,'nullable',is_nullable) ORDER BY table_name,ordinal_position) FROM information_schema.columns WHERE table_schema='public'),
 'public_functions',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',p.proname,'security_definer',p.prosecdef)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),'[]'::jsonb),
 'policies',COALESCE((SELECT jsonb_agg(jsonb_build_object('table',tablename,'policy',policyname,'roles',roles,'command',cmd)) FROM pg_policies WHERE schemaname='public'),'[]'::jsonb),
 'runtime_memberships',COALESCE((SELECT jsonb_agg(parent.rolname) FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member JOIN pg_roles parent ON parent.oid=m.roleid WHERE member.rolname='ajtool_service'),'[]'::jsonb),
 'data_api_privileges',COALESCE((SELECT jsonb_agg(jsonb_build_object('role',r.rolname,'table',c.relname,'select',has_table_privilege(r.oid,c.oid,'SELECT'),'mutate',has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND r.rolname IN ('anon','authenticated','service_role')),'[]'::jsonb)
)::text AS ajtool_catalog;
