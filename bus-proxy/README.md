# Bus Proxy — the real event bus for this workspace

This is what "conectarse al event bus" means in this repo, concretely: a
small standalone Node process, zero npm dependencies, that speaks the exact
contract [EXTERNAL_ADMIN]' platform expects.

## Why this exists, not something bigger

`workspace/ui/app.js` runs entirely in the browser from `file://`. Anyone
who opens `index.html` can view its source. The IsoTools API needs an
`x-api-key` header, and that key **must never live in the frontend or
anywhere in this repository**. A key embedded in `app.js` would be visible
to literally anyone who opens the page.

The fix is the smallest thing that solves that one problem: a process that
runs on your machine, holds the key in an untracked `.env` file, and is the
only thing that ever talks to the real API. The browser talks to
`localhost`, never to the real endpoint directly.

This is not a message queue, not Kafka/RabbitMQ, not a database — just an
HTTP relay with an in-memory ledger, matching the same
`id / correlationId / causationId / sourceTool / eventType / status`
shape already used everywhere else in this repo.

## Two honest modes

- **LOCAL** — no `.env`, or `.env` without both `ISOTOOLS_API_BASE_URL` and
  `ISOTOOLS_API_KEY`. Events are published, stored, and queried entirely
  in memory on your machine. Nothing leaves it. `GET /health` says
  `"mode": "LOCAL"`.
- **CONNECTED** — both variables are set. Every `POST /events` is also
  forwarded to the real IsoTools API with `x-api-key` attached
  server-side. `GET /health` says `"mode": "CONNECTED"` and shows the
  base URL (never the key).

The proxy never pretends to be in one mode while acting like the other.
Whatever `/health` reports is literally true.

## Run it

```
node bus-proxy/server.js
```

No `npm install` needed — it only uses Node's built-in `http`, `fs`, and
`fetch`. Requires Node 18+ (this machine has v22).

You should see:

```
Quality Tools Bus Proxy listening on http://localhost:8787
Mode: LOCAL (in-memory only — see bus-proxy/.env.example)
```

## Giving [EXTERNAL_ADMIN] a path to call in (inbound direction)

If [EXTERNAL_ADMIN]' platform is the one calling INTO this proxy (not the other way
around), he doesn't need a URL from you — he needs the path(s) below,
appended to wherever this proxy is deployed (e.g. the Railway URL):

- `POST   <deploy-url>/events`
- `GET    <deploy-url>/events/subscriptions/:toolId`
- `GET    <deploy-url>/events/chain/:correlationId`
- `GET    <deploy-url>/health` (no auth, always open — for uptime checks)

By default those routes have no auth (fine for local dev/demo, not for a
public deployment). To require the key [EXTERNAL_ADMIN] already gave you on every
inbound call:

1. Set `INBOUND_API_KEY` in `bus-proxy/.env` (local) or as a Railway
   variable (deployed) to that key.
2. Every request to `/events`, `/events/subscriptions/:toolId`, and
   `/events/chain/:correlationId` must then include header
   `x-api-key: <that key>`, or it gets `401`. `/health` stays open.
3. `GET /health` reports `inboundAuthRequired: true/false` so you can
   confirm it's on without exposing the key itself.

This is separate from `ISOTOOLS_API_KEY` below, which is used only if
this proxy also needs to call OUT to a real IsoTools API.

## Connect it to the real IsoTools API

1. Copy `bus-proxy/.env.example` to `bus-proxy/.env` (same folder).
2. Fill in `ISOTOOLS_API_BASE_URL` and `ISOTOOLS_API_KEY` with the real
   values from [EXTERNAL_ADMIN].
3. Restart the proxy. `/health` now reports `"mode": "CONNECTED"`.

`bus-proxy/.env` is listed in `.gitignore` — it will never be committed.

## Routes

- `GET /health` — `{ ok, mode, upstreamConfigured, upstreamBaseUrl, inboundAuthRequired, persistence, note, eventCount }`
- `POST /events` — body `{ type, source, payload, correlationId?, causationId? }`. Stores the event (in-memory ledger, plus Postgres if `DATABASE_URL` is set), forwards it upstream if CONNECTED, returns `{ ok, mode, event, upstream }`.
- `GET /events/subscriptions/:toolId` — `toolId` is the **official broker ID** (`calculate_cpk_ppk` or `run_msa_analysis`, see `docs/OFFICIAL-EXTERNAL-ADMIN-CONTRACT.md`), not the folder name. Returns events of the types that tool consumes, from the in-memory ledger.
- `GET /events/chain/:correlationId` — every event published under that correlation ID, oldest first, from the in-memory ledger.
- `GET /reports?limit=20` — recent events straight from Postgres (newest first), independent of the in-memory ledger above — this is what survives a restart. Returns an empty list, not an error, if persistence isn't configured.

## Persistence (optional, survives restarts)

By default the ledger above is in-memory only — a Railway restart wipes
it. Set `DATABASE_URL` (a Postgres connection string) to also write
every published event to a `bus_events` table:

1. In Railway, open this service → **New** → **Database** → **Add
   PostgreSQL** (or attach an existing instance).
2. Railway injects `DATABASE_URL` into this service automatically —
   nothing else to configure.
3. Redeploy. `GET /health` now reports `"persistence": "postgres"`, and
   `GET /reports` starts returning real rows.

Without `DATABASE_URL`, nothing changes from before — `/reports` simply
returns an empty list. See `bus-proxy/db.js`.

## Quick manual test (PowerShell)

```powershell
# health check
Invoke-RestMethod http://localhost:8787/health

# publish a real MEASUREMENTS_CAPTURED event
$body = @{
  type = "MEASUREMENTS_CAPTURED"
  source = "collect_quality_measurements"
  correlationId = "corr-test-0001"
  payload = @{
    measurementSetId = "MS-CPK-001"; partNumber = "PN-9001"; characteristic = "shaft diameter"
    measurements = @(10.01,10.02,9.99,10.00,10.01,9.98,10.02,10.00)
    lsl = 9.9; usl = 10.1; target = 10.0; minimumCpk = 1.33
  }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://localhost:8787/events -Body $body -ContentType "application/json"

# see what calculate_cpk_ppk would consume
Invoke-RestMethod http://localhost:8787/events/subscriptions/calculate_cpk_ppk

# trace the full chain for that correlation id
Invoke-RestMethod http://localhost:8787/events/chain/corr-test-0001
```

## How `workspace/ui` uses this

`app.js` checks `http://localhost:8787/health` on load and updates the
**Event Bus** pill in the command bar: `LIVE (local)` if the proxy answers
in LOCAL mode, `LIVE (connected)` if CONNECTED, or `MOCK` if the proxy
isn't running at all — the UI degrades honestly, it never fakes a
connection. When a scenario runs, the emitted events are also published to
this proxy in the background (best-effort — if the proxy is down, the UI's
own local computation and ledger still work exactly as before; nothing
about the demo depends on this proxy being up).

## What this does not do yet

- No retry/backoff on forwarding failures — a failed forward is reported
  in the response and dropped, not queued.
- The in-memory ledger (used by `/events/subscriptions/:toolId` and
  `/events/chain/:correlationId`) still resets on restart even with
  Postgres attached — only `/reports` reads from the durable store today.
  Moving the other two routes onto Postgres as well is a small follow-up,
  not done yet.
- No auth on the proxy's own local endpoints — it only binds to
  `localhost`, meant for local development, not for exposing on a network.
