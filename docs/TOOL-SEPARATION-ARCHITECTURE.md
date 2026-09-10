# Tool Separation Architecture

## Principle

Each quality tool is independently runnable and independently documented.

## Boundaries

- `tools/calculate-cpk-ppk` owns capability analysis.
- `tools/run-msa-analysis` owns MSA analysis.
- `contracts/events` owns event contracts.
- `adapters/external-admin-ecosystem` owns integration documentation.
- `workspace` owns combined presentation ideas only.

## Why This Works

[EXTERNAL_ADMIN]' ecosystem can standardize on events while Angel/Joaquin retain separate tool logic and separate interfaces.

## Current Non-Goals

- No complex app.
- No dependency installation.
- No migrations.
- No direct edits to [EXTERNAL_ADMIN] repos.

