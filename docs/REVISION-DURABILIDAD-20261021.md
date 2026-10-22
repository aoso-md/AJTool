# Revisión crítica de durabilidad PostgreSQL

Fecha: 2026-10-21. Rama: `dev/industrial-durability-20261021`.

**Dictamen: las suites pasan, pero la fase no está lista para darse por cerrada
ni para desplegarse.** Hay defectos reproducidos de validación de esquema,
recuperación y permisos, además de un defecto previo en la resolución PostgreSQL
de especificaciones CPK. Conviene corregirlos antes de implementar inbox/outbox.

Esta revisión no modifica los 20 archivos originales, su informe ni su patch.
Se añadieron este documento, el diseño siguiente y evidencias/sondas de auditoría.
No se implementó inbox/outbox. No hubo push, merge, deploy ni cambios remotos.

## Hallazgos, ordenados por impacto

### A01 — P1: migración/readiness aceptan un esquema que pierde idempotencia

En ambos `src/platform/store.js:98–126`, `CHECK_SCHEMA_SQL` solo selecciona
columnas con LIMIT 0. No valida tipos, NOT NULL, PK, índices, permisos de escritura,
secuencia ni versión de migración. `db/migrate.sql:5–13` registra 001 después de
CREATE IF NOT EXISTS, sin verificar equivalencia de objetos existentes.

**Reproducción en ambas tools:** sustituir `studies_tool_input_event_uidx` por un
índice no único del mismo nombre, vaciar el registro de versiones y ejecutar
migrate.sql. La migración termina correctamente y readiness da true. Dos estudios
con distintos id y el mismo `(tool,input_event_id)` se guardan: count = 2.
Vaciar después schema_migrations tampoco impide readiness. Además, revocar INSERT
en studies mantiene readiness true hasta intentar una escritura.

El problema de IF NOT EXISTS está documentado: no garantiza que el índice existente
tenga la definición solicitada. [PostgreSQL 16: CREATE INDEX](https://www.postgresql.org/docs/16/sql-createindex.html).

**Corrección propuesta:** preflight de adopción con comprobación del catálogo y
postcondiciones antes de registrar versión; versión/checksum de migraciones;
validación explícita del contrato de esquema y permisos efectivos. El runtime
necesita lectura de la versión de esquema, sin permiso para modificarla.
No reparar duplicados automáticamente ni cambiar una migración ya aplicada.

### A02 — P1: recuperación bloqueada hasta que alguien llame a /ready

Ambos `store.js:194–239`: tras un error SQL, `state.healthy=false`; las operaciones
posteriores lanzan antes de intentar PostgreSQL. Solo ping/recover vuelve a probar
la conexión. El servidor, el poller y los workers actuales no programan esa prueba;
Docker y railway.toml consultan `/health`, que no llama a ping.

**Reproducción:** revocar INSERT, provocar un fallo y restaurar INSERT. PostgreSQL
ya acepta consultas, pero ocho lecturas y cuatro escrituras del store siguen
rechazándose. Una llamada a ping las rehabilita. No hay fallback a RAM, lo cual es
correcto, pero tampoco recuperación autónoma de la carga de trabajo.

Además, el wrapper convierte un error lógico de SQL en indisponibilidad global.
No distingue un conflicto de unicidad, error de permisos, serialización o conexión.

**Corrección propuesta:** recuperación interna acotada y compartida, independiente
de probes HTTP, con backoff; errores tipados por SQLSTATE; tiempos máximos para
consultas/bloqueos; nunca aceptar una escritura durante la recuperación. Probar la
recuperación sin llamar a /ready/ping y sin reiniciar el proceso.

### A03 — P1 condicionado: permisos heredados y PUBLIC evaden las garantías anunciadas

`db/runtime-role.sql:7–19` revoca privilegios directos, pero no membresías ni
permisos de tablas concedidos a PUBLIC. `validateRuntime` busca atributos
administrativos y DDL, pero no todos los roles predefinidos con capacidades
privilegiadas ni privilegios excesivos de DML.

**Dos reproducciones en ambas tools, solo en roles/bases desechables:**

- Conceder `pg_execute_server_program` al runtime y volver a ejecutar
  runtime-role.sql: la membresía efectiva sigue presente y readiness da true.
  La sonda solo consulta el privilegio; no ejecuta programas del servidor.
- Conceder DELETE sobre settings_history a PUBLIC y ejecutar runtime-role.sql:
  readiness da true y el runtime puede borrar una fila de historial. El script no
  asegura historial append-only si la base adoptada tenía ese permiso.

La capacidad del primer rol está descrita en
[PostgreSQL 16: roles predefinidos](https://www.postgresql.org/docs/16/predefined-roles.html).

**Alcance:** requiere una configuración previa insegura. No demuestra que producción
tenga esas membresías o grants; no se inspeccionó producción. El README ya exige un
rol dedicado sin membresías administrativas, pero la comprobación automática no
garantiza toda esa condición. Con el rol nuevo limpio de la suite, DDL sí se deniega.

**Corrección propuesta:** rol dedicado sin membresías no aprobadas, incluida
capacidad de SET ROLE; preflight de privilegios efectivos por tabla/secuencia y
operación; revisar/revocar PUBLIC en objetos de la base dedicada y grants heredados.
No revocar membresías de un rol compartido a ciegas: detener la preparación y
reportar la causa. No introducir funciones SECURITY DEFINER como atajo.

### A04 — P1 heredado: CPK tiene distinto contrato de especificaciones en RAM y PostgreSQL

`tools/calculate-cpk-ppk/src/platform/store.js:84–92,312–329`.
La condición PostgreSQL `(part_id = $1 OR $1 = '')` no reproduce el fallback
global seguro del store de memoria.

**Reproducción:** con una especificación P2/C, consultar C sin partId devuelve
P2 en PostgreSQL y null en memoria. Añadir una especificación global C y consultar
P1/C devuelve null en PostgreSQL y los límites globales en memoria. Esto permite
seleccionar límites de otra pieza cuando no se proporciona pieza o saltar un
estudio que debería usar la especificación global.

La misma condición ya existe en HEAD: no la introdujo esta fase. La prueba
`spec-isolation.test.js` solo usa RAM. La suite PostgreSQL solo comprueba una
búsqueda exacta part/diameter y no descubre el defecto.

MSA tiene un fallback histórico distinto, a cualquier pieza, tanto en RAM como en
PostgreSQL. Las sondas confirman esa diferencia de contrato entre tools; no es una
regresión nueva de MSA y el dominio MSA actual no utiliza ese cache para su cálculo.

**Corrección propuesta:** ejecutar el mismo contrato de aislamiento CPK sobre RAM
y PostgreSQL; buscar la pieza exacta y después solo el registro global, nunca otra
pieza. No copiar sin criterio el comportamiento de MSA a CPK.

### A05 — P2: arranque seguro para los datos, pero no fail-fast ni gate productivo

Ambos `src/server.js:20–46` continúan después de createStore aunque la validación
falle. El proceso escucha y `/health` devuelve 200. El runtime no crea tablas.

**Prueba adicional con procesos reales**, eliminando primero CREATE/TEMP de PUBLIC
para no enmascarar la ausencia de tablas con un error de privilegios:

| Situación: cero tablas | CPK | MSA |
| --- | --- | --- |
| Proceso permanece escuchando | sí | sí |
| GET /health | 200 | 200 |
| GET /ready | 503 | 503 |
| GET /api/studies | 503 | 503 |
| GET /api/settings | 503 | 503 |
| POST /api/studies con entrada válida | 503 | 503 |
| Tablas creadas por runtime | 0 | 0 |

El fallo es seguro respecto de persistencia: no se acepta el estudio ni se pasa
a RAM. No equivale a un arranque que sale con código no cero. Una base parcialmente
compatible puede superar la comprobación de columnas, como demuestra A01.

railway.toml y las imágenes usan /health; no /ready. Se conservaron sin cambios,
pero desplegar el nuevo runtime con las credenciales propietarias antiguas o sin
preparar las migraciones podría aparentar salud y devolver 503 en las APIs.
Las imágenes runtime excluyen db, de modo que la migración necesita un ejecutor
separado; el job añadido solo resuelve el compose local.

**Corrección propuesta:** distinguir error permanente de esquema/configuración
de caída temporal. Definir y probar fail-fast para esquema/rol incompatibles.
Preparar un gate local de preflight antes de cualquier futura solicitud de deploy.
No se cambió la configuración productiva para resolverlo durante esta auditoría.

### A06 — P2: cobertura menor que la lectura amplia de «138 pruebas»

Los contadores se reprodujeron sin fallos ni omitidas: 62 + 55 + 21 = 138.
El contador 21 de Node incluye un test raíz y dos grupos: son 18 casos funcionales
PostgreSQL. Esto ya estaba aclarado en el informe original. No son 138 escenarios
independientes de recuperación o concurrencia.

La suite original de PostgreSQL tiene límites concretos:

- El test sin migrar usa un rol nuevo que conserva TEMP de PUBLIC y también falla
  la comprobación de privilegios. No aísla la causa «tabla ausente». La sonda nueva
  sí quita TEMP y verifica el error de relación ausente y las rutas reales.
- La prueba HTTP registra `/api/durability-test`; no el dominio CPK/MSA.
  Las sondas nuevas comprueban rutas reales mediante `src/server.js` en procesos hijos.
- «Reinicio» en esa suite es cerrar/recrear el store en el mismo proceso Node;
  sí reinicia PostgreSQL real, pero no mata/reinicia el proceso de la herramienta
  después de confirmar una escritura. Tampoco simula pérdida del ACK de COMMIT.
- No prueba migradores simultáneos, despliegue sobre volumen real de compose,
  usuario propietario no superusuario, worker/poller concurrentes ni versiones
  incompatibles de esquema. El nuevo bloqueo advisory es razonable por inspección,
  pero no se había ejercitado con dos migradores.
- No hay dos escritores concurrentes de criterios en los tests originales.
  La sonda nueva usa dos stores y confirma 1 commit, 1 conflicto y 1 fila de historial.
- La recuperación original siempre llama a ping, por lo que no descubre A02.
- No prueba todas las lecturas durante indisponibilidad. Las sondas nuevas bloquean
  las ocho lecturas y cuatro escrituras después de un fallo SQL con estado unhealthy.
- CI solo ejecuta las suites dentro de tools y sus builds web. No ejecuta
  db/test/durability.test.mjs, situada fuera de esos paquetes.

La suite original usa `ajtool_migrator`, el administrador del contenedor, no demuestra
que el flujo de permisos completo funcione con un propietario de migraciones sin
atributos de superusuario. No se instalaron dependencias web, no disponibles en
este workspace; no se construyeron imágenes ni se ejecutó compose up. Estas
limitaciones no se presentan como verificaciones aprobadas.

### A07 — P3: texto dañado en la documentación de despliegue

El diff de `docs/DESPLIEGUE.md:87–90` contiene signos `?` literales en palabras como
`conexi?n`, `ca?da` y `vol?til`. No es solo la visualización de PowerShell: figura en
el patch. Conviene corregir UTF-8 en un cambio documental separado. El informe
original y el patch son consistentes entre sí; no se regeneraron durante la revisión.

## Comprobaciones positivas y transacciones

La separación del DDL es real: ninguno de los runtimes ejecuta CREATE/ALTER/DROP.
Todas las lecturas persistentes pasan por el mismo wrapper que lanza cuando
PostgreSQL es obligatorio. No hay ruta de retorno silencioso a RAM en ese modo.
Las cuatro escrituras actualizan memoria después del éxito SQL; saveSettings
actualiza settings e historial dentro de BEGIN/COMMIT y revierte ambos si falla
el INSERT de historial. Esto sí está cubierto y pasó nuevamente.

Las sondas nuevas también provocan un fallo de migración al crear el índice único
sobre duplicados existentes: no queda schema_migrations creado, no aparecen tablas
posteriores y las dos filas originales sobreviven. Al corregir el duplicado de la
base de prueba, la migración adopta y conserva la fila restante. La transacción del
migrador funciona en ese caso; no implica que valide la equivalencia de índices.

No existe todavía una transacción conjunta de estudio, cursor y publicación.
El dominio publica por HTTP antes de guardar el estudio; el poller guarda el cursor
aparte. Son límites previos reconocidos en el informe y objeto del diseño siguiente,
no funcionalidades implementadas por esta fase. `PersistenceUnavailableError`
tampoco tiene kind retryable; el catch por evento del poller solo reconoce kind
auth/retryable. No se debe basar la corrección futura en que un setCursor posterior
falle por casualidad: un fallo de infraestructura debe abortar el consumo explícitamente.

Otros riesgos heredados, fuera del diff: TLS remoto usa rejectUnauthorized=false;
no se fijan query/statement/lock timeouts; seq se convierte a Number aunque la DB usa
BIGINT; los envelopes se pueden reconstruir con nuevos timestamps y studyId;
retryPublishes de MSA inspecciona solo los últimos 200 estudios. No se probó aquí una
pérdida de eventos causada por esas condiciones. El plan los trata como requisitos
de diseño y pruebas, sin afirmar que ya estén resueltos.

## Justificación de los 20 archivos del patch original

| # | Archivo | Motivo y evaluación |
| --- | --- | --- |
| 1 | `db/schema.sql` | Alias psql del migrador; elimina la doble fuente de DDL. Cambia compatibilidad: ya no es SQL puro para clientes que no entienden metacomandos psql. |
| 2 | `docker-compose.yml` | Job migrador independiente, dependencia de finalización y conexión runtime distinta. Solo local; conserva parámetros de red/core anteriores. No se ejecutó up. |
| 3 | `docs/DESPLIEGUE.md` | Actualiza instrucciones que antes prometían crear tablas al arrancar. Cambio justificado, con A05 y error de texto A07. |
| 4 | `tools/calculate-cpk-ppk/.env.example` | Documenta DATABASE_REQUIRED y rol runtime. Sin credenciales reales nuevas. `false` permite RAM si se omite la URL: producción futura debe exigir política explícita. |
| 5 | `tools/calculate-cpk-ppk/src/platform/app.js` | Traduce el error tipado de persistencia a 503 sin revelar causa SQL. Correcto. |
| 6 | `tools/calculate-cpk-ppk/src/platform/config.js` | URL implica obligatoriedad y true cubre URL ausente. Correcto para flags documentados; no impone por sí solo PostgreSQL a NODE_ENV=production. |
| 7 | `tools/calculate-cpk-ppk/src/platform/store.js` | Retira DDL y fallback obligatorio; orden DB→RAM y validación de arranque/readiness. Necesita A01–A04. |
| 8 | `tools/calculate-cpk-ppk/src/server.js` | Propaga databaseRequired a createStore. Correcto; no añade fail-fast ni recuperación interna. |
| 9 | `tools/run-msa-analysis/.env.example` | Mismo contrato de configuración, sin secretos reales. |
| 10 | `tools/run-msa-analysis/src/platform/app.js` | Mismo mapeo 503, correcto. |
| 11 | `tools/run-msa-analysis/src/platform/config.js` | Misma obligatoriedad, con el mismo límite de política productiva. |
| 12 | `tools/run-msa-analysis/src/platform/store.js` | Misma separación y rechazo; afectado por A01–A03. Conserva su fallback histórico de specs, distinto de CPK. |
| 13 | `tools/run-msa-analysis/src/server.js` | Propaga databaseRequired. Mismo límite operativo de A05. |
| 14 | `db/README.md` | Documenta roles, migración, obligatoriedad y entorno de prueba. Acertado sobre dependencia de /ready, demasiado amplio sobre privilegios garantizados si se ignoran A03/precondiciones. |
| 15 | `db/local-bootstrap.sql` | Credencial pública exclusiva de desarrollo y preparación local del rol. IF NOT EXISTS no rota contraseña si ese rol ya existía: volumen previo con otra clave no está cubierto. |
| 16 | `db/migrate.sql` | Transacción, lock advisory y versión; necesita namespace determinista, validación de adopción y checksum. |
| 17 | `db/migrations/001-initial.sql` | Extrae el DDL de los stores conservando tablas/índices y datos compatibles. IF NOT EXISTS no valida el esquema encontrado; A01. |
| 18 | `db/runtime-role.sql` | Grants mínimos para rol limpio y tablas dedicadas; no asegura por sí solo permisos efectivos mínimos de un rol/base adoptados; A03. ALTER ROLE afecta al rol del cluster: debe ser exclusivo. |
| 19 | `db/test/durability.test.mjs` | Añade PostgreSQL real, DDL denegado, caída y persistencia. Válido con límites A06; sus assertions pasan. |
| 20 | `docs/INDUSTRIAL-DURABILITY-20261021.md` | Registro de resultados y límites. Contadores y patch correctos; no implica cierre de los defectos ahora reproducidos. |

## Credenciales y configuración productiva

No hay nuevas credenciales sintéticas en `src` ni `web` de las tools, Dockerfiles,
railway.toml o workflows. `local-only-runtime` está en compose/bootstrap y el patch
que los documenta. Las claves de pruebas solo aparecen en tests/sondas. Las
contraseñas de roles desechables se generan al ejecutar las pruebas y no se guardan
en los artefactos de evidencia.

Por inspección del build: .dockerignore excluye db/docs/compose; los Dockerfiles
runtime copian src y el frontend compilado, no tests ni sondas. No hay un camino
nuevo que introduzca esas credenciales en la imagen runtime. No se construyeron ni
inspeccionaron imágenes desplegadas; no se puede certificar desde el repositorio
el estado de secretos o accesos de producción.

Se compararon contra HEAD y permanecen sin cambios railway.toml, ambos Dockerfiles,
.dockerignore y ambos workflows. No se editaron .env privados ni dominios.
El compose sigue teniendo el endpoint core de producción como valor por defecto y
`5433:5432` expuesto sin restricción de interfaz: son configuraciones locales
preexistentes. No se ejecutó compose up ni se proporcionaron llaves del core.
Sería conveniente aislar también esos defaults en una corrección local separada.

## Resultados y contraste con el informe anterior

| Ejecución | Resultado actual | Evidencia |
| --- | --- | --- |
| Backend CPK completo | 62/62, 0 fallos/omitidas | `durability-review-evidence/cpk.txt` |
| Backend MSA completo | 55/55, 0 fallos/omitidas | `durability-review-evidence/msa.txt` |
| Suite PostgreSQL original completa | 21/21, 0 fallos/omitidas | `durability-review-evidence/postgres.txt` |
| Sondas adicionales de auditoría | 18 grupos de comprobaciones completados, 9/tool | `durability-review-evidence/probes.json` |

Las sondas son diagnósticos del comportamiento actual, no 18 nuevos tests de
aceptación de un sistema corregido: varias assertions describen fallos encontrados.
Primero se corrigió una suposición de la sonda sobre el fallback de MSA; la
ejecución final terminó con código 0. No fue una regresión de las suites originales.
Node local: v24.22.0; CI e imágenes usan Node 22. No se ejecutó aquí una matriz Node 22.

El patch tiene exactamente 20 entradas y `git apply --reverse --check` pasa.
SHA-256: `1fa179c75f4446dd06e841df2a6ea2e8919b4e979885294a29887189658158ca`.
Un manifest registra el hash de cada archivo original: ninguno cambió durante esta
revisión. El informe original sigue siendo una fotografía fiel de las pruebas que
se ejecutaron, con las salvedades de cobertura de A06; las garantías amplias de
esquema/privilegios requieren la corrección de A01/A03.

Todos los experimentos de DB usaron exclusivamente el contenedor aislado y bases
con sufijo aleatorio. Las bases/roles desechables se eliminan en finally. Se
conservó ajtool_test. No se inspeccionaron ni modificaron Railway o Supabase.

## Orden propuesto antes de inbox/outbox

1. Añadir tests normativos que fallen por A01/A03; endurecer adopción de esquema,
   versión y privilegios efectivos. Probar propietario sin superusuario.
2. Corregir A02 y la clasificación de errores; probar recuperación sin probes y
   fail-fast de esquema/configuración; mantener rechazo completo durante caída.
3. Corregir el contrato CPK de A04 con la misma suite RAM/PostgreSQL. Mantener MSA
   independiente. Ajustar documentación UTF-8 y defaults locales en otro cambio.
4. Completar pruebas de proceso reiniciado, migradores concurrentes, volumen previo
   de compose y Node 22; volver a ejecutar las tres suites y revisar sus diffs.
5. Solo después, ejecutar los cambios pequeños del
   [diseño de inbox/outbox](DISENO-INBOX-OUTBOX-20261021.md).

Esta entrega es auditoría y diseño. Las correcciones y la implementación quedan
pendientes de la revisión del usuario; no se solicita autorización para despliegue.
