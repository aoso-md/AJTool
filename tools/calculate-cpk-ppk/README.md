# calculate-cpk-ppk

Independent quality tool that receives `MEASUREMENTS_CAPTURED` and performs capability analysis.

## Behavior

- Validates measurements, `lsl`, `usl`, and `target`.
- Returns a validation error when specs are missing or invalid.
- Calculates `cp`, `cpk`, mean, sample standard deviation, and sample size.
- Emits `CAPABILITY_ANALYSIS_COMPLETED`.
- Emits `CAPABILITY_BELOW_TARGET` only when `cpk < 1.33` unless the event provides another `minimumCpk`.

## Manual Run

```bash
node tools/calculate-cpk-ppk/src/handler.js tools/calculate-cpk-ppk/demo/capable-case.json
node tools/calculate-cpk-ppk/src/handler.js tools/calculate-cpk-ppk/demo/below-target-case.json
node tools/calculate-cpk-ppk/src/handler.js tools/calculate-cpk-ppk/demo/missing-specs-case.json
```

