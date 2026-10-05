# Angel/Joaquin Quality Tools

Independent repo for two quality tools:

- `calculate-cpk-ppk`
- `run-msa-analysis`

The tools do not share runtime logic or UI assumptions. They connect through explicit event contracts under `contracts/events`.

## Safe Checks

```bash
node --check tools/calculate-cpk-ppk/src/handler.js
node --check tools/run-msa-analysis/src/handler.js
```

Manual demo examples can be loaded with Node and passed to each handler.

