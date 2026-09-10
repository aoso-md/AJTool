# Quality Tools Workspace — [EXTERNAL_ADMIN] Demo Explanation

## Core idea

This workspace demonstrates how independent tools communicate through
standardized events.

Thesis: **Separate ownership, unified contracts.**

Each tool owns its logic, but tools connect through event contracts rather
than direct calls.

## Platform alignment

Based on IsoTools' `README-PROGRAMADORES`, the platform is an event broker.

Pattern:

1. Tool publishes event with `POST /events`
2. Platform stores/routes event
3. Other tools consume event with `GET` / polling
4. Consumer validates contract
5. Consumer runs handler
6. Consumer emits output event
7. Ledger stores evidence

## Our tools

### calculate-cpk-ppk

Consumes:
- `MEASUREMENTS_CAPTURED`

Requires:
- `measurements`
- `lsl`
- `usl`
- `target`

Produces:
- `CAPABILITY_ANALYSIS_COMPLETED`
- `CAPABILITY_BELOW_TARGET`

### run-msa-analysis

Consumes:
- `MSA_STUDY_REQUESTED`
- `NEW_DEVICE_REGISTERED`

Produces:
- `MSA_ANALYSIS_COMPLETED`
- `MSA_VALIDATED`
- `MSA_NOT_ACCEPTABLE`

## UI model

The UI supports three input modes:

1. External Tool Event
2. Manual Input
3. Raw JSON Event

It checks compatibility against four statuses:

- `COMPATIBLE`
- `MISSING DATA`
- `NOT CONSUMABLE`
- `NEEDS EXTERNAL-ADMIN CONFIRMATION`

## What is real

- independent tool structure
- handlers
- demo payloads
- local compatibility engine
- manual input simulation
- event ledger structure
- broker-style UI flow

## What is mock

- real Event Bus connection
- real PostgreSQL persistence
- real polling
- real downstream execution
- MARLI adapter

## Questions for [EXTERNAL_ADMIN]

1. What are the official tool IDs for our tools?
2. Should we use `/events/subscriptions/:toolId` as the main consume pattern?
3. Should `MEASUREMENTS_CAPTURED` include `lsl`/`usl`/`target`?
4. Should `MSA_STUDY_REQUESTED` become an official event?
5. Who produces `MSA_STUDY_REQUESTED`?
6. Should `CAPABILITY_BELOW_TARGET` trigger `manage_product_specs`, `audit_report`, or `manage_nonconformances`?
7. Should `MSA_NOT_ACCEPTABLE` trigger `manage_nonconformances`?
8. Where do the official contracts live: IsoTools, industrial-api-v2, or a shared package?

## Message draft for [EXTERNAL_ADMIN]

> Qué onda [EXTERNAL_ADMIN], sí ya le eché un ojo al repo y al README-PROGRAMADORES.
>
> Entendí que el modelo correcto es broker de eventos: la tool no habla
> directo con otra tool, publica con POST /events y consume por
> GET/polling, especialmente con /events/subscriptions/:toolId. También vi
> que la API key va por x-api-key y no debe vivir en frontend.
>
> De nuestro lado ya avanzamos una repo independiente para Angel + Joaquín
> con dos tools separadas: calculate-cpk-ppk y run-msa-analysis. La idea es
> "separate ownership, unified contracts": cada tool mantiene su lógica,
> pero se conecta por eventos estándar.
>
> También armamos una UI local tipo Quality Tools Workspace donde se puede
> simular External Tool Event, Manual Input o Raw JSON Event; la UI valida
> si el evento es compatible con la tool, si faltan campos, si no es
> consumible o si necesita confirmación contigo. Por ejemplo, si entra
> MEASUREMENTS_CAPTURED puede ir a calculate-cpk-ppk; si entra
> NONCONFORMANCE_CREATED de [DEVELOPER] lo marcamos como needs
> confirmation/adaptador, no lo fingimos compatible.
>
> Nos falta confirmar contigo los event types oficiales, el envelope exacto
> y si MSA_STUDY_REQUESTED lo dejamos como evento oficial. Hoy puedo
> enseñarte el flujo y las preguntas concretas para alinear nuestras tools
> al README nuevo.
