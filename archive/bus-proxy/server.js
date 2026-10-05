"use strict";

/* =====================================================================
   Quality Tools Bus Proxy — local event bus
   ---------------------------------------------------------------------
   What this is:
   - A real, standalone Node process (zero npm dependencies) implementing
     the exact event-bus contract [EXTERNAL_ADMIN]' platform expects:
       POST /events
       GET  /events/subscriptions/:toolId
       GET  /events/chain/:correlationId
       GET  /health
   - It runs in one of two honest modes, and always says which:
       LOCAL      — no ISOTOOLS_API_BASE_URL / ISOTOOLS_API_KEY configured.
                    Events are stored in memory only, on this machine.
       CONNECTED  — both are configured. Every POST /events is also
                    forwarded to the real IsoTools API with the
                    x-api-key header, server-side only. The key never
                    reaches the browser or any tracked file in this repo.
   - This is intentionally NOT a message queue, NOT Kafka/RabbitMQ, NOT
     a database. It is the smallest real thing that satisfies the
     contract while the real endpoint/key get confirmed with [EXTERNAL_ADMIN].

   Inbound direction ([EXTERNAL_ADMIN]' platform calling INTO this proxy):
   - The path [EXTERNAL_ADMIN]' platform needs is this deployment's base URL plus
     the routes above, e.g. POST https://<this-deploy>/events.
   - If INBOUND_API_KEY is set, every request except GET /health and
     OPTIONS must include a matching "x-api-key" header, or it gets a
     401. If INBOUND_API_KEY is not set, these routes stay open (same
     as before — no auth), which is fine for local dev, not for a
     public deployment once [EXTERNAL_ADMIN] is actually calling in.

   Run:
     node bus-proxy/server.js

   Configure (optional — runs in LOCAL mode without this):
     copy bus-proxy/.env.example to bus-proxy/.env and fill in real values.
     bus-proxy/.env is gitignored — never commit real keys.
   ===================================================================== */

const http = require("http");
const fs = require("fs");
const path = require("path");
const db = require("./db.js");

/* ---- tiny .env loader (no dependency) ---- */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT) || 8787;
const UPSTREAM_BASE_URL = (process.env.ISOTOOLS_API_BASE_URL || "").replace(/\/+$/, "");
const UPSTREAM_API_KEY = process.env.ISOTOOLS_API_KEY || "";
const CONNECTED = !!(UPSTREAM_BASE_URL && UPSTREAM_API_KEY);

/* ---- inbound auth: required only if INBOUND_API_KEY is set ----
   This guards calls coming IN (e.g. from [EXTERNAL_ADMIN]' platform), separate
   from UPSTREAM_API_KEY above, which is used for calls going OUT. */
const INBOUND_API_KEY = process.env.INBOUND_API_KEY || "";
function inboundAuthOk(req) {
  if (!INBOUND_API_KEY) return true; // open — no key configured yet
  return req.headers["x-api-key"] === INBOUND_API_KEY;
}

/* ---- known contract: which tool consumes which event type ----
   Mirrors adapters/external-admin-ecosystem/tool-registry-mapping.json and the
   TOOLS registry in workspace/ui/app.js. Kept in sync manually — this
   is the same "unified contract" boundary, just enforced here too. */
const CONSUMES = {
  calculate_cpk_ppk: ["MEASUREMENTS_CAPTURED"],
  run_msa_analysis: ["NEW_DEVICE_REGISTERED", "MSA_STUDY_REQUESTED"]
};

/* ---- in-memory ledger — this process only, resets on restart ---- */
let ledger = [];
let seq = 1;
function newId() { return "bus-" + String(seq++).padStart(6, "0"); }

async function forwardUpstream(pathname, options) {
  if (!CONNECTED) return { forwarded: false };
  try {
    const res = await fetch(UPSTREAM_BASE_URL + pathname, {
      method: options.method || "GET",
      headers: Object.assign(
        { "x-api-key": UPSTREAM_API_KEY, "content-type": "application/json" },
        options.headers || {}
      ),
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = text; }
    return { forwarded: true, status: res.status, ok: res.ok, body: json };
  } catch (err) {
    return { forwarded: true, error: String((err && err.message) || err) };
  }
}

function send(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; if (data.length > 2e6) req.destroy(); });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (req.method === "OPTIONS") { send(res, 204, {}); return; }

  // Root path — generic uptime/health checks (Railway's own, or [EXTERNAL_ADMIN]'
  // platform monitoring) often hit "/" instead of "/health". Answer here
  // too so those don't report this service as offline. No auth, no data.
  if (req.method === "GET" && pathname === "/") {
    send(res, 200, { ok: true, service: "quality-tools-bus-proxy", see: "/health" });
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    send(res, 200, {
      ok: true,
      mode: CONNECTED ? "CONNECTED" : "LOCAL",
      upstreamConfigured: CONNECTED,
      upstreamBaseUrl: CONNECTED ? UPSTREAM_BASE_URL : null,
      inboundAuthRequired: !!INBOUND_API_KEY,
      persistence: db.status(),
      note: CONNECTED
        ? "Forwarding every POST /events to the real IsoTools API with x-api-key."
        : "No ISOTOOLS_API_BASE_URL / ISOTOOLS_API_KEY configured — running in-memory only. See bus-proxy/.env.example.",
      eventCount: ledger.length
    });
    return;
  }

  // Every route below this line requires the inbound x-api-key when
  // INBOUND_API_KEY is configured (health check above stays open so
  // uptime monitors don't need a key).
  if (!inboundAuthOk(req)) {
    send(res, 401, { ok: false, error: "missing or invalid x-api-key" });
    return;
  }

  if (req.method === "POST" && pathname === "/events") {
    let body;
    try { body = await readBody(req); }
    catch (e) { send(res, 400, { ok: false, error: "invalid JSON body" }); return; }
    if (!body || !body.type) { send(res, 400, { ok: false, error: "event.type is required" }); return; }

    const event = {
      id: newId(),
      type: body.type,
      source: body.source || "unknown",
      correlationId: body.correlationId || null,
      causationId: body.causationId || null,
      occurredAt: new Date().toISOString(),
      payload: body.payload || {}
    };
    ledger.unshift(event);
    db.record(event); // best-effort — survives restarts if DATABASE_URL is set

    const upstream = await forwardUpstream("/events", { method: "POST", body });
    send(res, 201, { ok: true, mode: CONNECTED ? "CONNECTED" : "LOCAL", event, upstream });
    return;
  }

  const subsMatch = pathname.match(/^\/events\/subscriptions\/([^/]+)$/);
  if (req.method === "GET" && subsMatch) {
    const toolId = decodeURIComponent(subsMatch[1]);
    const wanted = CONSUMES[toolId] || null;
    const items = wanted ? ledger.filter((e) => wanted.indexOf(e.type) >= 0) : [];
    send(res, 200, {
      ok: true, mode: CONNECTED ? "CONNECTED" : "LOCAL", toolId,
      knownTool: !!wanted, consumes: wanted || [], items
    });
    return;
  }

  const chainMatch = pathname.match(/^\/events\/chain\/([^/]+)$/);
  if (req.method === "GET" && chainMatch) {
    const correlationId = decodeURIComponent(chainMatch[1]);
    const items = ledger.filter((e) => e.correlationId === correlationId).reverse();
    send(res, 200, { ok: true, mode: CONNECTED ? "CONNECTED" : "LOCAL", correlationId, items });
    return;
  }

  // Read-only history straight from Postgres (if configured) — proof
  // that published events actually persist, independent of the
  // in-memory ledger above which resets on every restart. Empty list
  // (not an error) if DATABASE_URL isn't set.
  if (req.method === "GET" && pathname === "/reports") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
    const { source, rows } = await db.recent(limit);
    send(res, 200, {
      ok: true,
      service: "quality-tools-bus-proxy",
      servedFrom: source,
      persistence: db.status(),
      count: rows.length,
      events: rows
    });
    return;
  }

  send(res, 404, {
    ok: false, error: "not found",
    knownRoutes: [
      "GET /health", "POST /events",
      "GET /events/subscriptions/:toolId", "GET /events/chain/:correlationId",
      "GET /reports"
    ]
  });
});

server.listen(PORT, () => {
  console.log("Quality Tools Bus Proxy listening on http://localhost:" + PORT);
  console.log("Mode: " + (CONNECTED ? "CONNECTED (forwarding to " + UPSTREAM_BASE_URL + ")" : "LOCAL (in-memory only — see bus-proxy/.env.example)"));
});
