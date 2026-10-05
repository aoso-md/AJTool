# Quality Tools Workspace Blueprint

The workspace can present both tools in one place without merging their code or interfaces.

## Layout

- Left navigation: tool registry entries.
- Main panel: selected tool interface.
- Right panel: event history and emitted events.
- Bottom panel: validation messages and recommendations.

## Independence Rule

Each tool owns its input contract, handler, demos, and interface documentation. The workspace only routes events and displays results.

## Shared Layer

The shared layer is limited to:

- event contracts
- tool registry metadata
- communication rules
- display of emitted events

No shared calculation logic is required for the Thursday demo.

