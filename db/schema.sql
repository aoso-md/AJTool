-- Compatibility entrypoint; run with psql as migration owner, never at runtime.
\set ON_ERROR_STOP on
\ir migrate.sql
