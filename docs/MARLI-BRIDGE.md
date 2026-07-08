# MARLI Bridge

## Purpose

MARLI can act as the routing and explanation layer between quality events and quality tools.

## Proposed Role

- Receive event envelopes.
- Select the correct independent tool from the registry.
- Run or recommend the tool.
- Explain emitted events and recommendations to the user.

## Boundary

MARLI should not own capability formulas, MSA formulas, or adapter persistence. Those remain in the independent tools or future adapter layer.

