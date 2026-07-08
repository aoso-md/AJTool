# run-msa-analysis

Independent quality tool that evaluates measurement-system analysis data.

## Behavior

- Accepts `MSA_STUDY_REQUESTED` as the formal path.
- Accepts `NEW_DEVICE_REGISTERED` as a compatibility path only when observations are included.
- Returns a clear warning when a new device event has no observations.
- Calculates `gageRRPercent`, repeatability, reproducibility, `ndc`, and verdict.
- Emits `MSA_ANALYSIS_COMPLETED`.
- Emits `MSA_VALIDATED` only when acceptable.
- Emits `MSA_NOT_ACCEPTABLE` when not acceptable.

## Manual Run

```bash
node tools/run-msa-analysis/src/handler.js tools/run-msa-analysis/demo/acceptable-case.json
node tools/run-msa-analysis/src/handler.js tools/run-msa-analysis/demo/not-acceptable-case.json
node tools/run-msa-analysis/src/handler.js tools/run-msa-analysis/demo/incomplete-device-case.json
```

