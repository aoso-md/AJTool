# industrial-api-v2 Adapter

## Purpose

Translate API events into the independent quality-tool event contracts.

## Inbound Mapping

- `collect_quality_measurements` output becomes `MEASUREMENTS_CAPTURED`.
- `manage_device_registry` formal MSA request becomes `MSA_STUDY_REQUESTED`.
- `NEW_DEVICE_REGISTERED` can trigger `run-msa-analysis` only when observations are present.

## Outbound Mapping

- `CAPABILITY_ANALYSIS_COMPLETED` can be stored as a process capability result.
- `CAPABILITY_BELOW_TARGET` can create a quality alert or nonconformance review.
- `MSA_ANALYSIS_COMPLETED` can be stored against a device or study record.
- `MSA_VALIDATED` can approve a device for measurement use.
- `MSA_NOT_ACCEPTABLE` can block or review a device.

## Open Item

[EXTERNAL_ADMIN] should confirm exact API endpoint names, event bus format, authentication, and retry semantics.

