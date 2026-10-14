"use strict";

/* =====================================================================
   bus-proxy — durable event log, two honest tiers
   ---------------------------------------------------------------------
   The proxy already keeps an in-memory `ledger` in server.js that powers
   /events/subscriptions/:toolId and /events/chain/:correlationId. That
   ledger is wiped on every restart. This module adds the durable half:

   TIER 1 — memory: the ledger in server.js (unchanged).
   TIER 2 — postgres (when DATABASE_URL is set): every published event is
     also written to `bus_events`, and /reports reads from there, so the
     record survives restarts and redeploys.

   ---------------------------------------------------------------------
   DESIGN RULE: persistence must never take the service down.

   A `pg` Pool emits an 'error' event when an IDLE connection dies
   (Postgres restarts, Railway recycles the instance, network blip). On
   an EventEmitter, an 'error' event with no listener is thrown as an
   uncaught exception — Node exits — and the service reads as "offline"
   even though the HTTP code is fine. Hence the error listener below,
   wrapped queries, and graceful degradation instead of crashing.
   ===================================================================== */

/* `pg` is required lazily, only when DATABASE_URL is actually set, so the
   proxy keeps its original zero-dependency property when no database is
   configured — and so a failed `npm install` degrades to memory-only
   instead of killing the process at require-time. */
const DATABASE_URL = process.env.DATABASE_URL || "";
const configured = !!DATABASE_URL;

let pool = null;
let ready = Promise.resolve();
let dbHealthy = false;
let lastDbError = null;

/* Railway's private network (*.railway.internal) is unencrypted by
   design and rejects SSL; its public proxy requires SSL but presents a
   self-signed cert. Local Postgres needs neither. */
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
    console.error("db: DATABASE_URL is set but the 'pg' module isn't installed — event log stays in memory. Run npm install.");
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

  pool.on("error", (err) => {
    dbHealthy = false;
    lastDbError = err.message;
    console.error("db: idle client error (proxy stays up, ledger stays in memory) —", err.message);
  });

  ready = pool
    .query(`
      CREATE TABLE IF NOT EXISTS bus_events (
        id             BIGSERIAL PRIMARY KEY,
        bus_id         TEXT,
        event_type     TEXT,
        source         TEXT,
        correlation_id TEXT,
        causation_id   TEXT,
        payload        JSONB,
        occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS bus_events_type_idx ON bus_events (event_type, id DESC);
      CREATE INDEX IF NOT EXISTS bus_events_correlation_idx ON bus_events (correlation_id);
    `)
    .then(() => {
      dbHealthy = true;
      console.log("db: connected, bus_events table ready (event log is durable)");
    })
    .catch((err) => {
      dbHealthy = false;
      lastDbError = err.message;
      console.error("db: setup failed, event log stays in memory only —", err.message);
    });
} else if (!configured) {
  console.log("db: DATABASE_URL not set — event log is in-memory only, lost on restart");
}

/* True only when Postgres is genuinely wired up (URL set AND driver
   present). Everything below keys off this, not off `configured`. */
const active = !!pool;

async function record(event) {
  if (!active) return;
  try {
    await ready;
    await pool.query(
      `INSERT INTO bus_events
         (bus_id, event_type, source, correlation_id, causation_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.id || null,
        event.type || null,
        event.source || null,
        event.correlationId || null,
        event.causationId || null,
        JSON.stringify(event.payload || {})
      ]
    );
    dbHealthy = true;
  } catch (err) {
    dbHealthy = false;
    lastDbError = err.message;
    console.error("db: insert failed (event still accepted and in the memory ledger) —", err.message);
  }
}

async function recent(limit) {
  if (!active) return { source: "memory", rows: [] };
  try {
    await ready;
    const { rows } = await pool.query(
      `SELECT id, bus_id, event_type, source, correlation_id, causation_id, payload, occurred_at
       FROM bus_events
       ORDER BY id DESC
       LIMIT $1`,
      [limit]
    );
    dbHealthy = true;
    return { source: "postgres", rows };
  } catch (err) {
    dbHealthy = false;
    lastDbError = err.message;
    console.error("db: read failed —", err.message);
    return { source: "memory", rows: [] };
  }
}

function status() {
  if (!configured) {
    return {
      tier: "memory (volatile)",
      durable: false,
      detail: "DATABASE_URL not set. The ledger lives in memory and is lost on restart."
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
      detail: "DATABASE_URL is set but Postgres is unreachable: " + (lastDbError || "unknown error") + "."
    };
  }
  return {
    tier: "postgres (durable)",
    durable: true,
    detail: "Every published event is written to bus_events and survives restarts."
  };
}

module.exports = { record, recent, status, configured };
