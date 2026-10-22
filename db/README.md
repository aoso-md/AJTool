# Persistencia PostgreSQL

El arranque y `/ready` solo verifican conectividad, esquema y privilegios.
No ejecutan DDL. Una URL configurada hace obligatoria la persistencia, incluso
si `DATABASE_REQUIRED=false`. `DATABASE_REQUIRED=true` también rechaza operaciones
cuando falta la URL. El modo memoria requiere ambas opciones ausentes/desactivadas.

Con PostgreSQL obligatorio, estudios, cursores, especificaciones y criterios
se confirman en PostgreSQL antes de actualizar memoria. Las lecturas tampoco
recurren a datos volátiles durante una caída. HTTP devuelve
`503 {"error":"persistence_unavailable", ...}`; `/health` sigue dando 200 y
`/ready` da 503. Cada operación valida la base, sin depender de llamadas a `/ready`.
Las operaciones concurrentes comparten una única validación/recuperación en curso;
tras un fallo hay un backoff de 250 ms, pool de hasta 5 conexiones, conexión de 2 s,
statement timeout de 5 s, query timeout de 6 s y lock timeout de 2 s.
No se reproducen escrituras rechazadas. Una operación posterior puede recuperar
el servicio cuando vuelve la base y se verifica el contrato completo.

## Migración y roles

Estos comandos son instrucciones para una base dedicada, no autorización para
aplicarlos a producción. No se modificaron servicios externos.

1. Crear un rol propietario de esquema y otro LOGIN para runtime, con credenciales
   distintas. El runtime no debe poseer objetos ni pertenecer al rol propietario
   o a ningún otro rol, ni siquiera mediante membresías NOINHERIT/SET ROLE.
   Aprovisionar su contraseña fuera de los scripts SQL. El migrador puede ser un
   propietario de base sin SUPERUSER/CREATEDB/CREATEROLE; crear los dos LOGIN es
   una preparación administrativa separada, no un privilegio del runtime.
2. Conectar como propietario y ejecutar desde la raíz:

   ```powershell
   psql -X -v ON_ERROR_STOP=1 -f db/migrate.sql <conexion-propietario>
   ```

   Las migraciones son transaccionales, se serializan con advisory lock y registran
   versión y checksum en `schema_migrations`. La 001 permanece intacta. La 002
   añade checksum y una función de validación SECURITY INVOKER. Antes de registrar
   versiones, comprueba columnas/tipos/nulabilidad, PK/constraints, definición real
   de índices y predicados, secuencia y defaults; rechaza índices extra, herencia y columnas generadas.
   Un esquema incompatible aborta
   la transacción; no se borra, deduplica ni repara automáticamente.
   Los SHA-256 se calculan sobre UTF-8 con saltos LF para Windows/Linux. La suite
   verifica que los archivos coinciden con el manifiesto. El runtime exige
   exactamente las versiones 001/002 y sus checksums. `db/schema.sql` es un alias
   psql del migrador, no SQL genérico para otros clientes.
3. Como administrador de esa base dedicada, aplicar permisos:

   ```powershell
   psql -X -v ON_ERROR_STOP=1 -v runtime_role=ajtool_runtime -f db/runtime-role.sql <conexion-administrador>
   ```

   El script rechaza roles propietarios, administrativos o con membresías antes
   de hacer cambios; no los degrada ni elimina membresías automáticamente.
   Revoca CREATE/TEMP concedidos a PUBLIC, CREATE del esquema public, permisos
   directos del runtime y grants de PUBLIC en tablas, columnas, secuencias y funciones.
   Concede solo CONNECT,
   USAGE del esquema, SELECT/INSERT/UPDATE en tablas operativas, SELECT/INSERT en
   historial y USAGE/SELECT en su secuencia. Solo concede SELECT en schema_migrations
   y EXECUTE en el validador SECURITY INVOKER, sin elevación. No concede DELETE,
   TRUNCATE, UPDATE de historial ni DDL. No es para bases compartidas con otras aplicaciones.
4. Configurar únicamente la conexión runtime en `DATABASE_URL`. El servicio rechaza
   credenciales con privilegios administrativos, CREATE/TEMP o propiedad de objetos
   en esquemas de usuario, incluidos tipos; también comprueba permisos efectivos
   por tabla/columna/secuencia, grants de PUBLIC y capacidades fuera de las tablas
   de la aplicación. Un grant inseguro en otro esquema se rechaza y requiere una
   corrección administrativa explícita; no se borra otro esquema para habilitar la tool.

El compose local tiene un job `migrate` separado y ambos servicios esperan su
finalización. `local-bootstrap.sql` usa credenciales públicas de desarrollo;
no se debe ejecutar fuera de un entorno local dedicado. No se ejecutó compose up.

## Pruebas reales

Para un entorno nuevo, con Node 22 y Docker disponibles, el mismo comando que CI
crea PostgreSQL 16 efímero, migra desde cero y ejecuta todas las suites DB:

```sh
node db/test/run-postgres-tests.mjs
```

No necesita el contenedor local histórico. Usa credenciales sintéticas, un puerto
exclusivamente loopback que conserva durante reinicios y bases/roles desechables.
Elimina su contenedor/volumen en finally, incluso cuando falla una prueba. Incluye
startup fail-fast y tres demostraciones de que el comando CI completo sale con
código 1 ante esquema incompatible, migración ausente o permisos insuficientes.
El job PostgreSQL de `.github/workflows/tests.yml` no usa secretos productivos.
Detalles y estado de validación en
`docs/CORRECCIONES-DURABILIDAD-20261021.md`, sección de cierre.

Los comandos siguientes permiten ejecutar individualmente las suites contra
el contenedor histórico reservado para pruebas:

```powershell
node --test db/test/durability.test.mjs
node --test db/test/durability-hardening.test.mjs
node db/review/durability-probes.mjs
```

La suite exige el contenedor `ajtool-industrial-test-20261021`, imagen postgres:16,
publicado únicamente en 127.0.0.1:55439 y usuario administrador ajtool_migrator.
Crea bases/roles con sufijo aleatorio y los elimina al terminar. Detiene y reinicia
solo ese contenedor: no debe contener trabajo ajeno a estas pruebas. No usa
DATABASE_URL del entorno, Railway, Supabase ni servicios ORCA.

Comprueba esquema ausente, migración repetible, rol administrativo rechazado,
DDL denegado, cuatro vías de escritura, rollback de criterios e historial,
caída real, arranque durante caída, HTTP 503, reconexión y recreación del store.
Los datos confirmados persisten y los rechazados no aparecen tras recuperar.
La suite normal de cada herramienta sigue siendo `node --test "test/**/*.test.js"`.

La suite ampliada usa migradores y runtimes sintéticos sin superusuario y prueba
adopción 001→002, índices/constraints/versiones adulterados, permisos efectivos,
concurrencia y parada/reinicio real sin ping/ready manual. Las sondas posteriores
a la corrección guardan `docs/durability-fix-evidence/probes-after.json`; la evidencia
histórica de auditoría se conserva. CPK prueba el mismo contrato en RAM y PostgreSQL:
pieza exacta, luego global por defecto; `{ allowGlobal: false }` desactiva el global.
Nunca busca otra pieza. No se cambia el contrato histórico de specs de MSA.
