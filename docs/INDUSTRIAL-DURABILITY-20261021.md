# Durabilidad industrial — 2026-10-21

Rama: `dev/industrial-durability-20261021`. Escritura del workspace comprobada
mediante creación, lectura y eliminación de un archivo temporal. Árbol inicial limpio.
Sin repetir la auditoría completa y sin avanzar a inbox/outbox.

## Cambios revisables

1. `db/migrate.sql` y `db/migrations/001-initial.sql`: DDL fuera del arranque;
   transacción, bloqueo de migraciones concurrentes y registro de versión.
   `db/schema.sql` delega al migrador.
2. `db/runtime-role.sql`: permisos DML mínimos y revocación de CREATE/TEMP.
   Ambos stores rechazan roles propietarios/administrativos o con permisos DDL.
   El compose local ejecuta una migración separada con propietario y usa runtime
   distinto en ambos servicios. No se ejecutó compose up.
3. Ambos stores: PostgreSQL configurado implica persistencia obligatoria;
   `DATABASE_REQUIRED=true` también protege una URL faltante. No se confirma
   escritura antes del éxito SQL y no se usa memoria como alternativa durante
   caída. Las lecturas también se rechazan para evitar cursores/criterios obsoletos.
   HTTP devuelve `503 persistence_unavailable`; health sigue vivo, ready detecta
   caída y reconexión mediante consultas reales y validación del esquema/rol.
4. `db/test/durability.test.mjs`: pruebas repetibles con PostgreSQL 16 real.
   `db/README.md`: ejecución y límites de migraciones, roles y pruebas.

## Resultados finales

| Suite | Resultado | Comando |
| --- | --- | --- |
| CPK completa | 62/62, cero omitidas | `node --test "test/**/*.test.js"` desde tools/calculate-cpk-ppk |
| MSA completa | 55/55, cero omitidas | `node --test "test/**/*.test.js"` desde tools/run-msa-analysis |
| PostgreSQL 16 real | 21/21, cero omitidas | `node --test db/test/durability.test.mjs` desde raíz |

El contador PostgreSQL incluye el test raíz y dos grupos: son nueve casos
funcionales por herramienta. Incluyen migración repetida, runtime sin DDL,
rechazo de credenciales administrativas, cuatro vías de escritura, rollback
transaccional de criterios/historial, parada real de PostgreSQL, rechazo durante
caída y al arrancar durante caída, HTTP 503, reconexión y recreación del store.
Se verificó que estudios, cursores, especificaciones, criterios e historial
confirmados sobreviven, que las escrituras rechazadas no aparecen y que se
puede volver a escribir después de recuperar.

Único contenedor intervenido: `ajtool-industrial-test-20261021`, `postgres:16`,
127.0.0.1:55439. Se dejó arrancado. Bases y roles temporales de cada ejecución
se eliminan en finally; la base preexistente ajtool_test se conserva.

## Límites y siguiente punto

No se cambiaron Railway, Supabase productivo ni dominios ORCA. Sin push, merge
ni deploy. No se implementaron inbox/outbox ni garantías de atomicidad entre
persistencia local y publicaciones remotas. Esa fase queda pendiente de revisión
de estos resultados y diffs. Un error de conexión durante COMMIT puede dejar un
resultado incierto: el servicio responde 503 sin afirmar que no hubo commit.

La migración 001 conserva tablas existentes con IF NOT EXISTS; no repara esquemas
incompatibles. El runtime los rechaza si faltan columnas necesarias. Los permisos
se preparan para una base dedicada y el runtime verifica privilegios al arrancar
y en ready. No se validaron imágenes completas ni despliegues externos.

Diff completo (incluye nuevos archivos): `industrial-durability-20261021.patch`.
