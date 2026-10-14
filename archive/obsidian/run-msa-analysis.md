# run-msa-analysis

Independent MSA analysis tool.

Inputs:

- [[MSA_STUDY_REQUESTED]]
- `NEW_DEVICE_REGISTERED` compatibility path

Outputs:

- [[MSA_ANALYSIS_COMPLETED]]
- [[MSA_VALIDATED]]
- [[MSA_NOT_ACCEPTABLE]]

Decision: `NEW_DEVICE_REGISTERED` without observations returns a warning and emits no analysis event.

