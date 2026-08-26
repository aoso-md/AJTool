# run-msa-analysis

Independent quality tool that evaluates measurement-system analysis data.

Official broker tool ID (confirmed by Carlos): **`run_msa_analysis`**. The
folder/display name `run-msa-analysis` is a local identifier only — see
[`docs/OFFICIAL-CARLOS-CONTRACT.md`](../../docs/OFFICIAL-CARLOS-CONTRACT.md).

## Official contract (confirmed by Carlos)

- Input: `NEW_DEVICE_REGISTERED`
- Output: `MSA_VALIDATED`

## Behavior

- Accepts `NEW_DEVICE_REGISTERED` — **official input** — and runs the analysis when observations are included; returns a clear warning when they are absent.
- Also accepts `MSA_STUDY_REQUESTED` as a proposed/local-only input path (not part of Carlos' confirmed contract). Kept for local use; do not present it as an official broker input.
- Calculates `gageRRPercent`, repeatability, reproducibility, `ndc`, and verdict.
- Emits `MSA_VALIDATED` — **official**, `official: true` — only when acceptable.
- Also emits `MSA_ANALYSIS_COMPLETED` on every completed run, and `MSA_NOT_ACCEPTABLE` when not acceptable — both **proposed / not official** events (`official: false`). Not part of Carlos' confirmed contract yet.

## Manual Run (CLI, one-shot)

```bash
node tools/run-msa-analysis/src/handler.js tools/run-msa-analysis/demo/acceptable-case.json
node tools/run-msa-analysis/src/handler.js tools/run-msa-analysis/demo/not-acceptable-case.json
node tools/run-msa-analysis/src/handler.js tools/run-msa-analysis/demo/incomplete-device-case.json
```

## HTTP Service

`src/server.js` is a zero-dependency HTTP wrapper around the same
`handle()` function above — same validation, same math, same emitted
events. This is what runs in the Docker image and in production.

```bash
node tools/run-msa-analysis/src/server.js
```

Routes:

- `GET /health` — no auth. Returns `{ ok, tool, officialInput, officialOutput, inboundAuthRequired }`.
- `POST /events` — body is the full event envelope (same shape as `demo/*.json`). Returns exactly what `handle()` returns.

If `INBOUND_API_KEY` is set, `POST /events` requires a matching `x-api-key`
header or responds `401`. Unset by default (open) for local use.

**Deployed (Railway):** `https://run-msa-analysis-production.up.railway.app`
— `INBOUND_API_KEY` is set there, so every `POST /events` call needs the key.

**Docker:** `docker/run_msa_analysis.Dockerfile` (build context = repo root). Builds and runs `src/server.js`.

