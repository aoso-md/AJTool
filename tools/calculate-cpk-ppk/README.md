# calculate-cpk-ppk

Independent quality tool that receives `MEASUREMENTS_CAPTURED` and performs capability analysis.

Official broker tool ID (confirmed by Carlos): **`calculate_cpk_ppk`**. The
folder/display name `calculate-cpk-ppk` is a local identifier only — see
[`docs/OFFICIAL-CARLOS-CONTRACT.md`](../../docs/OFFICIAL-CARLOS-CONTRACT.md).

## Official contract (confirmed by Carlos)

- Input: `MEASUREMENTS_CAPTURED`
- Output: `CAPABILITY_BELOW_TARGET`

## Behavior

- Validates measurements, `lsl`, `usl`, and `target`.
- Returns a validation error when specs are missing or invalid.
- Calculates `cp`, `cpk`, mean, sample standard deviation, and sample size.
- Emits `CAPABILITY_BELOW_TARGET` — **official**, `official: true` — only when `cpk < 1.33` unless the event provides another `minimumCpk`.
- Also emits `CAPABILITY_ANALYSIS_COMPLETED` on every run, carrying the local `cp`/`cpk` result — this is a **proposed / not official** event (`official: false`). Not part of Carlos' confirmed contract yet. Do not treat it as an official broker event.

## Manual Run (CLI, one-shot)

```bash
node tools/calculate-cpk-ppk/src/handler.js tools/calculate-cpk-ppk/demo/capable-case.json
node tools/calculate-cpk-ppk/src/handler.js tools/calculate-cpk-ppk/demo/below-target-case.json
node tools/calculate-cpk-ppk/src/handler.js tools/calculate-cpk-ppk/demo/missing-specs-case.json
```

## HTTP Service

`src/server.js` is a zero-dependency HTTP wrapper around the same
`handle()` function above — same validation, same math, same emitted
events. This is what runs in the Docker image and in production.

```bash
node tools/calculate-cpk-ppk/src/server.js
```

Routes:

- `GET /health` — no auth. Returns `{ ok, tool, officialInput, officialOutput, inboundAuthRequired }`.
- `POST /events` — body is the full event envelope (same shape as `demo/*.json`). Returns exactly what `handle()` returns.

If `INBOUND_API_KEY` is set, `POST /events` requires a matching `x-api-key`
header or responds `401`. Unset by default (open) for local use.

**Deployed (Railway):** `https://calculate-cpk-ppk-production.up.railway.app`
— `INBOUND_API_KEY` is set there, so every `POST /events` call needs the key.

**Docker:** `docker/calculate_cpk_ppk.Dockerfile` (build context = repo root). Builds and runs `src/server.js`.

