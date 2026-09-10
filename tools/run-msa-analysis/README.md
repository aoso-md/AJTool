# run-msa-analysis

Independent quality tool that evaluates measurement-system analysis data.

Official broker tool ID (confirmed by [EXTERNAL_ADMIN]): **`run_msa_analysis`**. The
folder/display name `run-msa-analysis` is a local identifier only — see
[`docs/OFFICIAL-EXTERNAL-ADMIN-CONTRACT.md`](../../docs/OFFICIAL-EXTERNAL-ADMIN-CONTRACT.md).

## Official contract (confirmed by [EXTERNAL_ADMIN])

- Input: `NEW_DEVICE_REGISTERED`
- Output: `MSA_VALIDATED`

## Behavior

- Accepts `NEW_DEVICE_REGISTERED` — **official input** — and runs the analysis when observations are included; returns a clear warning when they are absent.
- Also accepts `MSA_STUDY_REQUESTED` as a proposed/local-only input path (not part of [EXTERNAL_ADMIN]' confirmed contract). Kept for local use; do not present it as an official broker input.
- Calculates `gageRRPercent`, repeatability, reproducibility, `ndc`, and verdict.
- Emits `MSA_VALIDATED` — **official**, `official: true` — only when acceptable.
- Also emits `MSA_ANALYSIS_COMPLETED` on every completed run, and `MSA_NOT_ACCEPTABLE` when not acceptable — both **proposed / not official** events (`official: false`). Not part of [EXTERNAL_ADMIN]' confirmed contract yet.

## Manual Run (CLI, one-shot)

```bash
node tools/run-msa-analysis/src/handler.js tools/run-msa-analysis/demo/acceptable-case.json
node tools/run-msa-analysis/src/handler.js tools/run-msa-analysis/demo/not-acceptable-case.json
node tools/run-msa-analysis/src/handler.js tools/run-msa-analysis/demo/incomplete-device-case.json
```

## HTTP Service

`src/server.js` is an HTTP wrapper around the same `handle()` function
above — same validation, same math, same emitted events. This is what
runs in the Docker image and in production.

```bash
node tools/run-msa-analysis/src/server.js
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

**Deployed (Railway):** `https://run-msa-analysis-production.up.railway.app`
— `INBOUND_API_KEY` is set there, so every `POST /events` call needs the key.

**Docker:** `docker/run_msa_analysis.Dockerfile` (build context = repo root). Builds and runs `src/server.js`.

