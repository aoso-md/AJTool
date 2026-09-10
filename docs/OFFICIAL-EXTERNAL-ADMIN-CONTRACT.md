# Official [EXTERNAL_ADMIN] Contract

Source of truth for which event contracts are **confirmed by [EXTERNAL_ADMIN]** versus
**proposed / not official**. Referenced from the tool READMEs and rendered
live in `workspace/ui` (Official Contract panel + badges throughout).

## Official broker tool IDs

| Local folder / display name | Official broker ID (confirmed by [EXTERNAL_ADMIN]) |
|---|---|
| `calculate-cpk-ppk` | `calculate_cpk_ppk` |
| `run-msa-analysis` | `run_msa_analysis` |

The folder name is a local identifier only. The broker ID is what the
platform and [EXTERNAL_ADMIN]' ecosystem refer to.

## Official flows (confirmed by [EXTERNAL_ADMIN])

- **Flow 1 — Capability**: `MEASUREMENTS_CAPTURED` → `calculate_cpk_ppk` → `CAPABILITY_BELOW_TARGET`
- **Flow 2 — MSA**: `NEW_DEVICE_REGISTERED` → `run_msa_analysis` → `MSA_VALIDATED`

These are the only two input→output pairs [EXTERNAL_ADMIN] has confirmed as official
today. Every other event type each tool accepts or emits
(`CAPABILITY_ANALYSIS_COMPLETED`, `MSA_STUDY_REQUESTED`,
`MSA_ANALYSIS_COMPLETED`, `MSA_NOT_ACCEPTABLE`) is **proposed / not
official** — kept for local use and labeled as such everywhere it appears,
in code (`official: true/false` on every emitted event) and in the UI.

## Notes

- This workspace (`workspace/ui`) is a local simulation only — it is not
  connected to the real API.
- The real IsoTools API was verified manually via PowerShell (`/health`,
  `/ready`, `/catalog/tools`, `/events`, `/events/subscriptions/:toolId`,
  `/events/chain/:correlationId`).
- Production path when wired up: `POST /events`, then
  `GET /events/subscriptions/:toolId` and `GET /events/chain/:correlationId`.
  No direct tool-to-tool calls, ever.
- The API key must never live in the frontend or anywhere in this
  repository.

## Open items — still need [EXTERNAL_ADMIN]' confirmation

See [`docs/OPEN-QUESTIONS-FOR-EXTERNAL-ADMIN.md`](OPEN-QUESTIONS-FOR-EXTERNAL-ADMIN.md).
Two worth calling out given the above:

- `CAPABILITY_ANALYSIS_COMPLETED` (calculate_cpk_ppk) has no official output
  event at all for the "capable" case — only the below-target case has a
  confirmed output (`CAPABILITY_BELOW_TARGET`). Worth asking [EXTERNAL_ADMIN] whether
  a capable-process result should also produce something official.
- `MSA_NOT_ACCEPTABLE` (run_msa_analysis) — arguably the most important
  output for routing to nonconformance — is not yet official. Only
  `MSA_VALIDATED` (the acceptable path) is confirmed.
