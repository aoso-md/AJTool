# Contrato con la plataforma

Fuente de verdad: el repo del core (`carcamfer/IsoTools`, rama
`feature/filter`). Este documento resume lo que esas fuentes dicen para estas
dos tools, y qué cambió respecto a la versión anterior de este repo.

| Fuente en el core | Qué define |
|---|---|
| `src/data/agents/event-standard.json` + `src/services/validationService.js` | El sobre de todo evento (Industrial Event Standard) |
| `src/data/agents/tools.json` | Qué consume y produce cada tool, y sus esquemas |
| `src/data/agents/communication-rules.json` | Quién recibe qué, y con qué condición |
| `src/tools/<tool>.js` | El handler de referencia (mock) de cada tool |
| `src/services/eventBus.js` | Cómo arma el bus un evento hijo |

---

## El sobre (Industrial Event Standard)

```json
{
  "event_id": "uuid",
  "timestamp": "ISO-8601",
  "platform_version": "1.0",
  "module":   { "id": "calculate_cpk_ppk", "version": "2.0.0" },
  "asset":    { "asset_id": "…", "asset_type": "…", "plant_id": "…", "area_id": "…", "line_id": "…", "location": "…" },
  "event":    { "type": "CAPABILITY_BELOW_TARGET", "category": "quality", "severity": "high" },
  "data":     { … },
  "metadata": { … },
  "correlation_id": "…",
  "causation_id": "event_id del evento que lo causó"
}
```

El core valida con `additionalProperties: false` en el sobre, en `module`, en
`asset` y en `event`: cualquier campo extra ahí es un `400`. Dentro de `data`
y `metadata` el contenido es libre.

Un evento producido en respuesta a otro hereda `asset`, `metadata`,
`platform_version` y `correlation_id`, y lleva `causation_id` = el `event_id`
del padre — igual que `buildChildEvent` en `eventBus.js`. Estas tools derivan su
`event_id` del padre (UUID v5), así que reprocesar un evento produce el mismo
id y el core lo descarta como duplicado.

**Lo que se recibe por suscripción no es el sobre**, son filas planas de
`industrial_events` (`event_type`, `asset_id`, `module_id`, `seq`, …).
`src/platform/ies.js` lee los dos formatos.

---

## `calculate_cpk_ppk`

| | |
|---|---|
| Consume | `MEASUREMENTS_CAPTURED` (de `collect_quality_measurements`, regla `rule-pkg-006`) |
| `data` que lee | `partId`, `characteristicId`, `measurements[]` · opcional `usl`, `lsl`, `minimumCpk` |
| Lee además | `PRODUCT_SPEC_UPDATED` (de `manage_product_specs`): `partId`, `characteristics[].id/usl/lsl/version` |
| Produce | `CAPABILITY_BELOW_TARGET` → `manage_product_specs` (regla `rule-qual-005`: `cpk < 1.33 OR status == 'not_capable'`) |
| `data` que escribe | contrato: `partId`, `characteristicId`, `cp`, `cpk`, `pp`, `ppk`, `sigmaLevel`, `ppmDefects`, `status` (`capable \| marginal \| not_capable`) · trazabilidad: `minimumCpk`, `minimumCpkSource`, `criteriaVersion`, `usl`, `lsl`, `specVersion`, `sampleSize`, `mean`, `sigmaWithin`, `sigmaOverall`, `studyId` |
| Cuándo publica | solo si `cpk < minimumCpk` (1.33 por defecto). Un proceso capaz se registra y no se publica, como el handler de referencia. |
| Si falta la spec | el estudio queda **omitido** con la razón; no se publica nada |

El Cpk mínimo (1.33 por defecto) y el límite de «marginal» (1.0) son editables en la tool (pestaña Criterios). Precedencia: valor del evento o del formulario > excepción de la característica > valor general. Los campos `minimumCpkSource` y `criteriaVersion` dicen cuál se aplicó.

Cp/Cpk usan σ dentro (rango móvil / 1.128); Pp/Ppk usan σ global (n − 1).
`sigmaLevel = 3 · Cpk` (misma convención que el handler de referencia).
`ppmDefects` = ppm esperado fuera de especificación con σ global.

## `run_msa_analysis`

| | |
|---|---|
| Consume | `NEW_DEVICE_REGISTERED` (de `manage_device_registry`, regla `rule-pkg-004`: `operation == 'register'`) |
| `data` que lee | `operation`, `gaugeId` (o `devices[0].id`) · las lecturas **no vienen en el evento** |
| Produce | `MSA_VALIDATED` → `calculate_control_charts` (regla `rule-pkg-005`: `verdict == 'acceptable'`) |
| `data` que escribe | contrato: `gaugeId`, `studyType`, `gageRRPercent`, `repeatability`, `reproducibility`, `ndc`, `verdict` (`acceptable \| marginal \| unacceptable`) · trazabilidad: `method`, `parts`, `appraisers`, `trials`, `partVariation`, `totalVariation`, `contributionPercent`, `acceptanceCriteria`, `criteriaVersion`, `studyId` |
| Cuándo publica | cuando se captura el estudio de un equipo registrado (hijo del registro), o al publicar explícitamente un estudio sin registro. Publica para **todo** veredicto; la regla del core solo enruta `acceptable`. |

Gage R&R por el método AIAG de promedios y rangos (2–3 operadores, 2–3
ensayos, 2–10 piezas). Aceptable: %GRR < 10 y ndc ≥ 5 · marginal: 10–30 (o
ndc < 5) · inaceptable: > 30. Son los valores AIAG por defecto; la planta puede
ajustarlos (pestaña Criterios) y el evento lleva dentro `acceptanceCriteria`, con
los umbrales con que se juzgó, para que quien lo reciba no tenga que adivinar.

---

## Qué cambió respecto a la versión anterior de este repo

| Antes | Ahora | Por qué |
|---|---|---|
| Esperaba que la llamaran (`POST /events`) | Consume por poll `/events/subscriptions/:toolId` | Así funcionan las tools federadas: nadie las llama |
| Sobre propio `{ type, payload }` | Industrial Event Standard | El core rechaza cualquier otro formato |
| Exigía `lsl`, `usl`, `target` en la medición | Toma los límites de `PRODUCT_SPEC_UPDATED` | La medición real no los trae |
| "Cpk" calculado con σ global | Cp/Cpk con σ dentro, Pp/Ppk con σ global | El contrato pide ambos; lo anterior era Ppk |
| Esperaba lecturas dentro del registro del equipo | Estudio pendiente + captura humana | El registro real no las trae |
| `MSA_NOT_ACCEPTABLE` (no oficial) | El veredicto va dentro de `MSA_VALIDATED` | Así lo define `tools.json` |
| `CAPABILITY_ANALYSIS_COMPLETED`, `MSA_ANALYSIS_COMPLETED` | Eliminados | No existen en el contrato de la plataforma |
| Bus propio (`bus-proxy`) | El bus es el core | El core ya ofrece suscripción, cadena y evidencia |
| Interfaz clara propia | Tema Control Room de la plataforma | Obligatorio para tools con pantalla |
