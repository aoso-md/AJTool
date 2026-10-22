CREATE TABLE IF NOT EXISTS studies (
    id             TEXT        PRIMARY KEY,
    tool           TEXT        NOT NULL,
    status         TEXT        NOT NULL,
    input_event_id TEXT,
    created_at     TIMESTAMPTZ NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL,
    doc            JSONB       NOT NULL
  );
  CREATE INDEX IF NOT EXISTS studies_tool_created_idx ON studies (tool, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS studies_tool_input_event_uidx
    ON studies (tool, input_event_id) WHERE input_event_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS consumer_cursors (
    name       TEXT        PRIMARY KEY,
    seq        BIGINT      NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS spec_cache (
    part_id           TEXT        NOT NULL DEFAULT '',
    characteristic_id TEXT        NOT NULL,
    usl               DOUBLE PRECISION NOT NULL,
    lsl               DOUBLE PRECISION NOT NULL,
    version           TEXT,
    source_event_id   TEXT,
    source_seq        BIGINT,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (part_id, characteristic_id)
  );

  -- Acceptance criteria (minimum Cpk, %GRR limits…). One current row per key,
  -- plus an append-only history: who changed what, from what, and why.
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT        PRIMARY KEY,
    doc        JSONB       NOT NULL,
    version    INTEGER     NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    updated_by JSONB,
    reason     TEXT
  );

  CREATE TABLE IF NOT EXISTS settings_history (
    id      BIGSERIAL   PRIMARY KEY,
    key     TEXT        NOT NULL,
    version INTEGER     NOT NULL,
    before  JSONB,
    after   JSONB       NOT NULL,
    reason  TEXT,
    actor   JSONB,
    at      TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS settings_history_key_idx ON settings_history (key, id DESC);
