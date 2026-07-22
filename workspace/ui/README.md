# Quality Tools Workspace — Operations Console v0.4

Execution dashboard for `calculate-cpk-ppk` and `run-msa-analysis`.
Thesis on screen and in code: **Separate ownership, unified contracts.**

This is not a page of demo scenarios. It is a working simulation of the
**broker model** the platform is moving toward: a producer tool **publishes**
an event, the platform **stores/routes** it, a consumer tool **polls/consumes**
it, validates the contract, runs its handler, and **emits an output event**.
Every stage of that model is on screen and, where marked `IMPLEMENTED`,
actually executes — not just illustrated.

Bilingual (EN/ES toggle) and dual theme (warm light / dark console).

## How to open

Double-click `workspace/ui/index.html`. It works from `file://` with no
server, no dependencies, no build step. All scenario data is embedded in
`app.js`, so there is no fetch and no `Failed to fetch` — ever. The
`data/*.json` files are the human-readable copies of the same scenarios;
keep them in sync with `app.js` if you edit scenarios.

## Three ways to get an event in — not just "demo scenarios"

The top command bar switches between three **Input Source** modes. All
three build the same kind of event and run the same pipeline; they differ
only in how the event gets built.

1. **External Tool Event** — the "connect a tool" experience. Pick a
   **Target Tool**, an **Event Type**, a **Source Tool** (with an optional
   **Owner / Team**), a **Correlation ID**, and a **Payload JSON**. This is
   the closest thing on screen to what a real producer would send: a
   payload plus routing metadata, nothing more. Seven **Load Example
   Event** cards populate all of those fields at once from real fixtures.
2. **Manual Input** — three explicit forms, one per event shape:
   *Manual Input — build MEASUREMENTS_CAPTURED*, *Manual Input — build
   MSA_STUDY_REQUESTED*, *Manual Input — build NEW_DEVICE_REGISTERED*.
   Useful when there is no upstream tool yet and a person is the source.
3. **Raw JSON Event** — paste or edit a full event envelope
   (`{ type, source, payload }`) directly. Buttons: **Validate Event**
   (checks the JSON and the compatibility below without running anything),
   **Reset Payload** (clears the editor), **Load Example** (loads any of
   the seven fixtures by name). **Run Tool**, in the Execution stage below,
   runs whichever mode is active.

**External tools can send data to these tools today, in this console, if
they emit the correct event contract** — that is literally what External
Tool Event mode exercises. Nothing here is faked: the payload you type or
paste is the payload the real ported handler receives.

## Compatibility Check — the actual contract boundary

Stage 2 answers one question: **is the selected event consumable by the
selected target tool?** It shows the selected event, the target tool,
required fields, missing fields, and one of four statuses:

- `COMPATIBLE` — known event type, right target tool, all required fields present.
- `MISSING DATA` — known event type, right target tool, something required is absent or invalid.
- `NOT CONSUMABLE` — a known event type sent to the wrong target tool (e.g. `MEASUREMENTS_CAPTURED` aimed at `run-msa-analysis`).
- `NEEDS CARLOS CONFIRMATION` — an event type this workspace doesn't have a contract for at all yet.

The rule each tool actually enforces:

- **`calculate-cpk-ppk` consumes only `MEASUREMENTS_CAPTURED`.** Requires `measurements` (≥2 numeric), `lsl`, `usl`, `target`.
- **`run-msa-analysis` consumes `MSA_STUDY_REQUESTED` and `NEW_DEVICE_REGISTERED`.**
  `MSA_STUDY_REQUESTED` requires `studyId`, `deviceId`, `observations` (≥2 rows, each with `partId`/`operatorId`/`trial`/`value`). `tolerance` is shown as an optional field — the real handler (`tools/run-msa-analysis/src/handler.js`) and its schema (`contracts/events/MSA_STUDY_REQUESTED.schema.json`) do not require or use it today, so this UI does not invent enforcement stricter than the real handler has.
  `NEW_DEVICE_REGISTERED` (the compatibility path) requires `deviceId`, `deviceType`, `calibrationStatus`. If it has no `observations`, the UI shows the exact warning: *"Device registration is compatible as a trigger, but formal MSA requires MSA_STUDY_REQUESTED with repeated observations."* — and the handler answers with a warning, not an invented Gage R&R.

**Demian's tool as a worked example.** One of the seven Load Example cards
is `manage_nonconformance` (owner: Demian), emitting `NONCONFORMANCE_CREATED`.
Neither tool consumes that event type today, so picking it (against either
target) correctly shows `NOT CONSUMABLE` / `NEEDS CARLOS CONFIRMATION`, and
clicking **Run Tool** stops before any handler runs — no invented result.
This is the honest answer to "can Demian's tool connect to ours?": **yes,
the mechanism is identical — publish an event, we validate and consume it —
but compatibility always depends on the actual `eventType` and `payload`
shape, not on who the producer is.** If Carlos confirms a real event
contract for nonconformances, wiring it in is a data change (new entry in
`CONTRACT compatibility` rules and `TOOLS[].consumes`), not a redesign.

## Event Flow — the broker model, in the labels

The ribbon at the top of the canvas reads:

```
Producer Tool → Published Event → Event Broker / Ledger → Consuming Tool
→ Contract Validation → Handler Execution → Output Event → Downstream Consumers
```

That maps directly onto Carlos' platform model: a tool **publishes** an
event (POST), the platform **stores/routes** it (broker + ledger), a
consumer tool **polls/consumes** it, and — if the contract validates — the
consumer **emits an output event** of its own. There is no direct
tool-to-tool call anywhere in this diagram or in the code that drives it.

## What is IMPLEMENTED (real)

- **Handler logic** — ported 1:1 from `tools/calculate-cpk-ppk/src/handler.js` and `tools/run-msa-analysis/src/handler.js`. Same validation, same math (Cp/Cpk, Gage R&R %, repeatability, reproducibility, ndc), same emitted-event decisions.
- **Compatibility checking** — live, per required field, in all three input modes. `NOT CONSUMABLE` and `NEEDS CARLOS CONFIRMATION` events never reach a handler, the same way a real broker with no matching consumer never invents a result either. Contract-fail events reach the handler but stop at step 3 (`Contract validated`) with `VALIDATION ERROR`.
- **correlationId / causationId** — generated (or taken from the form) and propagated to command bar, inspector, and ledger.
- **Bilingual UI** — every label above, including the compatibility statuses and the Event Flow ribbon, is translated (EN/ES), not just the original scenario copy.

## What is DEMO DATA

- The seven Load Example fixtures (six mirror `tools/<tool>/demo/*.json`; the seventh is the Demian/`NONCONFORMANCE_CREATED` example, invented for this demo and explicitly marked as such since no such contract exists yet).
- The four seed rows in the Event Ledger.
- The ledger itself: **in-memory**, but its columns (`id, timestamp, correlationId, causationId, sourceTool, eventType, targetTool, status, emittedEvents, downstreamConsumers`) are PostgreSQL-ready. No real database is connected, and the UI says so.

## What is MOCK

- The Event Bus / broker transport (an in-process function call). Badged `MOCK` in the command bar.
- `mes_connector` and `external_tool_unconfirmed` as upstream producer options.

## What is FUTURE ADAPTER

- MARLI. Dashed, muted, labeled `FUTURE ADAPTER — NOT IMPLEMENTED IN CURRENT TOOL CODE`. No code exists for it and the UI never pretends otherwise.
- Downstream consumers (`manage_product_specs`, `audit_report`, `calculate_control_charts`, `manage_nonconformances`) are shown as routing targets with `NEEDS CARLOS CONFIRMATION`.

## 3-minute demo for Carlos

1. **(0:00)** Open `index.html`, default mode **External Tool Event**. Point at the command bar: bus MOCK, ledger DEMO DATA — everything honest, everything labeled.
2. **(0:30)** Click *Load collect_quality_measurements → MEASUREMENTS_CAPTURED*, then **Run Tool**. Narrate the ribbon: producer → published event → broker/ledger → consuming tool → contract validation → handler → output event → consumers. Cpk computed live, `CAPABILITY_ANALYSIS_COMPLETED` emitted, ledger row appended.
3. **(1:00)** Change **Target Tool** to `run-msa-analysis` without changing the event type. Point at Stage 2: `NOT CONSUMABLE` — *"Event not directly consumable by selected tool. Adapter or mapping needed."* That is the honest answer to "can any tool send us anything."
4. **(1:45)** Click *Load Demian example → NONCONFORMANCE_CREATED / needs adapter*. Same story, this time for a real name: `NEEDS CARLOS CONFIRMATION`, no handler called, nothing invented.
5. **(2:15)** Switch to **Manual Input**, change one measurement, run. Same pipeline, same ledger — input can come from any tool or from a person. Switch to **Raw JSON Event**, paste any envelope, hit **Validate Event** before running it.
6. **(2:45)** Point at MARLI, dashed: future consumer, not implemented, and the UI says so. Close with the thesis: two tools, one shared contract boundary, no direct coupling.

## How this later connects to a real Event Bus and PostgreSQL

- **Event Bus**: replace the in-process `tool.handler(event)` call in `app.js` (`run()`) with a publish to the bus defined in `adapters/carlos-ecosystem/communication-rules.json`. The event shape already matches `contracts/events/*.schema.json`.
- **PostgreSQL**: replace `appendLedger()` with an `INSERT` into a table with the exact columns the UI already renders. The seed rows show the target schema.
- **New producers (like Demian's tool)**: once Carlos confirms an event contract for a new event type, add it to `EVENT_TO_TOOL`/`TOOLS[].consumes` and the required-field list in `computeCompatibility()` — the External Tool Event form, compatibility check, and ledger all pick it up automatically.
- Nothing else changes: contracts, handlers, and routing stay as they are. That is the point of *separate ownership, unified contracts*.

## Files

```
workspace/ui/
├── index.html              shell (no build, no dependencies)
├── styles.css              design system: warm light + dark, badges, stages
├── app.js                  i18n, ported handlers, compatibility engine, run engine
├── data/cpk-scenarios.json readable scenario source (embedded copy in app.js)
├── data/msa-scenarios.json readable scenario source (embedded copy in app.js)
└── README.md               this file
```

Verify after edits: `node --check workspace/ui/app.js`
