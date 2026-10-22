-- Additive migration: never rewrite 001 or repair/deduplicate incompatible data.
ALTER TABLE public.schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT '';

-- Shared contract used by the explicit migrator and both runtime tools.
-- SECURITY INVOKER: validation never elevates the runtime role.
CREATE FUNCTION public.ajtool_validate_schema() RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $contract$
DECLARE bad text;
BEGIN
  WITH expected(table_name,column_name,type_name,not_null) AS (VALUES
    ('studies','id','text',true),
    ('studies','tool','text',true),
    ('studies','status','text',true),
    ('studies','input_event_id','text',false),
    ('studies','created_at','timestamp with time zone',true),
    ('studies','updated_at','timestamp with time zone',true),
    ('studies','doc','jsonb',true),
    ('consumer_cursors','name','text',true),
    ('consumer_cursors','seq','bigint',true),
    ('consumer_cursors','updated_at','timestamp with time zone',true),
    ('spec_cache','part_id','text',true),
    ('spec_cache','characteristic_id','text',true),
    ('spec_cache','usl','double precision',true),
    ('spec_cache','lsl','double precision',true),
    ('spec_cache','version','text',false),
    ('spec_cache','source_event_id','text',false),
    ('spec_cache','source_seq','bigint',false),
    ('spec_cache','updated_at','timestamp with time zone',true),
    ('settings','key','text',true),
    ('settings','doc','jsonb',true),
    ('settings','version','integer',true),
    ('settings','updated_at','timestamp with time zone',true),
    ('settings','updated_by','jsonb',false),
    ('settings','reason','text',false),
    ('settings_history','id','bigint',true),
    ('settings_history','key','text',true),
    ('settings_history','version','integer',true),
    ('settings_history','before','jsonb',false),
    ('settings_history','after','jsonb',true),
    ('settings_history','reason','text',false),
    ('settings_history','actor','jsonb',false),
    ('settings_history','at','timestamp with time zone',true),
    ('schema_migrations','version','text',true),
    ('schema_migrations','applied_at','timestamp with time zone',true),
    ('schema_migrations','checksum','text',true)
  ), actual AS (
    SELECT c.relname::text AS table_name, a.attname::text AS column_name,
      format_type(a.atttypid,a.atttypmod) AS type_name, a.attnotnull AS not_null,
      a.attgenerated AS generated, a.attidentity AS identity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relname IN (SELECT table_name FROM expected)
  )
  SELECT coalesce(e.table_name,a.table_name)||'.'||coalesce(e.column_name,a.column_name)
    INTO bad FROM expected e FULL JOIN actual a USING(table_name,column_name)
    WHERE e.type_name IS DISTINCT FROM a.type_name OR e.not_null IS DISTINCT FROM a.not_null
      OR coalesce(a.generated,'')<>'' OR coalesce(a.identity,'')<>'' LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'schema_contract: column % incompatible or missing',bad; END IF;

  SELECT c.relname INTO bad FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN
    ('studies','consumer_cursors','spec_cache','settings','settings_history','schema_migrations')
    AND (c.relkind<>'r' OR c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition
      OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)) LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'schema_contract: table % must be an ordinary table without RLS or inheritance',bad; END IF;

  WITH expected(table_name,constraint_name,definition) AS (VALUES
    ('studies','studies_pkey','PRIMARY KEY (id)'),
    ('consumer_cursors','consumer_cursors_pkey','PRIMARY KEY (name)'),
    ('spec_cache','spec_cache_pkey','PRIMARY KEY (part_id, characteristic_id)'),
    ('settings','settings_pkey','PRIMARY KEY (key)'),
    ('settings_history','settings_history_pkey','PRIMARY KEY (id)'),
    ('schema_migrations','schema_migrations_pkey','PRIMARY KEY (version)')
  ), actual AS (
    SELECT c.relname::text AS table_name, k.conname::text AS constraint_name,
      pg_get_constraintdef(k.oid) AS definition, k.contype, k.convalidated,
      k.condeferrable, k.condeferred
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN (SELECT table_name FROM expected)
  )
  SELECT coalesce(e.constraint_name,a.constraint_name) INTO bad
    FROM expected e FULL JOIN actual a USING(table_name,constraint_name)
    WHERE e.definition IS DISTINCT FROM a.definition OR a.contype<>'p'
      OR NOT a.convalidated OR a.condeferrable OR a.condeferred LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'schema_contract: constraint % incompatible or missing',bad; END IF;

  WITH expected(index_name,definition) AS (VALUES
    ('studies_pkey','CREATE UNIQUE INDEX studies_pkey ON public.studies USING btree (id)'),
    ('consumer_cursors_pkey','CREATE UNIQUE INDEX consumer_cursors_pkey ON public.consumer_cursors USING btree (name)'),
    ('spec_cache_pkey','CREATE UNIQUE INDEX spec_cache_pkey ON public.spec_cache USING btree (part_id, characteristic_id)'),
    ('settings_pkey','CREATE UNIQUE INDEX settings_pkey ON public.settings USING btree (key)'),
    ('settings_history_pkey','CREATE UNIQUE INDEX settings_history_pkey ON public.settings_history USING btree (id)'),
    ('schema_migrations_pkey','CREATE UNIQUE INDEX schema_migrations_pkey ON public.schema_migrations USING btree (version)'),
    ('studies_tool_created_idx','CREATE INDEX studies_tool_created_idx ON public.studies USING btree (tool, created_at DESC)'),
    ('studies_tool_input_event_uidx','CREATE UNIQUE INDEX studies_tool_input_event_uidx ON public.studies USING btree (tool, input_event_id) WHERE (input_event_id IS NOT NULL)'),
    ('settings_history_key_idx','CREATE INDEX settings_history_key_idx ON public.settings_history USING btree (key, id DESC)')
  ), actual AS (
    SELECT c.relname::text AS index_name, pg_get_indexdef(c.oid) AS definition,
      i.indisvalid,i.indisready,i.indislive,i.indimmediate
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname IN
      ('studies','consumer_cursors','spec_cache','settings','settings_history','schema_migrations')
  )
  SELECT coalesce(e.index_name,a.index_name) INTO bad FROM expected e FULL JOIN actual a USING(index_name)
    WHERE a.definition IS DISTINCT FROM e.definition
      OR NOT a.indisvalid OR NOT a.indisready OR NOT a.indislive OR NOT a.indimmediate LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'schema_contract: index % incompatible or missing',bad; END IF;

  IF pg_get_serial_sequence('public.settings_history','id') IS DISTINCT FROM 'public.settings_history_id_seq'
    OR NOT EXISTS (SELECT 1 FROM pg_sequence WHERE seqrelid=to_regclass('public.settings_history_id_seq')
      AND seqtypid='bigint'::regtype AND seqincrement=1 AND seqmin=1
      AND seqmax=9223372036854775807 AND NOT seqcycle) THEN
    RAISE EXCEPTION 'schema_contract: history sequence incompatible or missing';
  END IF;
  WITH expected(table_name,column_name,definition) AS (VALUES
    ('consumer_cursors','updated_at','now()'),
    ('spec_cache','part_id',quote_literal('')||'::text'),
    ('spec_cache','updated_at','now()'),
    ('schema_migrations','applied_at','now()'),
    ('schema_migrations','checksum',quote_literal('')||'::text'),
    ('settings_history','id','nextval('||quote_literal('settings_history_id_seq')||'::regclass)')
  )
  SELECT e.table_name||'.'||e.column_name INTO bad FROM expected e
    JOIN pg_attribute a ON a.attrelid=to_regclass('public.'||e.table_name) AND a.attname=e.column_name
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE pg_get_expr(d.adbin,d.adrelid) IS DISTINCT FROM e.definition LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'schema_contract: default % incompatible or missing',bad; END IF;
END
$contract$;
REVOKE ALL ON FUNCTION public.ajtool_validate_schema() FROM PUBLIC;
