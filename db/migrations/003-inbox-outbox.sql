-- Migration 003: Transactional Inbox and Outbox architecture for AJTool.
-- Versioned, additive and non-destructive. Preserves 001 and 002.
SET search_path = public;

-- 1. Logical runtime identity per tool instance and execution mode
CREATE TABLE IF NOT EXISTS public.runtime_identity (
    tool TEXT PRIMARY KEY,
    environment TEXT NOT NULL DEFAULT 'production',
    publish_mode TEXT NOT NULL CHECK (publish_mode IN ('shadow', 'live')),
    schema_version TEXT NOT NULL,
    instance_id TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Additive monotonic generation counter on consumer_cursors
ALTER TABLE public.consumer_cursors ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1;

-- 3. Idempotent event inbox with content hash deduplication
CREATE TABLE IF NOT EXISTS public.event_inbox (
    tool TEXT NOT NULL,
    event_id TEXT NOT NULL,
    consumer TEXT NOT NULL,
    source_seq BIGINT,
    raw_input JSONB NOT NULL,
    canonical_input JSONB NOT NULL,
    input_hash TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('processed', 'rejected', 'ignored', 'conflict', 'quarantined')),
    study_id TEXT,
    error_detail TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    PRIMARY KEY (tool, event_id)
);
CREATE INDEX IF NOT EXISTS event_inbox_consumer_seq_idx ON public.event_inbox (tool, consumer, source_seq);
CREATE INDEX IF NOT EXISTS event_inbox_outcome_idx ON public.event_inbox (tool, outcome, received_at DESC);

-- 4. Durable business rejection audit ledger
CREATE TABLE IF NOT EXISTS public.event_rejections (
    rejection_id BIGSERIAL PRIMARY KEY,
    tool TEXT NOT NULL,
    event_id TEXT NOT NULL,
    code TEXT NOT NULL,
    reason TEXT NOT NULL,
    raw_input JSONB,
    input_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT event_rejections_inbox_fkey FOREIGN KEY (tool, event_id)
        REFERENCES public.event_inbox (tool, event_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS event_rejections_tool_event_idx ON public.event_rejections (tool, event_id);

-- 5. Outbox for guaranteed at-least-once delivery with cryptographically verified immutable envelopes
CREATE TABLE IF NOT EXISTS public.event_outbox (
    outbox_id BIGSERIAL PRIMARY KEY,
    tool TEXT NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    study_id TEXT,
    publication_key TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('shadow', 'live')),
    destination_id TEXT NOT NULL,
    envelope_text TEXT NOT NULL,
    envelope_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'blocked_auth', 'blocked_destination', 'retry_wait', 'quarantined', 'shadow_recorded')),
    next_attempt_at TIMESTAMPTZ,
    attempts INT NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    last_error_class TEXT,
    last_error_detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT event_outbox_tool_publication_key_key UNIQUE (tool, publication_key),
    CONSTRAINT event_outbox_envelope_hash_match CHECK (envelope_hash = encode(sha256(envelope_text::bytea), 'hex')),
    CONSTRAINT event_outbox_envelope_json_check CHECK (envelope_text IS JSON OBJECT),
    CONSTRAINT event_outbox_event_id_match CHECK (event_id = (envelope_text::jsonb ->> 'event_id')),
    CONSTRAINT event_outbox_tool_match CHECK (tool = (envelope_text::jsonb -> 'module' ->> 'id'))
);
CREATE INDEX IF NOT EXISTS event_outbox_claim_idx ON public.event_outbox (tool, destination_id, state, next_attempt_at, outbox_id);
CREATE INDEX IF NOT EXISTS event_outbox_study_idx ON public.event_outbox (tool, study_id);
CREATE INDEX IF NOT EXISTS event_outbox_state_idx ON public.event_outbox (tool, state, created_at DESC);

-- 6. Append-only delivery attempts ledger
CREATE TABLE IF NOT EXISTS public.outbox_attempts (
    id BIGSERIAL PRIMARY KEY,
    outbox_id BIGINT NOT NULL,
    attempt_no INT NOT NULL,
    lease_token TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    outcome TEXT,
    http_status INT,
    error_class TEXT,
    retry_after_seconds INT,
    CONSTRAINT outbox_attempts_outbox_fkey FOREIGN KEY (outbox_id)
        REFERENCES public.event_outbox (outbox_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS outbox_attempts_outbox_attempt_idx ON public.outbox_attempts (outbox_id, attempt_no);

-- 7. Idempotent manual UI commands ledger
CREATE TABLE IF NOT EXISTS public.manual_commands (
    tool TEXT NOT NULL,
    command_id TEXT NOT NULL,
    command_type TEXT NOT NULL,
    study_id TEXT,
    command_hash TEXT NOT NULL,
    outbox_id BIGINT,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'completed', 'rejected', 'conflict')),
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tool, command_id),
    CONSTRAINT manual_commands_outbox_fkey FOREIGN KEY (outbox_id)
        REFERENCES public.event_outbox (outbox_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS manual_commands_study_idx ON public.manual_commands (tool, study_id);

-- 8. Circuit breaker delivery gates per destination
CREATE TABLE IF NOT EXISTS public.delivery_gates (
    tool TEXT NOT NULL,
    destination TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
    auth_generation TEXT NOT NULL DEFAULT 'initial',
    next_probe_at TIMESTAMPTZ,
    reason TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tool, destination)
);

-- Immutability and audit integrity triggers
CREATE OR REPLACE FUNCTION public.ajtool_event_outbox_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $trig$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'event_outbox: deletion of outbox records is forbidden';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.outbox_id IS DISTINCT FROM NEW.outbox_id
       OR OLD.tool IS DISTINCT FROM NEW.tool
       OR OLD.event_id IS DISTINCT FROM NEW.event_id
       OR OLD.study_id IS DISTINCT FROM NEW.study_id
       OR OLD.publication_key IS DISTINCT FROM NEW.publication_key
       OR OLD.mode IS DISTINCT FROM NEW.mode
       OR OLD.destination_id IS DISTINCT FROM NEW.destination_id
       OR OLD.envelope_text IS DISTINCT FROM NEW.envelope_text
       OR OLD.envelope_hash IS DISTINCT FROM NEW.envelope_hash
       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
      RAISE EXCEPTION 'event_outbox: immutable publication fields cannot be modified';
    END IF;
    NEW.updated_at = now();
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$trig$;

DROP TRIGGER IF EXISTS event_outbox_immutable_update_trg ON public.event_outbox;
CREATE TRIGGER event_outbox_immutable_update_trg BEFORE UPDATE ON public.event_outbox FOR EACH ROW EXECUTE FUNCTION public.ajtool_event_outbox_immutable();

DROP TRIGGER IF EXISTS event_outbox_immutable_delete_trg ON public.event_outbox;
CREATE TRIGGER event_outbox_immutable_delete_trg BEFORE DELETE ON public.event_outbox FOR EACH ROW EXECUTE FUNCTION public.ajtool_event_outbox_immutable();

CREATE OR REPLACE FUNCTION public.ajtool_event_inbox_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $trig$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'event_inbox: deletion of inbox records is forbidden';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.tool IS DISTINCT FROM NEW.tool
       OR OLD.event_id IS DISTINCT FROM NEW.event_id
       OR OLD.consumer IS DISTINCT FROM NEW.consumer
       OR OLD.raw_input IS DISTINCT FROM NEW.raw_input
       OR OLD.canonical_input IS DISTINCT FROM NEW.canonical_input
       OR OLD.input_hash IS DISTINCT FROM NEW.input_hash
       OR OLD.received_at IS DISTINCT FROM NEW.received_at THEN
      RAISE EXCEPTION 'event_inbox: immutable identity and payload fields cannot be modified';
    END IF;
    IF OLD.outcome IS NOT NULL AND OLD.outcome IS DISTINCT FROM NEW.outcome THEN
      RAISE EXCEPTION 'event_inbox: terminal outcome cannot be modified';
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$trig$;

DROP TRIGGER IF EXISTS event_inbox_immutable_update_trg ON public.event_inbox;
CREATE TRIGGER event_inbox_immutable_update_trg BEFORE UPDATE ON public.event_inbox FOR EACH ROW EXECUTE FUNCTION public.ajtool_event_inbox_immutable();

DROP TRIGGER IF EXISTS event_inbox_immutable_delete_trg ON public.event_inbox;
CREATE TRIGGER event_inbox_immutable_delete_trg BEFORE DELETE ON public.event_inbox FOR EACH ROW EXECUTE FUNCTION public.ajtool_event_inbox_immutable();

CREATE OR REPLACE FUNCTION public.ajtool_event_rejections_readonly() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $trig$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'event_rejections: deletion of rejection records is forbidden';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'event_rejections: append-only table cannot be updated';
  END IF;
  RETURN NEW;
END;
$trig$;

DROP TRIGGER IF EXISTS event_rejections_readonly_update_trg ON public.event_rejections;
CREATE TRIGGER event_rejections_readonly_update_trg BEFORE UPDATE ON public.event_rejections FOR EACH ROW EXECUTE FUNCTION public.ajtool_event_rejections_readonly();

DROP TRIGGER IF EXISTS event_rejections_readonly_delete_trg ON public.event_rejections;
CREATE TRIGGER event_rejections_readonly_delete_trg BEFORE DELETE ON public.event_rejections FOR EACH ROW EXECUTE FUNCTION public.ajtool_event_rejections_readonly();

CREATE OR REPLACE FUNCTION public.ajtool_outbox_attempts_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $trig$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbox_attempts: deletion of attempt records is forbidden';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.id IS DISTINCT FROM NEW.id
       OR OLD.outbox_id IS DISTINCT FROM NEW.outbox_id
       OR OLD.attempt_no IS DISTINCT FROM NEW.attempt_no
       OR OLD.started_at IS DISTINCT FROM NEW.started_at
       OR OLD.lease_token IS DISTINCT FROM NEW.lease_token THEN
      RAISE EXCEPTION 'outbox_attempts: attempt identity fields cannot be modified';
    END IF;
    IF OLD.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'outbox_attempts: completed attempt cannot be modified';
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$trig$;

DROP TRIGGER IF EXISTS outbox_attempts_guard_update_trg ON public.outbox_attempts;
CREATE TRIGGER outbox_attempts_guard_update_trg BEFORE UPDATE ON public.outbox_attempts FOR EACH ROW EXECUTE FUNCTION public.ajtool_outbox_attempts_guard();

DROP TRIGGER IF EXISTS outbox_attempts_guard_delete_trg ON public.outbox_attempts;
CREATE TRIGGER outbox_attempts_guard_delete_trg BEFORE DELETE ON public.outbox_attempts FOR EACH ROW EXECUTE FUNCTION public.ajtool_outbox_attempts_guard();

CREATE OR REPLACE FUNCTION public.ajtool_manual_commands_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $trig$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'manual_commands: deletion of manual commands is forbidden';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.tool IS DISTINCT FROM NEW.tool
       OR OLD.command_id IS DISTINCT FROM NEW.command_id
       OR OLD.command_type IS DISTINCT FROM NEW.command_type
       OR OLD.command_hash IS DISTINCT FROM NEW.command_hash
       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
      RAISE EXCEPTION 'manual_commands: immutable command fields cannot be modified';
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$trig$;

DROP TRIGGER IF EXISTS manual_commands_guard_update_trg ON public.manual_commands;
CREATE TRIGGER manual_commands_guard_update_trg BEFORE UPDATE ON public.manual_commands FOR EACH ROW EXECUTE FUNCTION public.ajtool_manual_commands_guard();

DROP TRIGGER IF EXISTS manual_commands_guard_delete_trg ON public.manual_commands;
CREATE TRIGGER manual_commands_guard_delete_trg BEFORE DELETE ON public.manual_commands FOR EACH ROW EXECUTE FUNCTION public.ajtool_manual_commands_guard();

CREATE OR REPLACE FUNCTION public.ajtool_delivery_gates_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $trig$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'delivery_gates: deletion of delivery gates is forbidden';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.tool IS DISTINCT FROM NEW.tool
       OR OLD.destination IS DISTINCT FROM NEW.destination THEN
      RAISE EXCEPTION 'delivery_gates: gate key fields cannot be modified';
    END IF;
    NEW.updated_at = now();
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$trig$;

DROP TRIGGER IF EXISTS delivery_gates_guard_update_trg ON public.delivery_gates;
CREATE TRIGGER delivery_gates_guard_update_trg BEFORE UPDATE ON public.delivery_gates FOR EACH ROW EXECUTE FUNCTION public.ajtool_delivery_gates_guard();

DROP TRIGGER IF EXISTS delivery_gates_guard_delete_trg ON public.delivery_gates;
CREATE TRIGGER delivery_gates_guard_delete_trg BEFORE DELETE ON public.delivery_gates FOR EACH ROW EXECUTE FUNCTION public.ajtool_delivery_gates_guard();

REVOKE ALL ON FUNCTION public.ajtool_event_outbox_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ajtool_event_inbox_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ajtool_event_rejections_readonly() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ajtool_outbox_attempts_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ajtool_manual_commands_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ajtool_delivery_gates_guard() FROM PUBLIC;

-- Updated schema contract validator incorporating inbox/outbox entities
CREATE OR REPLACE FUNCTION public.ajtool_validate_schema() RETURNS void
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
    ('consumer_cursors','generation','bigint',true),
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
    ('schema_migrations','checksum','text',true),
    ('runtime_identity','tool','text',true),
    ('runtime_identity','environment','text',true),
    ('runtime_identity','publish_mode','text',true),
    ('runtime_identity','schema_version','text',true),
    ('runtime_identity','instance_id','text',false),
    ('runtime_identity','updated_at','timestamp with time zone',true),
    ('event_inbox','tool','text',true),
    ('event_inbox','event_id','text',true),
    ('event_inbox','consumer','text',true),
    ('event_inbox','source_seq','bigint',false),
    ('event_inbox','raw_input','jsonb',true),
    ('event_inbox','canonical_input','jsonb',true),
    ('event_inbox','input_hash','text',true),
    ('event_inbox','outcome','text',true),
    ('event_inbox','study_id','text',false),
    ('event_inbox','error_detail','text',false),
    ('event_inbox','received_at','timestamp with time zone',true),
    ('event_inbox','processed_at','timestamp with time zone',false),
    ('event_rejections','rejection_id','bigint',true),
    ('event_rejections','tool','text',true),
    ('event_rejections','event_id','text',true),
    ('event_rejections','code','text',true),
    ('event_rejections','reason','text',true),
    ('event_rejections','raw_input','jsonb',false),
    ('event_rejections','input_hash','text',false),
    ('event_rejections','created_at','timestamp with time zone',true),
    ('event_outbox','outbox_id','bigint',true),
    ('event_outbox','tool','text',true),
    ('event_outbox','event_id','text',true),
    ('event_outbox','study_id','text',false),
    ('event_outbox','publication_key','text',true),
    ('event_outbox','mode','text',true),
    ('event_outbox','destination_id','text',true),
    ('event_outbox','envelope_text','text',true),
    ('event_outbox','envelope_hash','text',true),
    ('event_outbox','state','text',true),
    ('event_outbox','next_attempt_at','timestamp with time zone',false),
    ('event_outbox','attempts','integer',true),
    ('event_outbox','lease_token','text',false),
    ('event_outbox','lease_until','timestamp with time zone',false),
    ('event_outbox','delivered_at','timestamp with time zone',false),
    ('event_outbox','last_error_class','text',false),
    ('event_outbox','last_error_detail','text',false),
    ('event_outbox','created_at','timestamp with time zone',true),
    ('event_outbox','updated_at','timestamp with time zone',true),
    ('outbox_attempts','id','bigint',true),
    ('outbox_attempts','outbox_id','bigint',true),
    ('outbox_attempts','attempt_no','integer',true),
    ('outbox_attempts','lease_token','text',false),
    ('outbox_attempts','started_at','timestamp with time zone',true),
    ('outbox_attempts','finished_at','timestamp with time zone',false),
    ('outbox_attempts','outcome','text',false),
    ('outbox_attempts','http_status','integer',false),
    ('outbox_attempts','error_class','text',false),
    ('outbox_attempts','retry_after_seconds','integer',false),
    ('manual_commands','tool','text',true),
    ('manual_commands','command_id','text',true),
    ('manual_commands','command_type','text',true),
    ('manual_commands','study_id','text',false),
    ('manual_commands','command_hash','text',true),
    ('manual_commands','outbox_id','bigint',false),
    ('manual_commands','status','text',true),
    ('manual_commands','result','jsonb',false),
    ('manual_commands','created_at','timestamp with time zone',true),
    ('delivery_gates','tool','text',true),
    ('delivery_gates','destination','text',true),
    ('delivery_gates','state','text',true),
    ('delivery_gates','auth_generation','text',true),
    ('delivery_gates','next_probe_at','timestamp with time zone',false),
    ('delivery_gates','reason','text',false),
    ('delivery_gates','updated_at','timestamp with time zone',true)
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
    ('studies','consumer_cursors','spec_cache','settings','settings_history','schema_migrations',
     'runtime_identity','event_inbox','event_rejections','event_outbox','outbox_attempts','manual_commands','delivery_gates')
    AND (c.relkind<>'r' OR c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition
      OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)) LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'schema_contract: table % must be an ordinary table without RLS or inheritance',bad; END IF;

  WITH expected(table_name,constraint_name,contype,definition) AS (VALUES
    ('consumer_cursors','consumer_cursors_pkey','p','PRIMARY KEY (name)'),
    ('delivery_gates','delivery_gates_pkey','p','PRIMARY KEY (tool, destination)'),
    ('delivery_gates','delivery_gates_state_check','c','CHECK ((state = ANY (ARRAY[''open''::text, ''closed''::text])))'),
    ('event_inbox','event_inbox_outcome_check','c','CHECK ((outcome = ANY (ARRAY[''processed''::text, ''rejected''::text, ''ignored''::text, ''conflict''::text, ''quarantined''::text])))'),
    ('event_inbox','event_inbox_pkey','p','PRIMARY KEY (tool, event_id)'),
    ('event_outbox','event_outbox_envelope_hash_match','c','CHECK ((envelope_hash = encode(sha256((envelope_text)::bytea), ''hex''::text)))'),
    ('event_outbox','event_outbox_envelope_json_check','c','CHECK ((envelope_text IS JSON OBJECT))'),
    ('event_outbox','event_outbox_event_id_key','u','UNIQUE (event_id)'),
    ('event_outbox','event_outbox_event_id_match','c','CHECK ((event_id = ((envelope_text)::jsonb ->> ''event_id''::text)))'),
    ('event_outbox','event_outbox_mode_check','c','CHECK ((mode = ANY (ARRAY[''shadow''::text, ''live''::text])))'),
    ('event_outbox','event_outbox_pkey','p','PRIMARY KEY (outbox_id)'),
    ('event_outbox','event_outbox_state_check','c','CHECK ((state = ANY (ARRAY[''pending''::text, ''delivering''::text, ''delivered''::text, ''blocked_auth''::text, ''blocked_destination''::text, ''retry_wait''::text, ''quarantined''::text, ''shadow_recorded''::text])))'),
    ('event_outbox','event_outbox_tool_match','c','CHECK ((tool = (((envelope_text)::jsonb -> ''module''::text) ->> ''id''::text)))'),
    ('event_outbox','event_outbox_tool_publication_key_key','u','UNIQUE (tool, publication_key)'),
    ('event_rejections','event_rejections_inbox_fkey','f','FOREIGN KEY (tool, event_id) REFERENCES event_inbox(tool, event_id) ON DELETE RESTRICT'),
    ('event_rejections','event_rejections_pkey','p','PRIMARY KEY (rejection_id)'),
    ('manual_commands','manual_commands_outbox_fkey','f','FOREIGN KEY (outbox_id) REFERENCES event_outbox(outbox_id) ON DELETE RESTRICT'),
    ('manual_commands','manual_commands_pkey','p','PRIMARY KEY (tool, command_id)'),
    ('manual_commands','manual_commands_status_check','c','CHECK ((status = ANY (ARRAY[''accepted''::text, ''completed''::text, ''rejected''::text, ''conflict''::text])))'),
    ('outbox_attempts','outbox_attempts_outbox_fkey','f','FOREIGN KEY (outbox_id) REFERENCES event_outbox(outbox_id) ON DELETE RESTRICT'),
    ('outbox_attempts','outbox_attempts_pkey','p','PRIMARY KEY (id)'),
    ('runtime_identity','runtime_identity_pkey','p','PRIMARY KEY (tool)'),
    ('runtime_identity','runtime_identity_publish_mode_check','c','CHECK ((publish_mode = ANY (ARRAY[''shadow''::text, ''live''::text])))'),
    ('schema_migrations','schema_migrations_pkey','p','PRIMARY KEY (version)'),
    ('settings','settings_pkey','p','PRIMARY KEY (key)'),
    ('settings_history','settings_history_pkey','p','PRIMARY KEY (id)'),
    ('spec_cache','spec_cache_pkey','p','PRIMARY KEY (part_id, characteristic_id)'),
    ('studies','studies_pkey','p','PRIMARY KEY (id)')
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
    WHERE e.definition IS DISTINCT FROM a.definition OR a.contype IS DISTINCT FROM e.contype
      OR NOT a.convalidated OR a.condeferrable OR a.condeferred LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'schema_contract: constraint % incompatible or missing',bad; END IF;

  WITH expected(index_name,definition) AS (VALUES
    ('consumer_cursors_pkey','CREATE UNIQUE INDEX consumer_cursors_pkey ON public.consumer_cursors USING btree (name)'),
    ('delivery_gates_pkey','CREATE UNIQUE INDEX delivery_gates_pkey ON public.delivery_gates USING btree (tool, destination)'),
    ('event_inbox_consumer_seq_idx','CREATE INDEX event_inbox_consumer_seq_idx ON public.event_inbox USING btree (tool, consumer, source_seq)'),
    ('event_inbox_outcome_idx','CREATE INDEX event_inbox_outcome_idx ON public.event_inbox USING btree (tool, outcome, received_at DESC)'),
    ('event_inbox_pkey','CREATE UNIQUE INDEX event_inbox_pkey ON public.event_inbox USING btree (tool, event_id)'),
    ('event_outbox_claim_idx','CREATE INDEX event_outbox_claim_idx ON public.event_outbox USING btree (tool, destination_id, state, next_attempt_at, outbox_id)'),
    ('event_outbox_event_id_key','CREATE UNIQUE INDEX event_outbox_event_id_key ON public.event_outbox USING btree (event_id)'),
    ('event_outbox_pkey','CREATE UNIQUE INDEX event_outbox_pkey ON public.event_outbox USING btree (outbox_id)'),
    ('event_outbox_state_idx','CREATE INDEX event_outbox_state_idx ON public.event_outbox USING btree (tool, state, created_at DESC)'),
    ('event_outbox_study_idx','CREATE INDEX event_outbox_study_idx ON public.event_outbox USING btree (tool, study_id)'),
    ('event_outbox_tool_publication_key_key','CREATE UNIQUE INDEX event_outbox_tool_publication_key_key ON public.event_outbox USING btree (tool, publication_key)'),
    ('event_rejections_pkey','CREATE UNIQUE INDEX event_rejections_pkey ON public.event_rejections USING btree (rejection_id)'),
    ('event_rejections_tool_event_idx','CREATE INDEX event_rejections_tool_event_idx ON public.event_rejections USING btree (tool, event_id)'),
    ('manual_commands_pkey','CREATE UNIQUE INDEX manual_commands_pkey ON public.manual_commands USING btree (tool, command_id)'),
    ('manual_commands_study_idx','CREATE INDEX manual_commands_study_idx ON public.manual_commands USING btree (tool, study_id)'),
    ('outbox_attempts_outbox_attempt_idx','CREATE INDEX outbox_attempts_outbox_attempt_idx ON public.outbox_attempts USING btree (outbox_id, attempt_no)'),
    ('outbox_attempts_pkey','CREATE UNIQUE INDEX outbox_attempts_pkey ON public.outbox_attempts USING btree (id)'),
    ('runtime_identity_pkey','CREATE UNIQUE INDEX runtime_identity_pkey ON public.runtime_identity USING btree (tool)'),
    ('schema_migrations_pkey','CREATE UNIQUE INDEX schema_migrations_pkey ON public.schema_migrations USING btree (version)'),
    ('settings_history_key_idx','CREATE INDEX settings_history_key_idx ON public.settings_history USING btree (key, id DESC)'),
    ('settings_history_pkey','CREATE UNIQUE INDEX settings_history_pkey ON public.settings_history USING btree (id)'),
    ('settings_pkey','CREATE UNIQUE INDEX settings_pkey ON public.settings USING btree (key)'),
    ('spec_cache_pkey','CREATE UNIQUE INDEX spec_cache_pkey ON public.spec_cache USING btree (part_id, characteristic_id)'),
    ('studies_pkey','CREATE UNIQUE INDEX studies_pkey ON public.studies USING btree (id)'),
    ('studies_tool_created_idx','CREATE INDEX studies_tool_created_idx ON public.studies USING btree (tool, created_at DESC)'),
    ('studies_tool_input_event_uidx','CREATE UNIQUE INDEX studies_tool_input_event_uidx ON public.studies USING btree (tool, input_event_id) WHERE (input_event_id IS NOT NULL)')
  ), actual AS (
    SELECT c.relname::text AS index_name, pg_get_indexdef(c.oid) AS definition,
      i.indisvalid,i.indisready,i.indislive,i.indimmediate
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname IN
      ('studies','consumer_cursors','spec_cache','settings','settings_history','schema_migrations',
       'runtime_identity','event_inbox','event_rejections','event_outbox','outbox_attempts','manual_commands','delivery_gates')
  )
  SELECT coalesce(e.index_name,a.index_name) INTO bad FROM expected e FULL JOIN actual a USING(index_name)
    WHERE a.definition IS DISTINCT FROM e.definition
      OR NOT a.indisvalid OR NOT a.indisready OR NOT a.indislive OR NOT a.indimmediate LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'schema_contract: index % incompatible or missing',bad; END IF;

  IF pg_get_serial_sequence('public.settings_history','id') IS DISTINCT FROM 'public.settings_history_id_seq'
    OR NOT EXISTS (SELECT 1 FROM pg_sequence WHERE seqrelid=to_regclass('public.settings_history_id_seq')
      AND seqtypid='bigint'::regtype AND seqincrement=1 AND seqmin=1
      AND seqmax=9223372036854775807 AND NOT seqcycle) THEN
    RAISE EXCEPTION 'schema_contract: settings_history sequence incompatible or missing';
  END IF;

  IF pg_get_serial_sequence('public.event_rejections','rejection_id') IS DISTINCT FROM 'public.event_rejections_rejection_id_seq'
    OR NOT EXISTS (SELECT 1 FROM pg_sequence WHERE seqrelid=to_regclass('public.event_rejections_rejection_id_seq')
      AND seqtypid='bigint'::regtype AND seqincrement=1 AND seqmin=1
      AND seqmax=9223372036854775807 AND NOT seqcycle) THEN
    RAISE EXCEPTION 'schema_contract: event_rejections sequence incompatible or missing';
  END IF;

  IF pg_get_serial_sequence('public.event_outbox','outbox_id') IS DISTINCT FROM 'public.event_outbox_outbox_id_seq'
    OR NOT EXISTS (SELECT 1 FROM pg_sequence WHERE seqrelid=to_regclass('public.event_outbox_outbox_id_seq')
      AND seqtypid='bigint'::regtype AND seqincrement=1 AND seqmin=1
      AND seqmax=9223372036854775807 AND NOT seqcycle) THEN
    RAISE EXCEPTION 'schema_contract: event_outbox sequence incompatible or missing';
  END IF;

  IF pg_get_serial_sequence('public.outbox_attempts','id') IS DISTINCT FROM 'public.outbox_attempts_id_seq'
    OR NOT EXISTS (SELECT 1 FROM pg_sequence WHERE seqrelid=to_regclass('public.outbox_attempts_id_seq')
      AND seqtypid='bigint'::regtype AND seqincrement=1 AND seqmin=1
      AND seqmax=9223372036854775807 AND NOT seqcycle) THEN
    RAISE EXCEPTION 'schema_contract: outbox_attempts sequence incompatible or missing';
  END IF;

  WITH expected(table_name,column_name,definition) AS (VALUES
    ('consumer_cursors','generation','1'),
    ('consumer_cursors','updated_at','now()'),
    ('delivery_gates','auth_generation',quote_literal('initial')||'::text'),
    ('delivery_gates','updated_at','now()'),
    ('event_inbox','received_at','now()'),
    ('event_outbox','attempts','0'),
    ('event_outbox','created_at','now()'),
    ('event_outbox','outbox_id','nextval('||quote_literal('event_outbox_outbox_id_seq')||'::regclass)'),
    ('event_outbox','updated_at','now()'),
    ('event_rejections','created_at','now()'),
    ('event_rejections','rejection_id','nextval('||quote_literal('event_rejections_rejection_id_seq')||'::regclass)'),
    ('manual_commands','created_at','now()'),
    ('outbox_attempts','id','nextval('||quote_literal('outbox_attempts_id_seq')||'::regclass)'),
    ('outbox_attempts','started_at','now()'),
    ('runtime_identity','environment',quote_literal('production')||'::text'),
    ('runtime_identity','updated_at','now()'),
    ('schema_migrations','applied_at','now()'),
    ('schema_migrations','checksum',quote_literal('')||'::text'),
    ('settings_history','id','nextval('||quote_literal('settings_history_id_seq')||'::regclass)'),
    ('spec_cache','part_id',quote_literal('')||'::text'),
    ('spec_cache','updated_at','now()')
  )
  SELECT e.table_name||'.'||e.column_name INTO bad FROM expected e
    JOIN pg_attribute a ON a.attrelid=to_regclass('public.'||e.table_name) AND a.attname=e.column_name
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE pg_get_expr(d.adbin,d.adrelid) IS DISTINCT FROM e.definition LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'schema_contract: default % incompatible or missing',bad; END IF;
END
$contract$;
REVOKE ALL ON FUNCTION public.ajtool_validate_schema() FROM PUBLIC;
