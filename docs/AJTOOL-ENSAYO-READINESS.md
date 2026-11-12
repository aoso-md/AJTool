# AJTool en el ensayo integral IsoTools v1.1

## Resumen ejecutivo · 10 de noviembre de 2026

Referencia del ensayo: **PR-ORCA-ENS-001, v1.1, 21 de octubre de 2026**. AJTool cubre dos tramos de los siete escenarios. MSA recibe el registro de un instrumento y produce un veredicto tras la captura de Gage R&R. CPK recibe mediciones, aplica la especificación correspondiente y genera el aviso de capacidad baja. El ensayo conjunto requiere que el Core y las demás herramientas acrediten las cadenas completas.

| Nivel | Estado | Evidencia |
|---|---|---|
| A · Ensayo local con Core simulado | **LISTO PARA ENSAYO LOCAL** | 26 pruebas focalizadas aprobadas en Node.js 22. CI aprobó 5/5 trabajos en el commit de código `b5c4ca074035d408d06363f90065bfdf0ba95085`, incluidos PostgreSQL 16 y 17. Las pruebas reproducen captura, reconexión, replay, recuperación y cero envíos en shadow. [Ejecución CI](https://github.com/aoso-md/AJTool/actions/runs/42951512054). |
| B · Prueba con Core real | **BLOCKED** | Falta una ventana autorizada con Core, revisión desplegada identificada y PostgreSQL operativo. Los dos dominios oficiales responden en shadow y declaran persistencia en memoria. El pooler de AJTool devolvió `XX000` con ambas conexiones configuradas y la CA del proyecto. |
| C · Ensayo integral con las 16 herramientas en live | **BLOCKED** | Requiere aprobar B, verificar el filtro de MSA no aceptable y el corte del ciclo de CPK, proteger el histórico RAM y autorizar una ventana conjunta. |

**Hallazgos para la junta**

- MSA ahora exige `data.operation=register`. Antes admitía eventos sin esa propiedad. La captura manual persiste en PostgreSQL. Un replay desde un almacén vacío recrea el estudio pendiente y requiere restaurar la captura desde un respaldo o recuperarla de una fuente autorizada.
- MSA genera `MSA_VALIDATED` con ambos veredictos. `rule-pkg-005` sólo enruta `acceptable`. La suscripción del Core consultado filtra por tipo de evento, por lo que CCC puede leer un evento no aceptable aun sin una arista del Router. Carlos y el responsable de CCC deben comprobar que ese evento carece de efectos sobre el SPC y acordar cómo acreditar PV-1.4.
- CPK deduplica el mismo `event_id`. Un evento de medición nuevo con la misma correlación puede producir otro aviso. Carlos y los responsables de captura y especificaciones deben demostrar que una revisión de especificación no se convierte en una captura nueva por sí sola.
- Railway muestra los dos servicios de `railway init` pausados por créditos agotados. La identificación de los servicios que atienden los dominios oficiales y el alcance de los tokens siguen pendientes. Evitar reactivar ese proyecto hasta que el operador confirme el destino.

**Decisiones necesarias.** Carlos confirma el destino oficial, la revisión de Core y los responsables de CCC, especificaciones y captura. Infraestructura recupera SQL en el Supabase existente y acredita la asociación de los tokens mediante metadatos. El propietario de datos valida la conservación del histórico en RAM y el propietario de AJTool aprueba la ventana conjunta. El [PR 4](https://github.com/aoso-md/AJTool/pull/4) contiene la corrección y las pruebas. La preparación del ensayo se hizo en shadow.

## Evidencia técnica y reproducción

- Con Node.js 22, dependencias bloqueadas y Docker disponible, ejecutar desde la raíz `node db/test/run-postgres-tests.mjs --only=ensayo-v11`. Elegir `AJTOOL_TEST_POSTGRES_IMAGE=postgres:16` o `postgres:17`. El runner crea y elimina su propio contenedor local. En esta preparación, Docker local no estaba disponible y la suite se ejecutó en CI. [Código de la prueba](https://github.com/aoso-md/AJTool/blob/b5c4ca074035d408d06363f90065bfdf0ba95085/db/test/ensayo-v11.test.mjs) · [PG16](https://github.com/aoso-md/AJTool/actions/runs/42951512054/job/130296649755) · [PG17](https://github.com/aoso-md/AJTool/actions/runs/42951512054/job/130296649887).
- La prueba escribe recibos JSON identificados por `ensayoV11` en el log. Incluye estudio, evento de entrada y salida, correlación, causa, resultado matemático, inbox, outbox, cursor y número de POST al Core simulado. Los identificadores son sintéticos y se generan por ejecución.
- MSA (ISO 9001:2015, 7.1.5.2) usa `ENS-CAL-001` aceptable, `ENS-CAL-002` no aceptable y un tercer registro sin operación. Comprueba estudio pendiente, captura HTTP, veredicto, recuperación por ID, cursor tras duplicado y reconstrucción en otra base. La reconstrucción completa necesita observaciones, notas y la versión metodológica aplicable. Conservar un respaldo restaurable del estudio y su contexto antes del corte. La recuperación de la prueba reutiliza el mismo contexto de cálculo.
- CPK (ISO 9001:2015, 9.1.3) usa `ENS-PZA-001`, 24.95–25.05 mm, 25 lecturas iniciales, ocho adicionales y 25.09 mm como lectura 34. La referencia se calculó independientemente con desviación muestral y rango móvil dividido por 1.128. Cp **0.8499**, Cpk **0.6649**, Pp **0.6933**, Ppk **0.5424**. Verifica versiones 1 y 2, ausencia de especificación, reintento y duplicados. Confirmar umbral 1.33 con Carlos porque el backend permite configurarlo. Los límites incorporados en una medición tienen precedencia sobre caché. Para reconstrucciones, archivar la especificación, su versión y la secuencia de entrada aplicables.
- Código de referencia de Core leído en `feature/filter`, SHA `564d78f41389aedafb47695849ec12f5af2a8197`. Su identidad desplegada sigue pendiente. `rule-pkg-004` exige `register`, `rule-pkg-005` exige `acceptable`, `rule-pkg-006` comprueba `defectsFound >= 0`, `rule-pkg-007` reacciona a la revisión de especificación y `rule-qual-005` activa revisión con Cpk < 1.33 o clasificación `not_capable`. El Router deduplica aristas dentro de una ejecución, y la ingesta deduplica por `event_id`. Un evento nuevo abre otra cadena. Comprobar en shadow que una revisión sólo actualiza el plan de captura. La emisión debe depender de una captura real con identidad estable. El procedimiento usa alias `mdr` y `specs`, mientras que el registro de referencia usa `mdr` y `mps`. Confirmar alias y dominio efectivos en el entorno del ensayo.

## Matriz de verificación funcional

**PASS** acredita el tramo indicado. **FAIL** identifica una prueba ejecutada con resultado incorrecto. **BLOCKED** identifica una condición que impide ejecutar o aceptar el requisito. **NOT TESTED** indica ausencia de ejecución conjunta.

| PV | Requisito y eventos | Resultado AJTool y evidencia | Aceptación pendiente y responsable |
|---|---|---|---|
| 1.1 | MDR registra `ENS-CAL-001`. El log contiene `NEW_DEVICE_REGISTERED` con `operation=register`. | **PASS** simulado. MSA acepta registro válido y descarta operación ausente. Antes de la corrección, la prueba negativa falló. | **NOT TESTED** registro y log reales. MDR y Carlos. |
| 1.2 | MSA consume, completa Gage R&R y publica `MSA_VALIDATED` con la misma correlación. | **PASS** simulado. Captura por HTTP, veredicto, persistencia y outbox shadow. El recibo verifica causalidad. | **BLOCKED** publicación conjunta. Carlos y AJTool en B/C. |
| 1.3 | CCC acusa el aceptable y avanza cursor. | **NOT TESTED**. MSA construye el evento que satisface `rule-pkg-005`. | CCC comprueba cursor y efecto autorizado. |
| 1.4 | `ENS-CAL-002` no aceptable. El documento exige que a CCC «no llegue nada». | **PASS** simulado para veredicto y predicado del Router. **BLOCKED** criterio literal: el poll de referencia entrega por tipo. | Carlos y CCC definen si la evidencia exigida es ausencia de entrega o ausencia de actualización SPC, y prueban el comportamiento real. |
| 2.1 | `ERP_ITEM_CREATED` con `skuId=ENS-PZA-001` en un ciclo del conector, sin consulta de tools al gateway. | **NOT TESTED**. Las pruebas AJTool parten de eventos de especificación y mediciones. | ERP y conector acreditan tiempo, identidad y traza. |
| 2.2 | Las primeras 25 lecturas no provocan `OUT_OF_CONTROL_DETECTED`. | **NOT TESTED**. La referencia CPK incluye las 25 lecturas, sin certificar SPC. | CCC y detección de señales verifican falsos positivos. |
| 2.3 | Racha de ocho y 25.09 mm provocan `OUT_OF_CONTROL_DETECTED`, `violationsDetected=true`. | **NOT TESTED**. Fixture CPK incluye ambos estímulos. | CCC y detección prueban reglas SPC y el límite de control correspondiente. |
| 2.4 | Se crea exactamente una NC por la señal. | **NOT TESTED**. Dedupe CPK simulado sólo acredita su propio inbox. | NC verifica unicidad por señal con replay. |
| 2.5 | NC mayor/crítica produce `NC_REQUIRES_8D`, `8D_REPORT_ISSUED` y `FOLLOWUP_SCHEDULED`. | **NOT TESTED**. Fuera de los consumidores de AJTool. | NC, 8D y seguimientos prueban severidad y agenda. |
| 2.6 | CPK emite `CAPABILITY_BELOW_TARGET` y especificaciones lo recibe. | **PASS** tramo CPK simulado. Cpk 0.6649, outbox shadow, correlación y causa. Una revisión sola no produce estudio. | **BLOCKED** entrega y corte del ciclo en Core. Carlos, especificaciones y captura acreditan una sola ejecución por captura real. |
| 2.7 | La cadena desde ERP hasta seguimiento es completa. El 8D se delega por `rule-pkg-003`. | **NOT TESTED**. AJTool verifica el vínculo del aviso a su medición. | Carlos verifica `GET /events/chain/<correlation_id>`, la arista y `delegated_to`. |
| 3 · Devolución | `ERP_CUSTOMER_RETURN_REGISTERED` por partida, NC de cliente con folio y sin duplicar al repetir conector. | **NOT TESTED**. Dependencia indirecta. | ERP y NC verifican PV-3.1–3.3 y la cadena hacia 8D cuando aplique. |
| 4 · Defecto visual | `DEFECT_FOUND` con `defectFound=true` produce NC. Pieza buena sin NC y decisión sobre agrupación. | **NOT TESTED**. Dependencia indirecta. | Inspección y NC verifican PV-4.1–4.3. |
| 5 · AMEF | `FMEA_CRITICAL_FOUND` con casos críticos produce NC preventiva. Cero críticos sin efecto. | **NOT TESTED**. Dependencia indirecta. | AMEF y NC verifican PV-5.1–5.2. |
| 6 · Pedido | `ERP_SALES_ORDER_UNFULFILLABLE` genera seguimiento con folio. `ERP_STOCK_BELOW_MINIMUM` queda en log. | **NOT TESTED**. Dependencia indirecta. | ERP y seguimientos verifican PV-6.1–6.2. |
| 7 · Cierre | `ERP_SALES_PERIOD_CLOSED` → varianza/anomalía → KPI → riesgo → seguimiento. | **NOT TESTED**. Dependencia indirecta. | ERP, CPA, anomalías, KPI, proyectos y seguimientos verifican totales, meta, consolidación y `rule-pkg-012`, PV-7.1–7.5. |

## Resiliencia

| Prueba | Evidencia AJTool | Prueba conjunta pendiente |
|---|---|---|
| R1 · ERP cae | **PASS** análogo simulado para CPK: fallo temporal de Core conserva cursor y el reintento consume el lote. | **NOT TESTED**. ERP y gateway prueban desconexión, recuperación y devolución única. |
| R2 · Tool cae | **PASS** tramo AJTool en simulación: reconexión a la misma base, estudio, cursor y dedupe. La suite de checkpoint comprueba reinicio de proceso. | **NOT TESTED**. CPA verifica suscripción y cascada diferida. |
| R3 · Dashboard cae | **NOT TESTED**. Los dominios AJTool declaran `auth=open`. El contrato activa OIDC cuando hay un issuer configurado. | Carlos y responsables de herramientas acuerdan cómo verificar el requisito de SSO independiente del procedimiento. |
| R4 · Duplicados | **PASS** para reentrega del mismo evento en AJTool. Se demostró que un ID nuevo con igual correlación puede producir un aviso nuevo. | **NOT TESTED**. ERP verifica tres ciclos sin cambios y la excepción de `ERP_DATA_SYNCED`. |
| R5 · Evento inválido | **PASS** en validación de envelopes y negativos de AJTool con Core simulado. | **NOT TESTED** POST inválido al Core real, respuesta 400 y ausencia de ingreso. Carlos. |
| R6 · Seguridad | **PASS** para separación de credenciales de fixtures y cero POST en shadow. | **NOT TESTED**. Seguridad/Core verifica que ni la API key sirve en consola ni la cookie sirve en eventos. |

## Railway, almacenamiento y responsables

| Observación al 10/11 | Estado y acción |
|---|---|
| `railway init` · `production` | Panel accesible: 0/2 servicios, créditos agotados y ambos pausados. Se inspeccionó la configuración de CPK sin hallar fuente GitHub/Docker ni dominio público visible. Mantener pausado mientras se confirma el destino. |
| Dominios oficiales | [CPK /ready](https://ccp.orcalabs.mx/ready) y [MSA /ready](https://rma.orcalabs.mx/ready) respondieron con `memory`, `durable=false`, `shadow` y `open`. Cursores observados: 7677 y 0. La revisión y el proyecto efectivo no se acreditaron. `noble-surprise` es el antecedente de continuidad. Carlos debe contrastar en Railway los dominios con proyecto, entorno, servicio y despliegue. |
| GitHub | `RAILWAY_TOKEN_CCP` y `RAILWAY_TOKEN_RMA` existen por nombre. El workflow es manual y especifica los servicios. Su existencia no prueba alcance, proyecto ni permisos. El operador de Railway y el dueño del repo acreditan el alcance de ambos tokens con metadatos, y verifican fuentes y autodeploy en los servicios oficiales. |
| Supabase dedicado | Las dos conexiones al pooler devuelven `XX000` con la CA del proyecto. Infraestructura verifica estado, región, pooler y logs de conexión y repite el preflight SQL de sólo lectura con roles y TLS. El código de error por sí solo no acredita que el proyecto esté pausado. [Logs de Supavisor](https://supabase.com/docs/guides/database/supavisor). |
| Costo y riesgo | Recuperar primero el Supabase existente. Si el diagnóstico determina que no es viable, comparar con un PostgreSQL Railway ya autorizado, incluyendo costo de cómputo, volumen, respaldo y restauración, TLS, roles, migraciones y prueba tras reinicio. Medir CPU, RAM, red, consultas por minuto y retraso del poller en el destino correcto antes de ajustar recursos. Una réplica es el punto de partida si la capacidad medida lo permite. Mantener activas las instancias que aún guardan estudios sólo en RAM. [Medición de uso en Railway](https://docs.railway.com/projects/project-usage). |
| Histórico RAM | Propietario de datos y operador oficial verifican inventario, capturas manuales, criterios, especificaciones y publicaciones pendientes. Conservar y demostrar recuperación antes de reemplazar instancias. Un listado visible o un replay de eventos no certifican preservación íntegra. |

## Aceptación antes, durante y después

1. **Antes.** Carlos identifica el Core y los servicios por revisión. Infraestructura acredita PostgreSQL durable, permisos y TLS, y conserva evidencia de respaldo restaurable. AJTool y el propietario de datos certifican histórico RAM. Usar una ventana acordada y registrar desde Core el cursor `SEQ_INICIO` para observar el ensayo, separado de un replay aislado desde cero. Confirmar reglas 004/005/006/007/003/012 y el umbral de CPK.
2. **Durante B.** Mantener shadow. Capturar únicamente datos `ENS-`. Verificar suscripción, cursores, correlación, causa y estado del outbox. Carlos y los propietarios de CCC, especificaciones y captura verifican en un entorno autorizado el negativo MSA y el corte del ciclo CPK. Detener la prueba si aparecen nuevas mediciones sin captura o crece la cadena sin estímulo. Acreditar conservación con reapertura y reinicio autorizado del entorno de ensayo.
3. **Durante C.** Activar live únicamente tras aprobación explícita y ejecutar PV y R con cada propietario. Registrar hora, correlación y evidencia. No interrumpir ERP, dashboard ni servicios ajenos fuera de la ventana acordada.
4. **Después.** Auditoría exporta el reporte de la ventana con `coverage.toolsWithEvidence=16` y `coverage.findings` vacío, y verifica trazas con NC en 2, 3, 4 y 5. Archivar recibos y discrepancias. ERP decide el tratamiento de los registros sintéticos.
