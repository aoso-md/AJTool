# Thursday Demo Proposal

## Demo Flow 1: Capability Analysis

1. Show `MEASUREMENTS_CAPTURED`.
2. Run `calculate-cpk-ppk`.
3. Show `CAPABILITY_ANALYSIS_COMPLETED`.
4. Show `CAPABILITY_BELOW_TARGET` only for the below-target demo.

## Demo Flow 2: MSA Analysis

1. Show `MSA_STUDY_REQUESTED`.
2. Run `run-msa-analysis`.
3. Show `MSA_ANALYSIS_COMPLETED`.
4. Show either `MSA_VALIDATED` or `MSA_NOT_ACCEPTABLE`.

## Demo Point

The two tools are independent but connectable through event contracts. This matches Carlos' tool-to-tool communication pattern without modifying Carlos' repos.

