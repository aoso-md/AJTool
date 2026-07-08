# calculate-cpk-ppk Interface

## Input

Primary input event: `MEASUREMENTS_CAPTURED`.

Required payload fields:

- `measurementSetId`
- `measurements`
- `lsl`
- `usl`
- `target`

## Output

The handler returns a result object and emitted event envelopes. Consumers should listen for:

- `CAPABILITY_ANALYSIS_COMPLETED`
- `CAPABILITY_BELOW_TARGET`

No UI coupling is assumed. A future workspace can render this tool as a separate panel or route.

