-- Local docker-compose only. Never use these credentials outside local dev.
\set ON_ERROR_STOP on
\ir migrate.sql
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ajtool_runtime') AS create_runtime \gset
\if :create_runtime
CREATE ROLE ajtool_runtime LOGIN PASSWORD 'local-only-runtime';
\endif
\set runtime_role ajtool_runtime
\ir runtime-role.sql
