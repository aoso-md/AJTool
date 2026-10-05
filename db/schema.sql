-- =====================================================================
-- AJTool — database schema of the two federated tools
-- ---------------------------------------------------------------------
-- You do NOT need to run this. Each tool creates these tables on startup
-- (CREATE ... IF NOT EXISTS) as soon as DATABASE_URL is set — the source of
-- truth is SCHEMA_SQL in tools/<tool>/src/platform/store.js. This file exists
-- so the schema can be reviewed by the platform team or an auditor without
-- reading JavaScript.
--
--   psql "$DATABASE_URL" -f db/schema.sql      (optional, idempotent)
--
-- One Postgres can back both tools: rows are separated by `tool`, cursors by
-- name. The platform rule is one Railway project per tool, so in production
-- each tool normally has its own database anyway.
-- =====================================================================


-- ---------------------------------------------------------------------
-- studies — every study a tool computed or is waiting to compute.
--
-- This is the retained documented information of ISO 9001:2015 7.5.3.2 for
-- these tools: what was measured, against which spec version, by whom
-- (sealed from the verified session, never from the request body), the
-- result, and the exact event sent to the platform.
--
-- `doc` holds the whole study as JSON; the columns are what is indexed.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS studies (
  id             TEXT        PRIMARY KEY,

  -- 'calculate_cpk_ppk' | 'run_msa_analysis' (official broker ids).
  tool           TEXT        NOT NULL,

  -- completed | skipped (could not be computed: no spec, invalid data)
  -- | pending (MSA: gauge registered, readings not captured yet) | error
  status         TEXT        NOT NULL,

  -- event_id of the platform event that caused the study (MEASUREMENTS_CAPTURED
  -- / NEW_DEVICE_REGISTERED). NULL for studies entered by a person.
  input_event_id TEXT,

  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,

  -- Full study: input, spec used, result, warnings, actor, publication state
  -- and the published envelope.
  doc            JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS studies_tool_created_idx ON studies (tool, created_at DESC);

-- One study per platform event: processing the same event twice (restart,
-- replay) finds the existing study instead of creating a second one.
CREATE UNIQUE INDEX IF NOT EXISTS studies_tool_input_event_uidx
  ON studies (tool, input_event_id) WHERE input_event_id IS NOT NULL;


-- ---------------------------------------------------------------------
-- consumer_cursors — where each subscription is in the platform's log.
--
-- `subscription:<toolId>`         seq of the last event fully processed
-- `specs:PRODUCT_SPEC_UPDATED`    seq of the last spec event read (Cpk only)
--
-- Durable on purpose: the platform forbids starting a poll at since_seq=0
-- (it replays the backlog). With the cursor here, a restarted container
-- resumes exactly where it stopped instead of cold-starting at the tip and
-- silently skipping whatever arrived while it was down.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consumer_cursors (
  name       TEXT        PRIMARY KEY,
  seq        BIGINT      NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------
-- spec_cache — spec limits known to calculate_cpk_ppk.
--
-- MEASUREMENTS_CAPTURED does not carry USL/LSL; they come from
-- PRODUCT_SPEC_UPDATED (manage_product_specs). The newest event wins
-- (`source_seq`), so an older spec replayed later never overwrites a newer one.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spec_cache (
  part_id           TEXT             NOT NULL DEFAULT '',
  characteristic_id TEXT             NOT NULL,
  usl               DOUBLE PRECISION NOT NULL,
  lsl               DOUBLE PRECISION NOT NULL,
  version           TEXT,
  source_event_id   TEXT,
  source_seq        BIGINT,
  updated_at        TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (part_id, characteristic_id)
);


-- ---------------------------------------------------------------------
-- Useful queries for a review or an audit
-- ---------------------------------------------------------------------

-- Below-target capability studies and whether they reached the platform:
--   SELECT created_at, doc->>'partId' AS part, doc->>'characteristicId' AS characteristic,
--          doc->'result'->>'cpk' AS cpk, doc->'publish'->>'state' AS publish
--   FROM studies
--   WHERE tool = 'calculate_cpk_ppk' AND (doc->'result'->>'belowTarget')::boolean
--   ORDER BY created_at DESC;

-- Gauges registered but never studied (open MSA work):
--   SELECT created_at, doc->>'gaugeId' AS gauge
--   FROM studies WHERE tool = 'run_msa_analysis' AND status = 'pending'
--   ORDER BY created_at;

-- Who performed each MSA study, and the verdict:
--   SELECT updated_at, doc->>'gaugeId', doc->'actor'->>'name', doc->'actor'->>'role',
--          doc->'result'->>'verdict'
--   FROM studies WHERE tool = 'run_msa_analysis' AND status = 'completed';
