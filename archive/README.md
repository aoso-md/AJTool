# archive/ — versión anterior, conservada como referencia

Todo lo que hay aquí es la versión de este repo **anterior** a la integración
con la plataforma ORCA. No se ejecuta, no se despliega (está fuera del contexto
de Docker y de los workflows) y no se mantiene. Se conserva para no perder el
trabajo ni el razonamiento, y porque el historial de git no es cómodo de leer.

| Carpeta | Qué era | Qué lo reemplaza |
|---|---|---|
| `bus-proxy/` | Bus de eventos propio (en memoria) que imitaba al core | El core de ORCA: `/api/v1/events`, suscripciones y cadena |
| `workspace/` | Consola de demostración con datos de ejemplo | La interfaz de cada tool, con datos reales |
| `contracts/` | Esquemas de eventos propios (sobre `{type, payload}`) | Industrial Event Standard del core · `docs/CONTRATO.md` |
| `adapters/` | Borradores de adaptadores hacia la plataforma | La integración real en `tools/*/src/platform/` |
| `obsidian/` | Notas propias por evento | `cerebro/` del core |
| `tools-v1/` | Handlers, servidores, demos e interfaz anteriores de cada tool | `tools/*/` |
| `docs/` | Documentos de trabajo y de juntas anteriores | `docs/` de la raíz |
| `test-v1/` | Suite de pruebas anterior | `tools/*/test/` |
| `presentaciones/` | Presentación y documento de MARLI | — |
| `github-workflows/` | Publicación de imágenes a GHCR | `.github/workflows/deploy-railway.yml` (estándar de la plataforma) |
| `docker-v1/` | Dockerfiles anteriores (solo backend, Node 18) | `docker/` (plantilla del core: back + front, Node 22) |
| `db-v1/` | Esquema anterior (`invocations`, `bus_events`) | `db/schema.sql` |
| `README-v1.md` | README anterior de la raíz | `README.md` |
