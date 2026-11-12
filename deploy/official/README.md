# Procedimiento vigente para Carlos

Usar [RELEASE-20261103](../../docs/RELEASE-20261103.md) para el release actual y el relevo en los dos servicios Railway existentes. Conservar SSO/configuración Core actuales y mantener shadow.

**Supabase AJTool ya fue migrado y certificado con RLS forzada y rol runtime independiente.** No ejecutar de nuevo la adopción histórica descrita abajo ni desactivar RLS para este despliegue. El complemento vigente es db/rls-private-contract.sql; las migraciones001–003 permanecen inmutables. La documentación inferior y package-release.py corresponden al candidato histórico de octubre, no al empaquetado del release público actual. Para transportar el release actual usar un archive del commit aceptado, excluyendo archivos locales; Git no incluye secretos ni dist generados.

La prueba privada ORCA se conserva fuera del release público. Las pruebas públicas/CI son autónomas. No sustituir evidencia privada o local por aceptación de los dominios oficiales.

---

## Antecedentes históricos (no ejecutar como relevo vigente)

# Transición oficial preparada — ejecución pendiente del operador

No autoriza cambios productivos. A conserva la RAM; B prepara PostgreSQL sin esperar a A. No pedir cuenta ni tokens a Carlos. Usar su proyecto noble-surprise y servicios calculate-cpk-ppk / run-msa-analysis, nunca railway init personal.

## 1. Comprobación PostgreSQL sin cambios

Desde el checkout del SHA aprobado, Node22 y dependencias bloqueadas instaladas. El operador carga AJTOOL_TARGET_DATABASE_URL desde su gestor privado; **no imprimirla, guardarla en Git ni pegarla en chat**.

```powershell

node db/review/check-supabase-target.mjs

```

Salida cero sólo si conexión TLS/catálogo/migraciones/rol pasan y no hay revisión pendiente de objetos ajenos/grants Data API. Salida2 indica NOT_TESTED/REVIEW_REQUIRED/NOT_CERTIFIED, nunca autorización de migrar. No crea objetos, no copia estudios, no ejecuta DDL.

Migrador y runtime son identidades distintas. Usar las migraciones001–003 existentes y runtime-role.sql sólo tras comprobar su alcance: el script de grants revoca PUBLIC globalmente y no debe aplicarse sin revisión a una base compartida. Guardar backup previo con el mecanismo del proveedor/operador y ensayar restauración en destino aislado. No recrear proyectos ni tocar tablas ajenas para conseguir un PASS.

Plantillas cpk.env.example / msa.env.example contienen nombres, no claves. DATABASE_URL va al gestor Railway; DATABASE_REQUIRED=true; NODE_ENV/AJTOOL_ENVIRONMENT=production; CORE_PUBLISH=shadow; OIDC_ISSUER ausente. POLL_ENABLED=false para el corte. No borrar claves Core existentes ni activar live. No copiar runtime_identity de staging sobre producción: entorno/modo deben coincidir y la aplicación falla si no coinciden.

### Catálogo real29/10 y adaptación explícita

El acceso autorizado al SQL Editor ya funciona. Sólo se leyó metadata: PostgreSQL17.6, cinco tablas legado RLS y sin ledger;32 columnas compatibles con001,5 políticas de ajtool_service, ninguna función pública y sin membresías del runtime. Su TEMP todavía está permitido. Data API tiene grants de tabla bajo RLS: no desactivar RLS sin retirar esos grants atómicamente. Esta lectura no acredita login/TLS del runtime ni aprobación de migrar.

`db/supabase-private-adoption.sql` es una opción preparada para este proyecto dedicado. Cambia RLS por ACL SQL privado, conserva los documentos/políticas, migra001–003 y revoca a anon/authenticated/service_role acceso a tablas, columnas, secuencias y funciones. Rechaza objetos públicos ajenos, preserva capacidades previas de otros roles y revierte toda la transacción ante error. No cambia auth/storage ni otro proyecto. El hash suministrado es referencia de evidencia; el script no demuestra que el backup exista o pueda restaurarse.

**No ejecutar en el proyecto real hasta aprobación expresa de este modelo y respaldo/restauración verificados.** Ensayar primero en copia aislada aprobada con permisos equivalentes. Con conexión de migrador ya cargada privadamente y runtime_role revisado:

```powershell

psql -X -v ON_ERROR_STOP=1 -v runtime_role=ajtool_service -v ajtool_private_sql_approved=I_APPROVE_PRIVATE_AJTOOL_SQL -v backup_manifest_sha256=HASH_REAL_DEL_MANIFIESTO -f db/supabase-private-adoption.sql

```

El marcador no es un hash válido y falla deliberadamente. No reemplazarlo por un valor ficticio para superar el control. No ejecutar migración/DDL desde el login runtime. Tras migrar, volver a ejecutar preflight con ese rol y comprobar Data API sin grants; hacer estudio sintético autorizado/GET/reapertura/reinicio de staging y backup/restore real del destino. Nada de esto reemplaza ni reinicia los procesos oficiales RAM; B puede avanzar mientras A se conserva.

AJTool y MARLI se mantienen separados. No aplicar este adaptador a una base compartida con objetos de MARLI; no se inspeccionó MARLI. Cualquier intercambio futuro de mediciones se limita a lectura explícitamente autorizada con procedencia/unidades/método/alcance, sin compartir credenciales ni unir tablas de negocio.

## 2. Protección histórica y autorización

Decisión recibida: preserve_current_ram. Los endpoints públicos no proporcionan un snapshot completo demostrado. El operador necesita identificar todas las instancias y un mecanismo autorizado de extracción consistente sin sustituirlas; comprobar manifiesto/restauración. No enviar datos industriales o heap dumps a chats.

El recibo por tool debe corresponder al SHA exacto, responsable/fecha/referencia y productionChangeApproved. Ejemplo **denegado por defecto**: transition-decision.example.json. Para preserve se exige protección íntegra/restauración y hash del manifiesto. Para discard_current_ram, sólo si el dueño cambia explícitamente la decisión, exige aceptación expresa de pérdida; **no exige exportador**. La plantilla no es prueba ni autorización firmada.

Antes de `railway up`, el workflow local verifica AJTOOL_DATA_DECISION_CCP/RMA (variables de recibo, sin secretos). No configuradas ni publicadas aquí. CI y staging de B funcionan independientemente; la puerta sólo bloquea reemplazar instancias. Mantener revisión/aprobación humana real: JSON no autentica por sí mismo al responsable.

## 3. Revisión y dominio exactos

Comandos de metadatos (ayuda CLI verificada), ejecutados por Carlos en su cuenta:

```powershell

railway deployment list -p noble-surprise -s calculate-cpk-ppk --json

railway deployment list -p noble-surprise -s run-msa-analysis --json

```

Seleccionar despliegue/entorno e IDs de cada instancia activa en Railway; guardar SHA, imagen y vínculo al dominio. No deducir todas las réplicas de una lista de despliegues. Nunca usar el primer servicio o la cuenta personal como sustituto.

`runtime-fingerprint.mjs` sólo lee fuentes, assets, lockfile y versiones de dependencias; no env, RAM, estudios ni DB. Validado dentro de las dos imágenes locales. El operador puede ejecutar el mismo programa en cada instancia autorizada vía SSH/console, por ejemplo pasando su contenido como programa a `node --input-type=module -e` con `railway ssh -p noble-surprise -s SERVICIO -d ID_INSTANCIA`. La disponibilidad y transporte de ese SSH oficial no se probaron aquí. No instalar un exportador ni modificar el contenedor para esta lectura.

Guardar el JSON técnico recibido y comparar con los *-expected.json del artefacto:

```powershell

node deploy/official/compare-fingerprint.mjs cpk-expected.json cpk-official.json

node deploy/official/compare-fingerprint.mjs msa-expected.json msa-official.json

```

La huella exige commit esperado, tool, versión, Node, dependencias y todos los archivos; metadatos vacíos fallan. Completar la cadena con metadatos de Railway/CI del mismo SHA: una huella idéntica no prueba por sí sola qué commit documental fue desplegado. `/version` actualmente devuelve HTML del SPA con200, no atestigua versión; no aceptarlo como endpoint JSON.

## 4. Cambio y aceptación, sólo tras aprobación

Aplicar conexión aprobada y desplegar el SHA de RELEASE-METADATA.json mediante el flujo acordado; no editar manualmente archivos dentro de contenedores. No ejecutar main/workflow hasta aprobación, protección A y validación B remota. Después:

```powershell

node db/review/check-deployment-ready.mjs --url https://ccp.orcalabs.mx/ready --tool calculate_cpk_ppk

node db/review/check-deployment-ready.mjs --url https://rma.orcalabs.mx/ready --tool run_msa_analysis

```

Exigir postgres/durable, authopen y shadow. Además POST sintético autorizado→ID→GET exacto→reabrir→reinicio sólo staging autorizado→GET exacto; comprobar backup/restore del destino, no sólo readiness. Nunca live para esta aceptación. Reanudar polling con cursores conservados y configuración Core existente sólo bajo autorización del operador.

Rollback: ante fallo, detener aceptación. Conservar backup, estado previo y evidencia; no borrar tablas, degradar migraciones ni volver a un runtime incompatible con001–003. Restaurar únicamente a revisión/esquema compatibles mediante procedimiento ensayado. Si A no está protegido, no iniciar sustitución para intentar rollback después. Tras activar PG, mantenerlo durable: no volver a RAM como solución.

## Candidato de cierre30/10 — aprobación concreta

RutaA sobre el existente, sin otro esquema/proyecto. No se autoriza ejecución por este documento. Revisar AJTOOL-FINAL-PRODUCTION-CLOSURE.md: public/graphql_public y5 tablas expuestas en Data API, exposición automática nueva activada. Aprobar el modelo SQL privado, impedir que se reotorguen grants a tablas nuevas y resolver defaults de otros creadores sin modificar objetos del proveedor a ciegas. El adaptador sólo retira defaults en public del migrador ejecutor y rechaza grants globales de tablas/secuencias a Data API/PUBLIC; no cambia defaults supabase_admin. Funciones nuevas: REVOKE PUBLIC/Data API y grants explícitos en la misma transacción.

La URL privada puede pedir sslmode=verify-full y la cadena se valida; los destinos públicos siempre verifican TLS. No usar sslmode=no-verify ni NODE_TLS_REJECT_UNAUTHORIZED=0. La prueba db/test/postgres-tls.test.mjs usa CA efímera sólo local; nunca instalarla en producción. El futuro despliegue debe usar las CA oficiales del destino.

Construcción reproducible de las imágenes candidatas con el digest base observado:

```powershell

docker build --build-arg NODE_IMAGE=node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da -f docker/calculate_cpk_ppk.Dockerfile -t ajtool-cpk-rc:20261030-final-db .

docker build --build-arg NODE_IMAGE=node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da -f docker/run_msa_analysis.Dockerfile -t ajtool-msa-rc:20261030-final-db .

```

Esto prepara imágenes locales; no hace push ni inicia servicios. IDs y huellas en candidate-images.json, asociadas al sourceCommit de RELEASE-METADATA.json; etiquetas locales no prueban revisión desplegada en Railway. Antes del cambio oficial comprobar conservación A, B remoto certificado, recibo por tool/SHA y aprobación.
