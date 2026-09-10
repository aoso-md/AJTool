# calculate-cpk-ppk

Independent quality tool that receives `MEASUREMENTS_CAPTURED` and performs capability analysis.

Official broker tool ID (confirmed by [EXTERNAL_ADMIN]): **`calculate_cpk_ppk`**. The
folder/display name `calculate-cpk-ppk` is a local identifier only — see
[`docs/OFFICIAL-EXTERNAL-ADMIN-CONTRACT.md`](../../docs/OFFICIAL-EXTERNAL-ADMIN-CONTRACT.md).

## Official contract (confirmed by [EXTERNAL_ADMIN])

- Input: `MEASUREMENTS_CAPTURED`
- Output: `CAPABILITY_BELOW_TARGET`

## Behavior

- Validates measurements, `lsl`, `usl`, and `target`.
- Returns a validation error when specs are missing or invalid.
- Calculates `cp`, `cpk`, mean, sample standard deviation, and sample size.
- Emits `CAPABILITY_BELOW_TARGET` — **official**, `official: true` — only when `cpk < 1.33` unless the event provides another `minimumCpk`.
- Also emits `CAPABILITY_ANALYSIS_COMPLETED` on every run, carrying the local `cp`/`cpk` result — this is a **proposed / not official** event (`official: false`). Not part of [EXTERNAL_ADMIN]' confirmed contract yet. Do not treat it as an official broker event.

## Manual Run (CLI, one-shot)

```bash
node tools/calculate-cpk-ppk/src/handler.js tools/calculate-cpk-ppk/demo/capable-case.json
node tools/calculate-cpk-ppk/src/handler.js tools/calculate-cpk-ppk/demo/below-target-case.json
node tools/calculate-cpk-ppk/src/handler.js tools/calculate-cpk-ppk/demo/missing-specs-case.json
```

## HTTP Service

`src/server.js` is an HTTP wrapper around the same `handle()` function
above — same validation, same math, same emitted events. This is what
runs in the Docker image and in production.

```bash
node tools/calculate-cpk-ppk/src/server.js
```

Routes:

- `GET /health` — no auth. Returns `{ ok, tool, officialInput, officialOutput, inboundAuthRequired, persistence }`.
- `POST /events` — body is the full event envelope (same shape as `demo/*.json`). Returns exactly what `handle()` returns. Also records the call (best-effort) if persistence is enabled.
- `GET /reports?limit=20` — recent invocations (newest first), requires the same `x-api-key` as `/events` when `INBOUND_API_KEY` is set. Always answers, and reports which tier served it.

If `INBOUND_API_KEY` is set, `POST /events` requires a matching `x-api-key`
header or responds `401`. Unset by default (open) for local use.

**History — two tiers, always honest about which one is live:**

- **memory (default, zero config)** — the last 100 calls, served by
  `/reports` from the moment the container boots. Lost on restart.
- **postgres (when `DATABASE_URL` is set)** — every call is also written
  to the `invocations` table and survives restarts and redeploys.

`GET /health` reports `persistence.tier` and `persistence.durable`, so
it never claims durability it doesn't have. To enable Postgres in
Railway: open the project → **New** → **Database** → **Add PostgreSQL**,
attach it to this service (Railway injects `DATABASE_URL` automatically),
redeploy. Schema: [`db/schema.sql`](../../db/schema.sql). Implementation:
`src/db.js`. A database outage degrades to memory rather than failing
calls or taking the service down.

**Tests:** `node test/run-tests.js` from the repo root — maths against
hand-computed values, every demo case against the documented contract,
and the HTTP layer including auth. No `npm install`, no database needed.

**Deployed (Railway):** `https://calculate-cpk-ppk-production.up.railway.app`
— `INBOUND_API_KEY` is set there, so every `POST /events` call needs the key.

**Docker:** `docker/calculate_cpk_ppk.Dockerfile` (build context = repo root). Builds and runs `src/server.js`.

