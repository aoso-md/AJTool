# Corrección de los cuatro bloqueos previos a inbox/outbox

Rama: `dev/industrial-durability-20261021`. Solo cambios locales.

**Resultado: los cuatro defectos reproducidos están corregidos y las 138 pruebas
anteriores siguen pasando.** CPK agrega un caso y la integración ampliada agrega
65 entradas al contador de Node: total **204/204**, sin fallos, canceladas ni omitidas.
Las 18 sondas de auditoría también terminan correctamente con expectativas de
sistema corregido; no se suman como otros 18 tests al total anterior.

No se implementó inbox/outbox. No hubo push, merge, deploy, cambios de servicios,
DNS, OIDC productivo, Railway o Supabase. No se activó CORE_PUBLISH=live. Las
pruebas de aplicación usan fake core local o procesos con publicación shadow.

## Comparación antes/después

Las sondas existentes se ejecutaron antes de modificar la implementación. Su
reproducción queda en `durability-fix-evidence/probes-before.json`. La evidencia
histórica de la auditoría se conserva; las sondas corregidas escriben un archivo
nuevo: `durability-fix-evidence/probes-after.json`.

| Defecto reproducido | Antes | Después |
| --- | --- | --- |
| Índice con nombre correcto pero definición no única | Migración y readiness aceptaban; dos estudios para el mismo tool/evento | Migración aborta y runtime devuelve indisponibilidad antes de escribir; permanece una fila. Con el índice válido, PostgreSQL rechaza duplicado con 23505. |
| Esquema/versiones solo comprobados por columnas | Se aceptaban ledger vacío, constraints o índices incorrectos | Comprobación real de catálogo, PK, tipos, nulabilidad, índices/predicados, secuencia/defaults y versiones/checksums exactos. |
| Recuperación tras fallo SQL | Ocho lecturas y cuatro escrituras seguían bloqueadas hasta ping/ready | Las operaciones recuperan automáticamente tras revalidación y backoff; nunca se confirma una escritura únicamente en RAM. |
| Falta de INSERT | Readiness true hasta intentar escribir | Readiness false por privilegios efectivos incompletos; al restaurar el grant, una operación normal recupera sin ping. |
| Membresía pg_execute_server_program | Provisioning aceptaba y runtime ready | Provisioning aborta y runtime rechaza; no se ejecutan programas de servidor en las pruebas. Se prueban además pg_read_server_files, pg_write_all_data y membresía NOINHERIT/SET ROLE. |
| DELETE concedido a PUBLIC sobre historial | Sobrevivía al script; podía borrar una fila | El script revoca el grant; DELETE/UPDATE/TRUNCATE del historial se deniegan. También se comprueban grants por columna, secuencias y objetos ajenos. |
| CPK sin pieza, solo existe P2/C | PostgreSQL devolvía P2; RAM null | Ambos devuelven null. Nunca se usan límites de otra pieza. |
| CPK P1/C sin exacta pero con global | PostgreSQL null; RAM global | Ambos usan global si está permitida. Exacta siempre tiene precedencia, incluso si el global tiene un sourceSeq más nuevo. |

## Qué cambió y por qué

| Archivo(s) | Cambio y motivo |
| --- | --- |
| `db/migrations/002-schema-contract.sql` | Migración aditiva que incorpora checksum al ledger y un validador SECURITY INVOKER, sin elevación. Contrasta el catálogo real, no la mera existencia de nombres. No modifica, deduplica ni repara datos incompatibles. |
| `db/migrate.sql` | Conserva el lock/transacción y la 001; aplica la 002 solo si falta. Valida postcondiciones antes de registrar versiones; exige orden/versiones/checksums compatibles. Un fallo revierte DDL y ledger nuevos. |
| Ambos `src/platform/postgres-contract.js` | Mismo contrato de validación y permisos en las dos imágenes. Rechaza ownership, membresías, administración/DDL y grants excesivos o insuficientes efectivos, incluidos PUBLIC y columnas. Consulta el catálogo en transacción readonly. Las copias son idénticas y hay test que impide divergencia. |
| Ambos `src/platform/store.js` | Validación automática antes de operaciones, una sola comprobación concurrente, backoff de 250 ms y pool máximo 5. Timeouts de conexión 2 s, statement 5 s, query 6 s y lock 2 s. Consultas calificadas con public. Manejo de error de clientes adquiridos y descarte de conexiones fallidas. Errores de persistencia tienen kind retryable para que el poller no los salte. |
| `db/runtime-role.sql` | Preflight rechaza un rol propietario/administrador/con membresías, sin intentar degradarlo. Revoca grants directos y PUBLIC de tablas/columnas/secuencias/funciones. Concede exclusivamente las operaciones requeridas, SELECT de versiones y EXECUTE del validador invoker. No da DDL ni permisos amplios para pasar tests. |
| `tools/calculate-cpk-ppk/src/platform/store.js` | Además corrige el predicado SQL de specs e introduce allowGlobal en ambos stores RAM/PG de CPK. Exacta → global permitida → null; nunca otra pieza. |
| `tools/calculate-cpk-ppk/test/spec-isolation.test.js` y `test/helpers/spec-contract.js` | Conservan el test previo y agregan una matriz compartida RAM/PG con dos piezas, global, pieza ausente, precedencia y global desactivada. |
| `db/test/durability.test.mjs` | Mantiene los 21 tests originales. Solo actualiza el conteo esperado de versiones de 1 a 2 por la migración aditiva. No elimina pruebas ni debilita assertions de durabilidad. |
| `db/test/durability-hardening.test.mjs` | Casos normativos contra los defectos: metadata corrupta, índice no único/predicado incorrecto, privilegios, propiedad de tipos, recuperación real, coalescencia de 20 operaciones y transacción de criterios/historial que realmente falla después del upsert. |
| `db/test/helpers/isolated-postgres.mjs` | Fixture que exige el contenedor local y crea bases/roles desechables. El migrador probado es propietario de base sin SUPERUSER/CREATEDB/CREATEROLE; runtime tampoco los tiene. Limpieza en finally. |
| `db/review/durability-probes.mjs` | Mismos nueve grupos diagnósticos por tool, con expectativas corregidas y salida nueva. La membresía insegura se rechaza; no se elimina automáticamente de un rol ajeno. |
| `db/README.md` | Documenta migración 002, contrato estricto, permisos, recuperación autónoma, timeouts, especificaciones y comandos de validación. |
| Este informe y `durability-fix-evidence/` | Resultados, baseline de comparación, logs, síntesis de integración ampliada y sondas antes/después. |

La 001 conserva exactamente sus bytes previos: SHA-256 de archivo Windows
`4d4916e61defe2ffee9b06662a82186ae8b7de022f60ae7296acbdd013dbd982`.
El checksum del ledger normaliza CRLF→LF para ser portable entre Windows y Linux:
para 001 es `5c5f8eed8ade4a6c6438bcf84f47d85d1da96a6cb5748f87638614c706331ccb`.
La diferencia entre esos hashes no representa una reescritura de la migración.

## Pruebas ejecutadas

| Suite/comando | Resultado final | Evidencia local |
| --- | --- | --- |
| `node --test "test/**/*.test.js"` en tools/calculate-cpk-ppk | **63/63**: conserva las 62 anteriores + 1 | `durability-fix-evidence/cpk.txt` |
| Mismo comando en tools/run-msa-analysis | **55/55** | `durability-fix-evidence/msa.txt` |
| `node --test db/test/durability.test.mjs` | **21/21** | `durability-fix-evidence/postgres-original.txt` |
| `node --test db/test/durability-hardening.test.mjs` | **65/65** | `durability-fix-evidence/postgres-hardening.txt`, `hardening-result.json` |
| `node db/review/durability-probes.mjs` | **18 grupos completados**, 9 por tool, código 0 | `durability-fix-evidence/audit-probes.txt`, `probes-after.json` |
| `git diff --check` | Sin errores | Verificado al cerrar el diff |

Los contadores PostgreSQL de Node incluyen los grupos padre, como en el informe
anterior. Los 204 no representan 204 escenarios independientes de crash.

La suite ampliada verifica específicamente:

- Adopción del ledger 001 sin checksum a 001/002, repetición de migración y rol
  migrador no superusuario; DDL y escritura de ledger denegados al runtime.
- Índice no único, predicado único incorrecto, claves de índice distintas,
  índice único imprevisto, herencia, columna generada, PK
  ausente, tipo y nulabilidad cambiados, constraint extra, secuencia distinta,
  versión ausente/futura y checksum adulterado. Migración y operaciones fallan.
- Recuperación sin /ready/ping tras caída y arranque real de PostgreSQL; durante
  la caída se rechazan lecturas y las cuatro vías de escritura. Al volver la DB,
  una operación normal recupera, lo rechazado no aparece y se puede volver a
  confirmar estudios, cursor, specs y criterios. Otro store ve los datos durables.
- Veinte lecturas simultáneas bloqueadas mediante un lock real del ledger:
  una sola comprobación de recuperación en espera, clientes acotados y todas
  las lecturas completadas tras liberar el lock.
- Permisos PUBLIC/directos por columna y tabla, membresías privilegiadas y
  NOINHERIT, propiedad de tipos y privilegios fuera de las tablas de aplicación.
- Error deliberado de INSERT de historial mediante trigger de prueba: el upsert
  de criterios revierte y no aparece una versión/historial parcial. No se confunde
  rechazo previo por permisos con rollback posterior al upsert.
- Matriz idéntica de límites CPK para RAM y PostgreSQL, con P1/P2 de límites
  diferentes, global más nuevo y opción explícita allowGlobal=false.

Durante el desarrollo, la prueba de parada real detectó un error no manejado de
un client adquirido; se corrigió con listener durante su uso y release(error).
También se detectó que un hash de bytes CRLF no era portable: los checksums del
ledger/test se normalizaron a LF. La ejecución final está libre de ambos fallos.

## Cambios de contrato y compatibilidad

1. El runtime exige esquema **001 + 002**, sus checksums y permisos efectivos
   correctos. Una base solo con 001 debe migrarse explícitamente y recibir grants
   mínimos antes de usar este runtime. El arranque no migra ni modifica permisos.
2. Una base corrupta no se «arregla» borrando duplicados o recreando índices en
   caliente: el migrador revierte y las APIs rechazan operaciones. Corregir datos
   existentes requiere una acción revisable aparte. Un administrador que edite
   el catálogo puede volver a romper la base; no se promete proteger contra un
   superusuario malicioso ni garantizar SQL directo sobre un índice ya corrupto.
3. CPK mantiene global permitido por defecto y añade `{ allowGlobal: false }` al
   método interno findSpec. No cambian endpoints ni payloads de publicación.
   El fallback histórico de MSA permanece sin cambios.
4. Un conflicto SQL lógico, como 23505, ya no marca toda la base como indisponible.
   Conserva SQLSTATE y aborta el procesamiento con kind retryable. El middleware
   HTTP genérico responde 500 a esos errores no mapeados; no se introdujo un nuevo
   contrato 409. Los fallos de disponibilidad/esquema/permisos siguen dando
   `503 persistence_unavailable` sin recurrir a RAM.
5. El runtime puede recuperar mediante la siguiente operación; no reproduce
   automáticamente escrituras cuya confirmación falló. COMMIT con respuesta
   perdida sigue siendo un resultado incierto hasta una futura idempotencia
   transaccional de inbox/outbox.

## Diffs y alcance preservado

`durability-fix-evidence/before.json` registra el working tree auditado anterior a
las correcciones. Para archivos que entonces no tenían cambios se compara HEAD.
El patch de esta entrega contiene solo el delta de correcciones:
[`durability-fixes-20261021.patch`](durability-fixes-20261021.patch).
Las evidencias de ejecución se enlazan aparte para no inflar ese diff con logs.

El patch histórico `industrial-durability-20261021.patch` permanece intacto
(SHA-256 `1fa179c75f4446dd06e841df2a6ea2e8919b4e979885294a29887189658158ca`).
No se reescribieron la auditoría ni el diseño previo. railway.toml, Dockerfiles,
workflows y .dockerignore siguen sin cambios frente a HEAD. Las modificaciones
previas de compose/.env.example no se alteraron en esta corrección.

## Pendientes explícitos

### Baseline del cierre de startup, Node 22 y CI (antes de editar)

Repositorio `C:/Users/aabaro/AJTool`, rama `dev/industrial-durability-20261021`,
HEAD `5b9c8c8f3bac1db1d707db2d10ffbeea16533586`. Working tree previo preservado:
14 archivos tracked modificados, 267 inserciones/405 eliminaciones, además de
los archivos untracked de las fases anteriores. Status, diff stat y contenido
anterior se guardan en `durability-fix-evidence/closure-before.json`.

Estado observado: Node local v24.22.0; ambos packages declaran Node >=22 y
pnpm@11.7.0; ambos Dockerfiles usan node:22-slim. El workflow reutilizable
`.github/workflows/tests.yml` ya usa Node 22 para backends y builds frontend;
no ejecuta PostgreSQL. `deploy-railway.yml` consume ese workflow mediante
workflow_call y depende de su resultado. No se cambiará ese deploy.

Ambos server.js esperan createStore, pero este devuelve un store indisponible
tras fallar la validación inicial; después se construyen core/poller/app y se
abre HTTP. Las suites DB existentes son `node --test db/test/durability.test.mjs`
(21), `node --test db/test/durability-hardening.test.mjs` (65) y
`node db/review/durability-probes.mjs` (18 grupos). Exigen el contenedor local
postgres:16 con puerto 127.0.0.1:55439. El checkpoint previo suma 204 tests.
No existe graphify-out/graph.json; se usa inspección focalizada para respetar
la instrucción de no repetir una auditoría ni generar un grafo completo.

Los pendientes siguientes describen el checkpoint previo; el resultado del
cierre se registra al final de este mismo documento.

- A05: se conserva el arranque degradado. Esquema inválido implica APIs/readiness
  503, pero proceso vivo y /health 200; no se implementó fail-fast ni un gate de deploy.
- Node local v24.22.0/PostgreSQL 16 real. No se ejecutaron matriz Node 22, imágenes
  completas, compose up con volumen antiguo ni dos migradores concurrentes.
- La integración DB continúa fuera del workflow de CI existente; sus comandos
  se ejecutaron explícitamente en local. No se cambió ese workflow.
- A07 (texto dañado en DESPLIEGUE) y los defaults locales de compose señalados
  en la auditoría permanecen pendientes; no se arrancó compose ni se cambió
  su endpoint del core o su publicación de puertos durante esta corrección.
- No se midió carga sostenida. Validar el catálogo antes de operaciones agrega
  trabajo; cualquier futura optimización debe mantener las garantías de permisos
  y esquema, no volver a aceptar versiones/grants incorrectos.
- TLS remoto heredado con rejectUnauthorized=false y conversión de seq a Number
  quedan fuera de estos cuatro cambios. No se conectó ninguna base remota.
- Atomicidad entre estudio, rechazo, cursor y envío remoto; IDs/envelopes inmutables,
  worker de outbox y separación persistida shadow/live siguen siendo diseño pendiente.
  Esta entrega se detiene antes de implementarlos.

No se aprobaron implícitamente tareas pendientes ni despliegues por completar las
pruebas. Los únicos reinicios y cambios SQL fueron sobre el PostgreSQL aislado y
bases/roles de prueba generados para estas ejecuciones.

## Cierre: startup fail-fast, Node 22 y PostgreSQL en CI

### Semántica de arranque y recuperación

Antes: createStore devolvía un store indisponible, pero server.js abría HTTP y
poller. Ahora ambos entrypoints pasan `failFast: true`. Si PostgreSQL es requerido
(por DATABASE_REQUIRED o DATABASE_URL) y la validación inicial falla, se cierra
el pool y se emite `STARTUP_CONFIGURATION_FAILURE [reason]`; el proceso sale con
código 1 antes de construir core, publisher, dominio, poller o app/listen. No hay
readiness ni escrituras aceptadas, migraciones de arranque o fallback a RAM.
Los diagnósticos son textos fijos: no incluyen URL, contraseña ni SQL original.

Razones deterministas: database_url_missing, database_authentication_failed,
database_not_found, database_role_unsafe, database_privileges_invalid,
database_migration_invalid, database_schema_incompatible, database_unavailable.
No se promete distinguir caída temporal de una configuración de red errónea
durante el arranque: ambas bloquean ese arranque y un supervisor puede reintentar.

Después de un arranque válido, las fallas transitorias conservan HTTP vivo,
readiness/API 503 y recuperación antes de operaciones con backoff/singleflight
existentes. No disparan el gate de arranque ni terminan el proceso. Las nuevas
pruebas detienen PostgreSQL con el servidor real ya listo y recuperan mediante
GET /api/studies, sin solicitar /ready para recuperar. También comprueban una
escritura persistida tras recuperación. Los 21/65 casos anteriores permanecen.
El modo RAM explícito sin PostgreSQL requerido conserva su comportamiento.

El default del factory createStore conserva la capacidad de construir un store
indisponible para comprobar recuperación; el gate es obligatorio en los dos
entrypoints de servicio y en el preflight CI. No cambia el contrato HTTP normal,
la precedencia CPK, el validador 002 ni los privilegios concedidos.

### Node 22

Validación local con Node **v22.23.4**, archivo oficial Windows x64 verificado con
SHA-256 `cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20`.
Ambos backends completan `pnpm install --frozen-lockfile` con **pnpm 11.7.0**,
también desde directorios temporales vacíos: 89 paquetes por backend. Los logs
`closure-install-*.txt` y `closure-installs.json` registran el resultado. No se
cambiaron package.json/lockfiles/engines/Dockerfiles: ya soportaban Node 22.
pnpm mostró un aviso de actualización; no se actualizó ni amplió la matriz Node.
No se observó un cambio de comportamiento en las suites previas bajo Node 22.

### Arquitectura CI y pruebas negativas

Se agrega un job PostgreSQL al workflow reutilizable existente
`.github/workflows/tests.yml` (pull_request/workflow_call). Usa setup-node 22,
instala ambos backends con sus lockfiles y ejecuta exactamente:

```sh
node db/test/run-postgres-tests.mjs
```

El runner exige Node 22, crea un contenedor postgres:16 con nombre aleatorio y
label de prueba, usuario/base admin sintéticos y binding únicamente loopback.
Elige un puerto libre y lo fija durante toda la vida del contenedor, incluidos
los reinicios. Espera PostgreSQL por TCP, ejecuta migrate.sql/runtime-role.sql
desde cero con un owner no superusuario y valida el runtime restringido mediante
`node db/test/check-database.mjs`. Después ejecuta original, extended, startup,
18 sondas y pruebas negativas del comando CI completo, secuencialmente.
Las credenciales públicas de prueba están solo en db/test; las imágenes runtime
copian src y no incluyen este harness. No se consulta DATABASE_URL del entorno
para seleccionar una base remota; las URLs se generan sobre loopback.

Los helpers permiten el contenedor histórico o un contenedor CI cuyo nombre,
label, imagen y binding loopback se validan antes de mutaciones/reinicios.
Cada fixture elimina bases/roles; el runner elimina su contenedor y volumen en
finally. No depende del contenedor ni de un esquema preexistente del desarrollador.

`ci-failure-proof.test.mjs` ejecuta tres veces el mismo runner con
`--negative-fixture=incompatible-schema`, `missing-migration` e
`insufficient-permissions`. En cada contenedor nuevo se aplica una mutación
deliberada tras migrar, y se exige que el comando completo salga 1, emita la razón
esperada, no llegue a POSTGRESQL_CI_GATE_PASSED y elimine su contenedor. No se
alteran archivos de migración para producir estos fallos. Las pruebas startup
restauran además sus mutaciones en finally y revalidan cada fixture restaurada.

El job no tiene continue-on-error: instalación, migración, esquema/checksum,
permisos, suites o sondas fallidas dejan el workflow rojo. El workflow de deploy
ya dependía del workflow Tests y permanece intacto. Que un check rojo impida el
merge depende de los required checks configurados en GitHub: no se inspeccionó
ni se cambió esa política remota, ni se ejecutó ningún despliegue.

### Archivos del delta y evidencia

Cambios pequeños por responsabilidad:

- Ambos startup-error.js: clasificación fija y segura del fallo inicial.
- Ambos store.js: opción de gate inicial y cierre del pool; recuperación intacta.
- Ambos server.js: gate antes de inicialización y salida 1 con diagnóstico.
- test-environment.mjs/isolated-postgres.mjs/durability.test.mjs: entorno aislado
  parametrizable y readiness TCP para reutilizar los 21/65 tests en CI.
- startup-process.mjs/startup.test.mjs: procesos reales, errores, ausencia de
  HTTP/escrituras, restauración y distinción entre arranque y caída en ejecución.
- check-database.mjs: mismo gate del servidor como comando ejecutable.
- run-postgres-tests.mjs/ci-failure-proof.test.mjs: orquestación desde cero,
  propagación de fallos y demostración negativa con limpieza automática.
- durability-probes.mjs: mismas 18 sondas; la de esquema ausente ahora exige
  salida 1 sin HTTP, en lugar de proceso degradado. Salida de evidencia configurable.
- tests.yml: nuevo job dentro de la arquitectura CI existente.
- db/README.md y este documento: comandos, contratos, resultados y límites.

`durability-fix-evidence/closure.patch` compara únicamente este cierre contra el
checkpoint recibido, incluyendo archivos que ya eran untracked; no usa HEAD
como sustituto del checkpoint. `closure-changes.txt` enumera sus archivos.
Los patches anteriores, migraciones 001/002, contrato PostgreSQL, precedencia CPK,
compose, .env.example, Dockerfiles y configuración productiva quedan intactos
respecto al baseline recibido. No se preparó ningún archivo en el index.

### Alcance de las afirmaciones

**LOCAL TESTED:** Node 22 Windows y PostgreSQL 16 real mediante Docker local;
el comando que usará CI se ejecuta localmente, incluidos sus caminos de fallo.
**CI TESTED:** pendiente una ejecución remota de GitHub Actions; no hay push ni
run remoto en esta entrega. YAML configurado no equivale a ejecución remota.
**PRODUCTION VERIFIED:** no; no se accedió ni modificó producción.

Las primeras ejecuciones encontraron dos defectos del harness nuevo (ruta del
log y puerto Docker reasignado tras restart), corregidos antes del resultado
final. Otra ejecución falló por timeout de un docker exec en Windows durante
una sonda; no se ocultó el fallo ni se cambió su assertion para aceptarlo.
El resultado final y cualquier recurrencia se registran a continuación.

Los pendientes históricos de startup, Node 22 y configuración CI se sustituyen
por este cierre. Permanecen fuera de alcance: verificación remota de Actions y
required checks, imágenes completas/frontend en esta entrega, carga sostenida,
TLS remoto heredado, seq/Number y los otros pendientes históricos ajenos a este
cierre. Inbox/outbox permanece sin implementar.

### Resultado final local

| Comando/suite bajo Node v22.23.4 | Resultado | Evidencia en durability-fix-evidence/ |
| --- | --- | --- |
| CPK: node --test "test/**/*.test.js" | **63/63** | closure-cpk.txt |
| MSA: mismo comando | **55/55** | closure-msa.txt |
| PostgreSQL original | **21/21** | closure-postgres-original.txt |
| PostgreSQL extended | **65/65** | closure-postgres-hardening.txt |
| Startup fail-fast y runtime real | **28/28** | closure-startup.txt |
| Comando CI completo con tres fixtures negativas | **3/3** | closure-failure-proof.txt; negative-*/closure-initialization.txt |
| Total de entradas de test Node | **235/235** | 204 previas + 31 nuevas; sin fallos/omitidas/canceladas |
| Sondas corregidas, contadas aparte | **18/18** | closure-probes.json; closure-probes.txt |
| Runner CI desde cero | **exit 0**, POSTGRESQL_CI_GATE_PASSED | closure-runner.txt |
| git diff --check | **exit 0** | comprobación final local |

El runner final completó las sondas sin recurrencia del timeout Docker anterior.
Las suites anteriores no perdieron casos; las entradas padre siguen incluidas
en los contadores de Node. La sonda de arranque cambia explícitamente de contrato:
antes proceso vivo/503; ahora proceso terminado con código 1 antes de HTTP.

**Estado: LOCALLY COMPLETE.** Gate CI implementado y ejercitado localmente,
pendiente confirmar su ejecución en GitHub y configurar/verificar required checks
si se requiere impedir merges. No se afirma CI TESTED remoto ni PRODUCTION VERIFIED.
Sin commit, stage, push, merge o deploy. **STOPPED BEFORE INBOX/OUTBOX.**
