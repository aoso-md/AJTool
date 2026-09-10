"use strict";

/* =====================================================================
   calculate_cpk_ppk — invocation history, two honest tiers
   ---------------------------------------------------------------------
   TIER 1 — memory (always on, zero config):
     A ring buffer of the last 100 invocations. Wiped on restart, but it
     means GET /reports works the moment the container boots, with no
     database provisioned. Reported as "memory (volatile)".

   TIER 2 — postgres (when DATABASE_URL is set):
     Every invocation is ALSO written to the `invocations` table, so the
     history survives restarts and redeploys. Reported as
     "postgres (durable)".

   /health and /reports always state which tier is actually live. They
   never claim durability that isn't there — same honesty rule as
   bus-proxy's LOCAL/CONNECTED split.

   ---------------------------------------------------------------------
   DESIGN RULE: persistence must never take the service down.

   This is not a theoretical concern. A `pg` Pool emits an 'error' event
   when an IDLE connection dies (Postgres restarts, Railway recycles the
   instance, network blip, idle timeout). On an EventEmitter, an 'error'
   event with no listener is thrown as an uncaught exception — Node exits
   — and the service reads as "offline" even though the HTTP code is
   perfectly fine. That is exactly the failure mode this project has been
   fighting, so: the pool has an error listener, every query is wrapped,
   and a database outage degrades to memory-only instead of failing the
   request or killing the process.
   ===================================================================== */

/* `pg` is required lazily, only when DATABASE_URL is actually set. Two
   reasons: (1) with no database configured the service keeps its original
   zero-dependency property — it runs from a bare checkout with no
   `npm install`, which is how the CLI, the tests, and local demos are
   used; (2) if `npm install` ever fails in an image build, the service
   still boots and serves instead of dying at require-time on a feature
   nobody asked for. A missing module degrades to memory-only history. */
const TOOL = "calculate_cpk_ppk";
const DATABASE_URL = process.env.DATABASE_URL || "";
const configured = !!DATABASE_URL;

/* ---- tier 1: in-memory ring buffer ---- */
const MEMORY_LIMIT = 100;
const memory = [];
let memSeq = 0;

function pushMemory(row) {
  memory.unshift(row);
  if (memory.length > MEMORY_LIMIT) memory.length = MEMORY_LIMIT;
}

/* ---- tier 2: postgres ---- */
let pool = null;
let ready = Promise.resolve();
let dbHealthy = false;
let lastDbError = null;

/* Railway's private network (*.railway.internal) is unencrypted by
   design and rejects SSL; its public proxy requires SSL but presents a
   self-signed cert. Local Postgres needs neither. Pick per host instead
   of forcing one setting everywhere. */
function sslFor(connectionString) {
  const isInternal = /\.railway\.internal/i.test(connectionString);
  const isLocal = /@(localhost|127\.0\.0\.1)/i.test(connectionString);
  if (isInternal || isLocal) return false;
  return { rejectUnauthorized: false };
}

let Pool = null;
if (configured) {
  try {
    Pool = require("pg").Pool;
  } catch (err) {
    console.error("db: DATABASE_URL is set but the 'pg' module isn't installed — history stays in memory. Run npm install.");
  }
}

if (configured && Pool) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: sslFor(DATABASE_URL),
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  // THE critical listener — see DESIGN RULE above. Without this, a dead
  // idle client crashes the whole process.
  pool.on("error", (err) => {
    dbHealthy = false;
    lastDbError = err.message;
    console.error("db: idle client error (service stays up, history falls back to memory) —", err.message);
  });

  ready = pool
    .query(`
      CREATE TABLE IF NOT EXISTS invocations (
        id              BIGSERIAL PRIMARY KEY,
        tool            TEXT        NOT NULL,
        event_type      TEXT,
        correlation_id  TEXT,
        ok              BOOLEAN     NOT NULL,
        status          TEXT,
        verdict         TEXT,
        request_payload JSONB,
        response_body   JSONB,
        occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS invocations_tool_id_idx ON invocations (tool, id DESC);
      CREATE INDEX IF NOT EXISTS invocations_correlation_idx ON invocations (correlation_id);
    `)
    .then(() => {
      dbHealthy = true;
      console.log("db: connected, invocations table ready (history is durable)");
    })
    .catch((err) => {
      dbHealthy = false;
      lastDbError = err.message;
      console.error("db: setup failed, falling back to memory-only history —", err.message);
    });
} else if (!configured) {
  console.log("db: DATABASE_URL not set — history is memory-only (last " + MEMORY_LIMIT + " calls, lost on restart)");
}

/* True only when Postgres is genuinely wired up (URL set AND driver
   present). Everything below keys off this, not off `configured`. */
const active = !!pool;

/* ---- shared row shape, identical from memory or postgres, so the
       frontend and any consumer never has to care which tier served it ---- */
function buildRow(event, result) {
  return {
    id: null,
    tool: TOOL,
    event_type: (event && event.type) || null,
    correlation_id: (event && (event.correlationId || event.correlation_id)) || null,
    ok: !!(result && result.ok),
    status: (result && result.status) || null,
    verdict: (result && result.result && result.result.verdict) || null,
    request_payload: (event && event.payload) || {},
    response_body: result || {},
    occurred_at: new Date().toISOString()
  };
}

async function record(event, result) {
  const row = buildRow(event, result);
  row.id = "mem-" + (++memSeq);
  pushMemory(row);

  if (!active) return;
  try {
    await ready;
    await pool.query(
      `INSERT INTO invocations
         (tool, event_type, correlation_id, ok, status, verdict, request_payload, response_body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.tool, row.event_type, row.correlation_id, row.ok, row.status, row.verdict,
        JSON.stringify(row.request_payload), JSON.stringify(row.response_body)
      ]
    );
    dbHealthy = true;
  } catch (err) {
    dbHealthy = false;
    lastDbError = err.message;
    console.error("db: insert failed (call still answered, kept in memory) —", err.message);
  }
}

async function recent(limit) {
  if (active) {
    try {
      await ready;
      const { rows } = await pool.query(
        `SELECT id, tool, event_type, correlation_id, ok, status, verdict,
                request_payload, response_body, occurred_at
         FROM invocations
         WHERE tool = $1
         ORDER BY id DESC
         LIMIT $2`,
        [TOOL, limit]
      );
      dbHealthy = true;
      return { source: "postgres", rows };
    } catch (err) {
      dbHealthy = false;
      lastDbError = err.message;
      console.error("db: read failed, serving memory buffer instead —", err.message);
    }
  }
  return { source: "memory", rows: memory.slice(0, limit) };
}

/* What /health reports — literally true, never aspirational. */
function status() {
  if (!configured) {
    return {
      tier: "memory (volatile)",
      durable: false,
      detail: "DATABASE_URL not set. Last " + MEMORY_LIMIT + " calls only, lost on restart."
    };
  }
  if (!active) {
    return {
      tier: "memory (volatile)",
      durable: false,
      detail: "DATABASE_URL is set but the 'pg' driver isn't installed. Run npm install and redeploy."
    };
  }
  if (!dbHealthy) {
    return {
      tier: "memory (volatile)",
      durable: false,
      detail: "DATABASE_URL is set but Postgres is unreachable: " + (lastDbError || "unknown error") + ". Serving memory buffer."
    };
  }
  return {
    tier: "postgres (durable)",
    durable: true,
    detail: "Every call is written to the invocations table and survives restarts."
  };
}

module.exports = { record, recent, status, configured };
