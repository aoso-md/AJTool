"use strict";

/* =====================================================================
   run_msa_analysis — HTTP wrapper around handler.js
   ---------------------------------------------------------------------
   Zero npm dependencies, same pattern as bus-proxy/server.js. This is
   the path [EXTERNAL_ADMIN]' platform (or anyone) calls to run the tool directly:

     GET  /health   — status, no auth required
     POST /events   — body is the full event envelope, same shape as
                       tools/run-msa-analysis/demo/*.json. Returns
                       exactly what handler.js returns (result +
                       emittedEvents). No persistence, no queue — this
                       just runs the handler and answers.

   Optional inbound auth: set INBOUND_API_KEY and every /events call
   must include a matching "x-api-key" header, or it gets 401. Unset
   (default) means the route stays open — fine for local/demo use.

   Run:
     node src/server.js
   Configure:
     PORT (default 8082), INBOUND_API_KEY (optional)
   ===================================================================== */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { handle } = require("./handler.js");
const db = require("./db.js");

const PORT = Number(process.env.PORT) || 8082;
const INBOUND_API_KEY = process.env.INBOUND_API_KEY || "";

// Frontend page — a real, usable HTML form (not just JSON) for GET /.
// Loaded once at startup and cached in memory; falls back to a plain
// JSON status if the file isn't there for some reason.
const FRONTEND_PATH = path.join(__dirname, "public", "index.html");
let FRONTEND_HTML = null;
try { FRONTEND_HTML = fs.readFileSync(FRONTEND_PATH, "utf8"); } catch (e) { FRONTEND_HTML = null; }

function inboundAuthOk(req) {
  if (!INBOUND_API_KEY) return true;
  return req.headers["x-api-key"] === INBOUND_API_KEY;
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

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
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

  // Root path — a real, usable frontend (form + results), not just a
  // status ping. This also means generic uptime/health checks hitting
  // "/" (Railway's own, or anyone's) get a 200 instead of a 404, so this
  // service never reads as "offline" just because someone opened the
  // bare URL in a browser. Falls back to a plain JSON status if the
  // HTML file failed to load for some reason. No auth, no data.
  if (req.method === "GET" && pathname === "/") {
    if (FRONTEND_HTML) { sendHtml(res, 200, FRONTEND_HTML); return; }
    send(res, 200, { ok: true, tool: "run_msa_analysis", see: "/health" });
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    send(res, 200, {
      ok: true,
      tool: "run_msa_analysis",
      officialInput: "NEW_DEVICE_REGISTERED",
      officialOutput: "MSA_VALIDATED",
      inboundAuthRequired: !!INBOUND_API_KEY,
      persistence: db.status()
    });
    return;
  }

  if (!inboundAuthOk(req)) {
    send(res, 401, { ok: false, error: "missing or invalid x-api-key" });
    return;
  }

  if (req.method === "POST" && pathname === "/events") {
    let event;
    try { event = await readBody(req); }
    catch (e) { send(res, 400, { ok: false, error: "invalid JSON body" }); return; }

    let result;
    try { result = handle(event); }
    catch (e) { send(res, 500, { ok: false, error: "handler crashed", message: String((e && e.message) || e) }); return; }

    // Best-effort persistence — never blocks or fails the response even
    // if DATABASE_URL isn't set or the insert fails (db.js swallows and
    // logs its own errors). This is what lets /reports show a real
    // history of every call this service has answered.
    db.record(event, result);

    const status = result.ok ? 200 : (result.status === "validation-error" ? 422 : 200);
    send(res, status, result);
    return;
  }

  // Read-only history of past invocations — proof that calls are really
  // being recorded, not just answered and forgotten. Requires the same
  // x-api-key as /events (it carries payload data). Always answers:
  // from Postgres when it's configured and reachable, otherwise from the
  // in-memory ring buffer, and it says which one it used.
  if (req.method === "GET" && pathname === "/reports") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
    const { source, rows } = await db.recent(limit);
    send(res, 200, {
      ok: true,
      tool: "run_msa_analysis",
      servedFrom: source,
      persistence: db.status(),
      count: rows.length,
      invocations: rows
    });
    return;
  }

  send(res, 404, {
    ok: false, error: "not found",
    knownRoutes: ["GET /health", "POST /events", "GET /reports"]
  });
});

server.listen(PORT, () => {
  console.log("run_msa_analysis tool service listening on http://localhost:" + PORT);
  console.log("Inbound auth: " + (INBOUND_API_KEY ? "REQUIRED (x-api-key)" : "open (no INBOUND_API_KEY set)"));
});
