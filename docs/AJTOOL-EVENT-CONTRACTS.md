# Contratos de eventos AJTool ↔ ORCA

**Referencia:** PR-ORCA-ENS-001, *Ensayo Integral IsoTools v1.1*, 21 de octubre de 2026. Se revisó el código autorizado de Core `feature/filter` en `564d78f41389aedafb47695849ec12f5af2a8197` y se comparó con [AJTool PR 4](https://github.com/aoso-md/AJTool/pull/4). El SHA identifica el Core de referencia. La revisión desplegada y los DTO de los servicios federados de terceros no se certificaron.

## Matriz de compatibilidad

**PASS** significa que el tramo de AJTool se reprodujo con el validador de referencia o el Core simulado, según se indica. **FAIL** es un comportamiento incompatible observado. **BLOCKED** indica que falta evidencia del servicio federado real.

| Evento y dirección | Productor → consumidor, por Core | Regla / ensayo | Resultado |
|---|---|---|---|
| [`NEW_DEVICE_REGISTERED`](../db/test/fixtures/orca-events/NEW_DEVICE_REGISTERED.json) · entrada MSA | `manage_device_registry` → `run_msa_analysis` | `rule-pkg-004`, `operation == 'register'` · PV-1.1/1.2 | **PASS** forma de referencia, sobre IES, fila plana, registro y creación de estudio. **BLOCKED** confirmación del JSON de MDR federado. |
| [`MSA_VALIDATED`](../db/test/fixtures/orca-events/MSA_VALIDATED.json) · salida MSA | `run_msa_analysis` → `calculate_control_charts` (CCC) | `rule-pkg-005`, `verdict == 'acceptable'` · PV-1.2/1.3/1.4 | **PASS** JSON exacto de AJTool, IES, traza y shadow. **FAIL** para la lectura literal de PV-1.4 en el Core de referencia: la suscripción filtra por tipo. **BLOCKED** el efecto real en CCC. |
| [`MEASUREMENTS_CAPTURED`](../db/test/fixtures/orca-events/MEASUREMENTS_CAPTURED.json) · entrada CPK | `collect_quality_measurements` (CQM) → `calculate_cpk_ppk` | `rule-pkg-006`, `defectsFound >= 0` · tramo de PV-2.6 | **PASS** forma de referencia, fila plana, resolución de límites y cálculo. **BLOCKED** confirmación del JSON de CQM federado. |
| [`CAPABILITY_BELOW_TARGET`](../db/test/fixtures/orca-events/CAPABILITY_BELOW_TARGET.json) · salida CPK | `calculate_cpk_ppk` → `manage_product_specs` (MPS) | `rule-qual-005`, `cpk < 1.33 OR status == 'not_capable'` · PV-2.6 | **PASS** JSON exacto de AJTool, IES, traza y shadow. **BLOCKED** recepción en MPS federado y corte del ciclo entre servicios. |

## Sobre, almacenamiento y entrega

El JSON exacto de cada ejemplo está enlazado en la matriz. Los datos son sintéticos. Core recibe el sobre anidado por `POST /api/v1/events` con scope `events:write`. La suscripción `GET /api/v1/events/subscriptions/:consumerToolId` requiere `events:read`. Los paths REST que figuran en las notas de comunicación describen aristas del Router. AJTool intercambia eventos mediante Core.

| Campo del sobre | Validador de la ingesta de referencia |
|---|---|
| `event_id`, `timestamp`, `platform_version` | Obligatorios. ID y versión son strings de longitud mínima 1. Fecha string `date-time`. IES documenta UUID y UTC, pero AJV acepta IDs no UUID y fechas con offset válido. AJTool genera UUID y fecha UTC. |
| `module` | Obligatorio. `id` y `version` son strings obligatorios. `module.version` identifica al emisor. |
| `asset` | Obligatorio. `asset_id` es string obligatorio. `asset_type`, `plant_id`, `area_id`, `line_id`, `location` son strings opcionales y admiten null. AJV admite `asset_id` vacío o sólo espacios. AJTool requiere una identidad utilizable para emitir el hijo. |
| `event` | Obligatorio. `type` es string obligatorio. `category` y `severity` son strings opcionales y admiten null. El catálogo IES documenta categorías y severidades. El validador no impone esos enums. |
| `data`, `metadata` | Objetos opcionales en la ingesta. Admiten claves arbitrarias. El almacenamiento usa `{}` cuando faltan. El documento IES describe `data` como obligatorio. |
| `correlation_id`, `causation_id` | Strings opcionales, admiten null. La ingesta usa `event_id` como correlación cuando falta o es vacía. La causa ausente se guarda como null. |

Core guarda el evento en `industrial_events`. Aplana `module`, `asset` y `event` en columnas como `module_id`, `asset_id` y `event_type`. Conserva `data` y `metadata` como JSONB. PostgreSQL asigna `seq` BIGINT. La suscripción devuelve filas planas, seleccionadas por `consumes` y `since_seq`. AJTool normaliza ambas formas y conserva cursores enteros exactos. La suscripción no evalúa el predicado de la arista. Las herramientas federadas se delegan y consumen por poll.

Con el índice único de `event_id`, Core inserta mediante `ON CONFLICT DO NOTHING`, devuelve `200 duplicate` y no vuelve a iniciar la cadena. El código conserva una rama para instalaciones sin ese índice, donde esa garantía no aplica. AJTool deduplica por herramienta e ID de entrada y trata un cambio de contenido bajo el mismo ID como conflicto en su inbox durable. Para hijos AJTool calcula UUIDv5 a partir de herramienta, tipo de salida e ID de entrada. Hereda correlación y fija causa al ID de entrada, incluso cuando la entrada tenía su propia causa. Un envío manual raíz tiene causa null y usa su ID como correlación.

### Versionado y esquemas

El esquema AJV de `src/services/validationService.js` gobierna la ingesta. `src/data/agents/event-standard.json` describe IES **1.0**. Los `inputSchema` y `outputSchema` de `tools.json` describen operaciones del catálogo. Por ejemplo, el esquema de operación de CCC exige `characteristicId`, `chartType` y `measurements`. El evento de validación MSA tiene un veredicto y métricas del instrumento. Las notas de comunicación consultadas dejan `data` sin detallar y el Core revisado carece de un JSON Schema ejecutado por cada uno de estos cuatro eventos.

`platform_version` y `module.version` existen. La ingesta comprueba tipos y no negocia versiones de `data`. No hay soporte de `schema_version` en el sobre. Con `additionalProperties: false` y `removeAdditional: true`, el Core de referencia elimina claves desconocidas del sobre y de `module`, `asset` y `event`. Una copia del validador en las pruebas exige un sobre limpio y también se prueba la configuración del Core que elimina extras. `data.schema_version` sobreviviría como dato arbitrario, sin semántica de versión. Cambios aditivos dentro de `data` requieren confirmar que los consumidores toleran campos nuevos. Para cambios incompatibles, acordar con Carlos validación y compatibilidad explícitas por tipo y versión, con lectura dual o un nuevo tipo registrado. Este PR mantiene el IES vigente.

## DTO observados

Los campos de esta tabla describen productores y consumidores implementados. AJV sólo comprueba que `data`, si está presente, sea objeto. Los stubs del Core sirven como referencia para los DTO federados.

| Evento | Campos del productor y requisitos del consumidor |
|---|---|
| `NEW_DEVICE_REGISTERED` | El productor de referencia emite `operation` (string `register`), `gaugeId` (string), `devices` (arreglo de objetos `id`, `type`, `nextCalibration`), `totalDevices` (entero), `operationResult` (string `registered`). AJTool exige `operation=register` y usa `gaugeId → devices[0].id → deviceId → asset.asset_id`. `observations` o `measurements` de objetos son extensiones opcionales de entrada de AJTool. Observación canónica: `partId`, `operatorId`, `trial`, `value`. Un registro ordinario crea un pendiente para captura Gage R&R. |
| `MSA_VALIDATED` | AJTool emite `gaugeId`, `studyType=gage_rr`, `gageRRPercent`, `repeatability`, `reproducibility`, `ndc` y `verdict` (`acceptable`, `marginal`, `unacceptable`). El porcentaje GRR corresponde a variación del estudio, separado de `contributionPercent`. También emite `method`, `parts`, `appraisers`, `trials`, `partVariation`, `totalVariation`, `contributionPercent`, `acceptanceCriteria` (objeto de umbrales o null), `criteriaVersion` (entero o null) y `studyId` (string). El Router usa sólo `verdict`; falta verificar qué consume CCC federado. |
| `MEASUREMENTS_CAPTURED` | El productor de referencia emite `partId`, `characteristicId` (strings), `measurements` (arreglo de números), `passFailResult` (string, p. ej. `pass`) y `defectsFound` (entero). CPK necesita una muestra numérica finita con variación y límites válidos. Admite números en strings por compatibilidad y descarta muestras mal formadas. Usa `partId` y `characteristicId` para la especificación, o `lsl` y `usl` inline si llegan válidos. `minimumCpk` opcional. El predicado de `defectsFound` pertenece al Router. CPK consume por tipo y su cálculo no lee ese campo. |
| `CAPABILITY_BELOW_TARGET` | AJTool emite `partId`, `characteristicId` (strings o null), `cp`, `cpk`, `pp`, `ppk`, `sigmaLevel`, `ppmDefects`, `status` (clasificación `capable/marginal/not_capable`, se emite bajo el umbral efectivo), `minimumCpk`, `minimumCpkSource` (string o null), `criteriaVersion` (entero o null), `usl`, `lsl`, `specVersion` (string o null), `sampleSize`, `mean`, `sigmaWithin`, `sigmaOverall` y `studyId`. Los límites inline no llevan una versión de catálogo. El Router usa `cpk` y `status`; el handler de referencia de MPS lee `partId` y `characteristicId`. `action` es un campo de operación de MPS y no forma parte del aviso AJTool. |

## Diferencias demostradas y cambios

- **Identidad del activo.** Recibido sintético: `"asset":{"asset_id":""}`. Esperado para producir un hijo: un `asset_id` utilizable, por ejemplo `"ENS-CAL-001"`. El validador de Core lo aceptó. Antes, MSA con observaciones lanzaba al construir el hijo y CPK registraba error de construcción. En el camino durable la excepción podía impedir avanzar el cursor. AJTool ahora guarda el estudio omitido con motivo y el inbox lo marca rechazado, sin outbox. El cursor puede seguir con el siguiente evento. Carlos puede acordar una validación de identidad al ingreso de Core tras revisar otros productores.
- **MSA negativo.** El JSON publicado conserva `data.verdict: "unacceptable"`. La condición 005 falla y no se crea su arista; la suscripción por tipo todavía puede entregarlo. Al invocar directamente el handler nativo de referencia, éste devuelve `CHART_POINTS_UPDATED` incluso para ese JSON. En el registro revisado CCC está federado, por lo que esa prueba identifica el riesgo del contrato y deja el efecto desplegado abierto. Carlos y CCC deben acordar la evidencia de PV-1.4. Si se exige que el evento no llegue, hace falta un filtro de suscripción. Si se exige ausencia de efectos, CCC debe reconocer el evento y omitir la actualización SPC cuando el veredicto difiere de `acceptable`.
- **Mediciones.** JSON de referencia `"measurements":[25,25.01],"defectsFound":0`. Variantes sintéticas `"measurements":[{"value":25},25.01]` se omiten en CPK. Sin `defectsFound`, la regla 006 falla, aunque CPK puede recibir y calcular por poll. Carlos y CQM deben confirmar el formato de la muestra y `defectsFound` en los envelopes reales. No se impuso un campo nuevo en el consumidor.
- **Aviso CPK.** Con un umbral configurado superior a 1.33, AJTool puede emitir una clasificación `marginal` con `cpk >= 1.33` que la regla 005 de calidad no enruta. La suscripción puede entregarlo por tipo. Para el ensayo acordar umbral 1.33 y verificar que MPS identifica la especificación correcta en el JSON, incluidas las versiones si las necesita.
- **R5 del ensayo.** Omitir `asset` o enviar `data: []` es inválido. Una clave adicional en el sobre se elimina en la revisión consultada, mientras el procedimiento espera 400 para un campo fuera del estándar. Carlos debe distinguir esos dos casos al ejecutar R5.

## Corte del ciclo CPK

Se reprodujeron tres casos con PostgreSQL aislado. Una revisión `PRODUCT_SPEC_UPDATED` sólo actualiza la caché de AJTool. Una reentrega del mismo ID no genera otro aviso. Una medición nueva con ID distinto y la misma correlación sí puede producir otro `CAPABILITY_BELOW_TARGET`. El handler nativo de referencia de MPS emite una actualización y el de CQM genera mediciones a partir de esa actualización. En el flujo federado, el límite de profundidad y el conjunto de aristas ya disparadas del Router se reinician en cada nueva ingesta. La evidencia no acredita un corte global.

Carlos, MPS y CQM deben demostrar en shadow que la revisión cambia el plan y que únicamente una nueva captura real emite mediciones. Una captura debe tener una identidad de negocio estable en sus reintentos. Verificar la cadena y detener la prueba si aparece una segunda captura sin estímulo real.

## Pruebas y evidencia

- Desde la raíz con Node.js 22 y las dependencias de ambos servicios instaladas, ejecutar `node --test db/test/event-contracts.test.mjs`. Valida los cuatro fixtures, mutaciones de sobre y DTO, salidas exactas, dedupe, correlación, causa y cero POST al Core simulado. El test compara campos dinámicos por separado de los valores de fixture.
- Con Docker, ejecutar `node db/test/run-postgres-tests.mjs --only=ensayo-v11`. Verifica rechazo durable de activos inválidos, continuidad del cursor, captura MSA, replay, dedupe y el caso CPK con un nuevo ID. CI ejecuta PostgreSQL 16 y 17. [Checks del PR](https://github.com/aoso-md/AJTool/pull/4/checks)
- Se contrastó el validador autorizado de referencia en una prueba local, además de los handlers nativos y predicados relevantes. Los fixtures y pruebas reproducibles del PR no contienen código privado adicional ni datos industriales.
- Para cerrar las cuatro filas con servicios federados, Carlos debe aportar cuatro muestras saneadas o habilitar una ventana en shadow con revisión identificada. Registrar el sobre de ingreso, la fila de suscripción, la decisión del consumidor y los IDs de causa y correlación.
