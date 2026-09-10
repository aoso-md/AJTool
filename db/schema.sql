-- =====================================================================
-- Quality Tools Workspace — database schema
-- ---------------------------------------------------------------------
-- You do NOT have to run this by hand. Each service creates its own
-- tables on startup (CREATE TABLE IF NOT EXISTS) as soon as DATABASE_URL
-- is set. This file exists so the schema is reviewable, reproducible,
-- and can be handed to [EXTERNAL_ADMIN]' team or a DBA without them having to read
-- JavaScript to find out what gets stored.
--
-- Apply manually (optional):
--   psql "$DATABASE_URL" -f db/schema.sql
--
-- Both tools share one `invocations` table, separated by the `tool`
-- column, so a single Postgres instance can back both services. The
-- bus-proxy uses its own `bus_events` table.
-- =====================================================================


-- ---------------------------------------------------------------------
-- invocations — one row per POST /events handled by a tool service.
-- Written by tools/calculate-cpk-ppk and tools/run-msa-analysis.
-- Failed and rejected calls are recorded too (ok = false), on purpose:
-- a rejected call is audit evidence that the contract was enforced, not
-- something to hide.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invocations (
  id              BIGSERIAL   PRIMARY KEY,

  -- Official broker tool ID: 'calculate_cpk_ppk' or 'run_msa_analysis'.
  -- See docs/OFFICIAL-EXTERNAL-ADMIN-CONTRACT.md — this is the platform-facing
  -- ID, never the local folder name.
  tool            TEXT        NOT NULL,

  -- Event type received, e.g. 'MEASUREMENTS_CAPTURED' or
  -- 'NEW_DEVICE_REGISTERED'.
  event_type      TEXT,

  -- Ties related events together across tools. Same value the platform
  -- sends; null when the caller didn't supply one.
  correlation_id  TEXT,

  -- false for validation errors, warnings, and crashes.
  ok              BOOLEAN     NOT NULL,

  -- 'completed' | 'validation-error' | 'warning'
  status          TEXT,

  -- Denormalised outcome for fast reading in the history UI:
  -- 'capable' | 'below-target' (Cpk/Ppk), 'acceptable' | 'not-acceptable' (MSA).
  -- Null when the call never reached a verdict.
  verdict         TEXT,

  -- The payload as received, and the full response as returned.
  request_payload JSONB,
  response_body   JSONB,

  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves GET /reports: newest-first, filtered by tool.
CREATE INDEX IF NOT EXISTS invocations_tool_id_idx ON invocations (tool, id DESC);

-- Serves "show me everything that happened for this correlation id".
CREATE INDEX IF NOT EXISTS invocations_correlation_idx ON invocations (correlation_id);


-- ---------------------------------------------------------------------
-- bus_events — one row per event published to the bus-proxy.
-- Written by bus-proxy/server.js. This is the durable twin of the
-- in-memory ledger that powers /events/subscriptions and /events/chain.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bus_events (
  id             BIGSERIAL   PRIMARY KEY,

  -- The proxy's own sequential id for the event ('bus-000001', ...).
  bus_id         TEXT,

  event_type     TEXT,

  -- Which tool or system published it.
  source         TEXT,

  correlation_id TEXT,

  -- The event that caused this one, when the publisher supplies it.
  causation_id   TEXT,

  payload        JSONB,

  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bus_events_type_idx ON bus_events (event_type, id DESC);
CREATE INDEX IF NOT EXISTS bus_events_correlation_idx ON bus_events (correlation_id);


-- ---------------------------------------------------------------------
-- Useful queries for a demo or an audit
-- ---------------------------------------------------------------------

-- Last 20 runs of the capability tool:
--   SELECT occurred_at, verdict, response_body->'result'->>'cpk' AS cpk
--   FROM invocations WHERE tool = 'calculate_cpk_ppk'
--   ORDER BY id DESC LIMIT 20;

-- Every processes that came out below target:
--   SELECT occurred_at, request_payload->>'partNumber' AS part,
--          response_body->'result'->>'cpk' AS cpk
--   FROM invocations
--   WHERE tool = 'calculate_cpk_ppk' AND verdict = 'below-target'
--   ORDER BY id DESC;

-- Rejected calls (contract enforcement evidence):
--   SELECT occurred_at, tool, status, response_body->'details' AS details
--   FROM invocations WHERE ok = false ORDER BY id DESC LIMIT 50;
