# Entrega de validación AJTool para ORCA

12 de noviembre de 2026 · Ensayo Integral IsoTools v1.1 · [PR 4 y comprobaciones](https://github.com/aoso-md/AJTool/pull/4/checks)

| Flujo | Entrada observada | Estudio | Salida AJTool | Entrega Core | Consumidor | Estado |
|---|---|---|---|---|---|---|
| MDR → MSA → CCC | Carlos reportó `NEW_DEVICE_REGISTERED` en Core e instrumento visible en MSA. ID, secuencia y sobre reales **NO DISPONIBLE**. | MSA Gage R&R. ID del pendiente real **NO DISPONIBLE**. | `MSA_VALIDATED` aceptable y no aceptable comprobados localmente. ID real **NO DISPONIBLE**. | Cero POST en simulación shadow. ID y acuse de Core real **NO DISPONIBLE**. | `calculate_control_charts` (Alejandro). Recepción y efecto SPC desplegados pendientes. | Aprobado localmente. Entrada e instrumento reportados por Carlos. Guardado y entrega reales pendientes. |
| CQM → CPK → MPS | César reportó `MEASUREMENTS_CAPTURED` en Core. ID, secuencia y sobre reales **NO DISPONIBLE**. | Cpk/Ppk. Estudio, límites, versión y resultados reales **NO DISPONIBLE**. | `CAPABILITY_BELOW_TARGET` bajo objetivo. Caso capaz sin aviso. ID real **NO DISPONIBLE**. | Cero POST en simulación shadow. ID y acuse de Core real **NO DISPONIBLE**. | `manage_product_specs` (Demian). Recepción, efecto y corte de ciclo pendientes. | Aprobado localmente. Entrada reportada por César. Consumo CPK y entrega reales pendientes. |

Para este ensayo, **observado en Core real** requiere una fila saneada identificada por ID. **Observado en consumidor desplegado** requiere la recepción del mismo ID y evidencia de su efecto. **Fallido** identifica una incompatibilidad reproducida. La entrega por tipo en el Core de referencia permite que CCC reciba ambos veredictos. La prueba desplegada debe comprobar que el no aceptable carece de efecto SPC.

## Evidencia reproducida

[JSON exactos de la ejecución sintética](AJTOOL-ORCA-VALIDATION-SYNTHETIC.json) contiene los sobres completos de entrada y salida, observaciones MSA, secuencia, IDs de estudios, correlación y causalidad. Los IDs pertenecen a la simulación. [Contratos y fixtures de referencia](AJTOOL-EVENT-CONTRACTS.md)

| Caso sintético | Cálculo y resultado | Salida |
|---|---|---|
| MSA aceptable | AIAG promedio y rango. Dos piezas × dos operadores × dos ensayos. %GRR 0.94, repetibilidad 0.001329, reproducibilidad 0, ndc 149. | `d95a54f4-2273-5a7f-864b-29380ecaacbd`, `acceptable`, shadow. |
| MSA no aceptable | Mismo diseño. %GRR 99.91, repetibilidad 0.420945, reproducibilidad 0, ndc 0. | `06d8831f-2092-5cde-92a7-118deb19bafc`, `unacceptable`, shadow. |
| CPK bajo objetivo | `ENS-PZA-001` / `CTQ-DIAM-001`, 34 mediciones, LSL 24.95, USL 25.05, especificación v1. Cp 0.8499, Cpk 0.6649, Pp 0.6933, Ppk 0.5424. Umbral Cpk 1.33. | `1dac913f-8f15-5e1e-b4f2-0edf942b15c2`, `not_capable`, shadow. |
| CPK capaz | Misma especificación, seis mediciones. Cp y Cpk 15.6667, Pp y Ppk 18.6339. | `not_required`, sin ID de salida. |

MSA mostró el pendiente y la traza de origen. El cálculo previo dejó el estudio pendiente, la entrada inválida devolvió 422 y editar una lectura invalidó la vista previa. El guardado produjo el sobre y reentregar la entrada conservó el mismo estudio. Se revisaron en navegador el flujo MSA y los detalles CPK. El motor MSA conserva sus umbrales predeterminados de %GRR 10 y 30 y ndc mínimo 5. PostgreSQL aislado en CI verifica persistencia tras reabrir conexión, deduplicación, rechazo, cursor y estado `shadow_recorded`. Una revisión aislada de especificación actualiza la caché CPK. Una nueva captura con ID diferente sí puede generar otro aviso aunque conserve la correlación. [Ensayo PostgreSQL](../db/test/ensayo-v11.test.mjs)

| Estado | Lectura operativa |
|---|---|
| `shadow_recorded` (PostgreSQL), `shadow` (RAM) | Sobre preparado en simulación. No hay POST ni acuse del Core. |
| `pending`, `delivering`, `retry_wait` | Salida live por entregar, en curso o esperando reintento. |
| `published`, `duplicate` (estudio), `delivered` (outbox) | Core acusó el ID. La recepción y el efecto downstream requieren su propia prueba. |
| `failed` (RAM), `blocked_auth`, `blocked_destination`, `quarantined` (outbox) | Entrega fallida, bloqueada o en cuarentena. Revisar la clase de error y el estado exacto. |
| `not_required` | El estudio no requiere aviso. |

## Diagnóstico privado por ID

`/ready` y `/api/status` ya muestran modo, persistencia, estado del poller y cursor. `/api/studies/<studyId>` permite comprobar la presentación de un estudio identificado. El comando `replay status` agrega totales y carece de una búsqueda por evento. Para PostgreSQL, la [consulta de sólo lectura](../db/review/trace-orca-event.sql) cruza el inbox, estudio, rechazo, cursor y outbox. Devuelve productor, resultado de validación, estado del estudio, IDs de linaje y clase de error. Acepta un ID de entrada o uno del outbox. Ejecútala desde un entorno privado con conexión PostgreSQL autorizada y credenciales configuradas localmente.

```powershell
psql -XqAt -v tool=run_msa_analysis -v "event_id=$EventId" -f db/review/trace-orca-event.sql
psql -XqAt -v tool=calculate_cpk_ppk -v "event_id=$EventId" -f db/review/trace-orca-event.sql
```

La consulta omite sobres completos, mediciones, metadatos y texto libre de errores. Si `received` es `null`, esa base carece de evidencia de recepción para la entrada. Si hay estudio sin fila de inbox, `receipt_recorded` vale `false`. `study.found=false` indica que hay una referencia al estudio sin la fila correspondiente. Para los dominios en RAM, el operador debe revisar la instancia activa mediante el detalle de estudio o registros privados por ID. La lista de estudios está limitada a 200 y una ausencia en ella no permite concluir que se perdió el evento. Si hay que inspeccionar un sobre real, hacerlo dentro del entorno autorizado y compartir únicamente el extracto saneado.

## Lectura de los dominios desplegados

Consulta de sólo lectura del 12/11 a las 09:25 Denver. Ambos `/ready` respondieron HTTP 200 en `memory`, `durable=false` y `shadow`. `/api/status` mostró Core configurado, polling activo en `idle`, último poll exitoso y sin clase de error actual. El cursor MSA era **71720** y el CPK **74697**. Revisión desplegada de ambas herramientas y de ORCA Core **NO DISPONIBLE**. Tampoco se pudo vincular el cursor, un rechazo o un estudio con los eventos del ensayo sin sus IDs y filas. [MSA /ready](https://rma.orcalabs.mx/ready) · [CPK /ready](https://ccp.orcalabs.mx/ready)

Para una lectura dirigida, el operador de Core recupera la fila exacta por `event_id` y verifica si aparece en la suscripción de la herramienta con `GET /api/v1/events/subscriptions/<tool>?since_seq=<seq-1>&limit=100`, con su acceso existente de sólo lectura. Registra si falta en la suscripción, si el cursor sigue atrás, si hay un resultado de validación o si existe un estudio oculto por filtros de la interfaz. Si el cursor alcanzó la secuencia y falta evidencia, revisar la revisión activa, el arranque del poller, el filtro por productor/tipo, registros de rechazo y el almacenamiento de esa instancia. El cursor por sí solo no acredita recepción. No reinyectar eventos ni mover cursores para diagnosticar.

## Ensayo conjunto

1. **Carlos y AJTool, primero MSA.** Recuperar el `NEW_DEVICE_REGISTERED` ya registrado. Anotar `event_id`, `seq`, `module.id`, `asset.asset_id`, `operation`, `gaugeId` y los dos IDs de linaje. Comparar sobre y fila con el contrato y buscar el estudio existente por `inputEventId`. Confirmar instrumento, origen y estado en la interfaz. Si está pendiente y se dispone de observaciones reales autorizadas, revisar el cálculo y guardarlo una vez en shadow. Si ya está completado, recuperar su sobre existente. Para validar un diseño con datos sintéticos, usar un instrumento de ensayo aislado. Registrar `studyId`, `event_id` de salida, correlación, causa, veredicto y estado.
2. **César y AJTool, después CPK.** Recuperar `MEASUREMENTS_CAPTURED`, su fila de suscripción y la versión vigente de la especificación al recibirlo. Conservar productor, `event_id`, `seq`, pieza, característica, `measurements`, `defectsFound`, correlación y causa. Comparar el estudio por ID con muestra, LSL, USL, versión, tamaño, Cp, Cpk, Pp, Ppk y criterio. Registrar el motivo si la entrada fue rechazada o quedó pendiente. Registrar salida sólo cuando proceda y comprobar el caso capaz sin aviso en el ensayo aislado.
3. **Alejandro y Carlos.** Con los dos sobres MSA, registrar recepción de ambos por tipo y decisión de CCC. El aceptable debe producir el efecto SPC acordado. El no aceptable debe quedar sin ese efecto, incluso si la suscripción lo entrega.
4. **Demian y César.** Para un aviso CPK autorizado, registrar recepción y decisión de MPS sobre pieza, característica y versión. Comprobar una sola actualización al repetir el mismo ID. César confirma que la actualización no provoca nuevas mediciones sin captura. Detener el ensayo si aparece otro `MEASUREMENTS_CAPTURED` bajo la misma correlación sin una captura real. Si hay incompatibilidad, registrar productor, consumidor, campo recibido, campo esperado e ID reproducible.
5. **Carlos y operador de publicación.** Acreditar las revisiones desplegadas y acordar una ventana posterior para publicar. Confirmar antes los requisitos del [procedimiento de corte](CUTOVER-20261110.md). Para cada salida, anotar ID y acuse de Core, luego corroborar la recepción y el efecto con su consumidor.

| Responsable | Evidencia pendiente |
|---|---|
| Carlos | IDs, secuencias, sobres y filas saneadas de MDR y CQM. Revisión de Core y de cada servicio. Ventana autorizada para publicar. |
| Alejandro | Registro de recepción y decisión de CCC ante ambos veredictos. |
| César | DTO real de CQM con tipos y mediciones autorizadas para comparación privada. Evidencia de que una revisión de MPS no inicia otra captura. |
| Demian | DTO consumido por MPS, resolución de versión y evidencia de una única actualización y ausencia de ciclo. |

Compartir IDs y extractos saneados por el canal autorizado del equipo. Las credenciales permanecen con el operador.
