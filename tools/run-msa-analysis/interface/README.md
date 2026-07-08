# run-msa-analysis Interface

## Input

Formal event:

- `MSA_STUDY_REQUESTED`

Compatibility event:

- `NEW_DEVICE_REGISTERED`

The compatibility event must include observations or the handler returns a warning without emitting analysis events.

## Output

Consumers should listen for:

- `MSA_ANALYSIS_COMPLETED`
- `MSA_VALIDATED`
- `MSA_NOT_ACCEPTABLE`

No shared UI or shared runtime is required.

