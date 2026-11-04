# Restauración ensayada de PostgreSQL

`node db/test/run-postgres-tests.mjs --only=backup-restore` crea sólo fixtures desechables locales del runner rotulado; nunca usa DATABASE_URL externa. Valida CPK/MSA con creación API, shadow, dump custom, AES256-GCM autenticado, restauración en otra fixture, 13 tablas comparadas íntegramente antes del arranque, mínimo privilegio, cursor mayor a2^53, criterios/historial e inbox/rechazo, estudio/outbox iguales tras dos arranques. Cero ORCA live.

Archivo de evidencia: artifacts/official-release-20261029/restore-final/backup-restore-{cpk,msa}.json. La clave sintética existe sólo en memoria durante la prueba y se destruye; no se conserva un backup operacional restaurable de producción ni se afirma haber extraído RAM oficial.

`archive.mjs` es la primitiva de sellado/verificación offline, no un servicio de backups. Clave32bytes custodiada fuera de Git, independiente del password DB. La prueba detecta clave incorrecta y metadatos alterados. Para el destino real, usar respaldo soportado y custodia de claves/retención aprobadas por el operador; restaurarlo primero en un destino aislado. Ninguna prueba de fixture acredita por sí sola los backups gestionados del Supabase concreto.
