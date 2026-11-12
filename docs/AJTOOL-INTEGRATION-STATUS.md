# Cierre funcional de AJTool con ORCA

Actualizado el 11 de noviembre de 2026, hora de Denver. Referencia del ensayo: PR-ORCA-ENS-001 v1.1. [Contratos y fixtures](AJTOOL-EVENT-CONTRACTS.md) · [PR 4 y CI](https://github.com/aoso-md/AJTool/pull/4/checks)

| Evento | Contrato | Prueba aislada | Evidencia de integración real | Pendiente |
|---|---|---|---|---|
| `NEW_DEVICE_REGISTERED` | IES y productor `manage_device_registry` | **PASS** registro, origen, estudio pendiente y duplicados | Carlos reportó evento visible e instrumento en MSA | Correlacionar la fila del Core, el estudio y la revisión que lo consumió con JSON saneado |
| `MSA_VALIDATED` | IES y veredicto explícito | **PASS** revisión sin escritura, captura, salida exacta y shadow | **BLOCKED** entrega y efecto real en CCC | Validar aceptable y no aceptable con Alejandro/Carlos |
| `MEASUREMENTS_CAPTURED` | IES, productor `collect_quality_measurements` y especificación | **PASS** cálculo y negativos de tipo, productor y payload | César reportó generación tras registrar mediciones. Consumo CPK real **BLOCKED** | Recuperar fila exacta, versión de la especificación y estudio CPK por ID |
| `CAPABILITY_BELOW_TARGET` | IES, métricas, pieza y característica | **PASS** baja capacidad, caso capaz sin aviso, cursor y dedupe | **BLOCKED** entrega y efecto real en MPS | Verificar una sola revisión y ausencia de nueva captura sin estímulo real |

Los reportes del equipo acreditan lo observado por sus operadores. Faltan sobres, filas y revisiones para certificar los cuatro contratos en la integración desplegada.

## Cambios y evidencia

- MSA separa **Revisar cálculo** de **Guardar estudio**. El cálculo usa el motor y los criterios del servidor. Cambiar las lecturas, el diseño o el equipo invalida la vista previa. Guardar recalcula con los criterios vigentes. Las capturas Gage R&R usan 2–10 piezas, 2–3 operadores y 2–3 ensayos por operador y pieza.
- Ambos consumidores validan el tipo exacto y el productor en RAM y PostgreSQL. Los estudios nuevos conservan el productor de entrada. El detalle presenta tipo de salida, correlación, causa y estado de publicación. Una salida registrada en shadow se muestra como no enviada. La vista Integración ya muestra cursor y si el almacén es durable. El outbox conserva su control de acceso existente.
- Los fixtures y casos negativos se ejecutan contra Core simulado. PostgreSQL aislado comprueba que el cálculo previo no cambia el pendiente, la captura persiste, y replay y duplicados conservan la traza. El negativo MSA modela la decisión de CCC, cuyo efecto desplegado requiere evidencia. CPK contrasta Cp 0.8499, Cpk 0.6649, Pp 0.6933 y Ppk 0.5424. También persiste un resultado capaz sin alerta.
- La prueba de retroalimentación recorre tres rondas acotadas. Una revisión sola no genera salida. Cada medición nueva con ID distinto puede generar otra alerta bajo la misma correlación. Reentregar ese mismo ID no suma estudios. El corte global corresponde a CQM y MPS. El Core simulado recibe cero POST en shadow. Los logs identificados por `ensayoV11` conservan IDs de estudio, entrada, salida, causa, correlación y cursores. [Comprobaciones](https://github.com/aoso-md/AJTool/pull/4/checks)
- Se verificaron en navegador las dos interfaces servidas localmente. MSA abrió el pendiente, calculó sin guardar, invalidó el resultado previo al editar una lectura y guardó con %GRR **0.94**. CPK mostró **0.188** en su estudio sintético. Ambos detalles mostraron shadow y evento causante. IDs sintéticos de salida: MSA `0dfe1a24-1992-5c57-8e40-25596b575bda` y CPK `8c7d8073-f608-51fa-ab97-4234ed974459`.

### Estado de los dominios

La lectura de `/ready` el 11 de noviembre mostró HTTP 200, `shadow`, `memory`, `durable=false` y revisión sin identificar en ambos servicios. Cursores observados: CPK **74697** y MSA **71720**. Un cursor demuestra avance del consumidor, sin identificar por sí solo las filas del ensayo. La sesión CLI de Railway no dio acceso al inventario. `railway init` fue observado previamente pausado por créditos y el destino de `RAILWAY_TOKEN_CCP` y `RAILWAY_TOKEN_RMA` sigue sin acreditarse. La prueba local usa PostgreSQL aislado. [CPK /ready](https://ccp.orcalabs.mx/ready) · [MSA /ready](https://rma.orcalabs.mx/ready)

## Comprobación conjunta con Carlos

1. **MSA en shadow.** Tomar del Core el `NEW_DEVICE_REGISTERED` registrado por MDR. Abrir su pendiente por ID de instrumento. Revisar y guardar Gage R&R. Anotar ID de estudio, veredicto, `event_id`, correlación, causa y estado shadow de `MSA_VALIDATED`. Si el registro ya fue capturado, recuperar el estudio existente.
2. **CPK en shadow.** Tomar de Core el `MEASUREMENTS_CAPTURED` de César y su `PRODUCT_SPEC_UPDATED` asociado. Comparar pieza, característica, muestra, límites, versión, criterio y cuatro índices. Registrar el aviso en shadow cuando corresponda. Repetir con capacidad suficiente y verificar ausencia de alerta.
3. **Muestras a solicitar por canal autorizado.** Carlos facilita el sobre de ingreso y la fila de suscripción de MDR y CQM con `module.id`, `asset.asset_id`, `event.type` o `event_type`, `event_id`, `seq`, `correlation_id` y `causation_id`. Conservar forma y tipos al sanear el contenido. Para MDR incluir `operation` e identidad del instrumento. Para CQM incluir `partId`, `characteristicId`, forma de `measurements`, `defectsFound` y límites o versión asociada. Para las salidas, AJTool aporta su sobre shadow y CCC/MPS aportan su registro de consumo o una decisión reproducible en staging.
4. **Entrega real, con autorización explícita.** En la ventana conjunta, confirmar que CCC aplica el efecto sólo al veredicto aceptable aunque vea ambos veredictos en la suscripción. Verificar que MPS recibe un único aviso, identifica la especificación y que una revisión aislada no desencadena mediciones sin captura. Confirmar recepción por los IDs exactos, la cadena causal y el efecto en cada consumidor. La publicación shadow no crea eventos ni aristas de entrega en el dashboard central.

### Checklist de activación y reversión

- Carlos y el operador acreditan dominio, proyecto, entorno, servicio, revisión y alcance de las credenciales por metadatos. Mantienen las credenciales fuera de los recibos.
- El propietario de datos acredita preservación RAM, PostgreSQL durable, recuperación tras reinicio, y cursor/inbox/outbox reconciliados. El propietario de AJTool autoriza la ventana y el modo. Registrar fixtures, IDs nuevos, dueños CCC/MPS/CQM, alcance y límite de eventos.
- En live autorizado, verificar `/ready`, revisión, publicación confirmada por el Core, dedupe y efectos permitidos. Si aparece un evento fuera de alcance, un segundo efecto o una cadena crece sin captura, el operador detiene la prueba y ejecuta la reversión aprobada. Preservar cursores, registros y evidencia. Resolver entregas en vuelo con el responsable antes de restablecer el modo. Una salida guardada en shadow no debe reinyectarse como si fuera una entrega pendiente.
