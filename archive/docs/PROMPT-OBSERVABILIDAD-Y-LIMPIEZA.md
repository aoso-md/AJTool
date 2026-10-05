# Prompt para Codex — observabilidad de despliegues y limpieza

Copiar y pegar completo. Está escrito para que un agente que arranca sin
contexto entienda el repo, el objetivo y —sobre todo— qué NO debe romper.

---

## Contexto

Estás trabajando en `aoso-md/AJTool` (repo público, monorepo). Contiene
tres servicios Node.js independientes, sin framework, escritos solo con
módulos nativos (`http`, `fs`, `path`). La única dependencia npm en todo
el proyecto es `pg`, y es opcional: se carga de forma perezosa y solo si
existe `DATABASE_URL`.

| Servicio | Carpeta | Puerto |
|---|---|---|
| `calculate_cpk_ppk` | `tools/calculate-cpk-ppk` | 8081 |
| `run_msa_analysis` | `tools/run-msa-analysis` | 8082 |
| `quality-tools-bus-proxy` | `bus-proxy` | 8787 |

Cada tool expone: `GET /` (frontend HTML), `GET /health`, `POST /events`
(la llamada real, con el evento completo en el body) y `GET /reports`
(historial). El bus-proxy expone además
`GET /events/subscriptions/:toolId` y `GET /events/chain/:correlationId`.

Autenticación: si `INBOUND_API_KEY` está seteada, todo excepto `/` y
`/health` exige el header `x-api-key`. Historial: dos niveles —memoria
(últimas 100 llamadas, por defecto) y Postgres (duradero, si hay
`DATABASE_URL`)— y `/health` siempre reporta cuál está activo de verdad.

Pruebas: `node test/run-tests.js` desde la raíz. 36 pruebas, sin
dependencias y sin base de datos. Deben seguir pasando.

CI: `.github/workflows/docker-publish.yml` corre las pruebas y, solo si
pasan, publica dos imágenes a GHCR.

Despliegue actual: los dos tools corren en el Railway de un tercero
(ORCA), conectados directamente al repo público, no vía imagen Docker.
Los subdominios `ccp.orcalabs.mx` y `rma.orcalabs.mx` están provisionados
pero todavía no atados a ningún servicio.

## Problema a resolver

Cuando un servicio no levanta en el Railway del tercero, hoy no hay forma
de saber por qué desde el código. Los Deploy Logs solo muestran una línea
de arranque. No se puede responder con certeza ni la pregunta más básica:
*¿qué build está corriendo ahí?* Todo el diagnóstico se ha hecho por
capturas de pantalla de terceros.

## Objetivo

Que los Deploy Logs de Railway, por sí solos, respondan: qué commit está
desplegado, cómo quedó configurado el servicio, y qué pasó en cada
llamada. Y que la configuración de despliegue viva en el repo, no en el
dashboard de alguien más.

## Tareas

**1. Banner de arranque.** Que cada servicio imprima, en las primeras
líneas del log, su configuración efectiva: nombre del servicio, versión
o commit, puerto, si la autenticación está activa (nunca el valor de la
llave), y el nivel de persistencia. Debe leerse de un vistazo.

**2. Endpoint `GET /version`.** Sin autenticación, devuelve el commit SHA
y la fecha de build. Los valores entran por variable de entorno con un
fallback claro (`"unknown"`) cuando no vienen. Propagar el SHA como
build ARG en los dos Dockerfiles y setearlo desde el workflow de GitHub
Actions, que ya tiene `github.sha` disponible.

**3. Log estructurado por petición.** Una línea JSON a stdout por cada
llamada a `/events`: timestamp, método, ruta, código de respuesta,
duración en ms, tipo de evento, correlationId y veredicto. Nunca
registrar la API key ni el payload completo. Railway captura stdout, así
que no hace falta ningún servicio externo ni archivos de log.

**4. Configuración de despliegue versionada.** Agregar un `railway.json`
por servicio con `healthcheckPath` (`/health`), política de reinicio y
comando de arranque. Esto elimina el modo de falla más común de este
repo: que alguien configure mal el Root Directory en el dashboard y el
build falle porque en la raíz no hay `package.json`.

**5. Limpieza.** Revisar y proponer (no borrar sin confirmar): archivos
sueltos en la raíz que no pertenecen al código (`.docx`, `.pptx`), ramas
viejas ya fusionadas o abandonadas, y documentación que contradiga el
estado real del sistema. Reportar hallazgos antes de eliminar nada.

**6. Extender las pruebas.** Cubrir `/version` y el nuevo formato de log
en `test/run-tests.js`, con el mismo estilo del archivo (sin
dependencias, aserciones explícitas, mensajes de error que expliquen qué
se esperaba).

**7. Actualizar `docs/DEPLOYMENT.md`** con lo que se agregue, respetando
su estructura actual de runbook por síntoma.

## Restricciones — no negociables

- **Sin frameworks.** Nada de Express ni middleware. Solo `http` nativo.
- **Sin dependencias nuevas.** `pg` es la única permitida, y sigue siendo
  opcional y de carga perezosa.
- **No unificar las dos tools.** Los archivos `db.js` de cada tool son
  casi idénticos y eso es deliberado: la tesis del proyecto es *separate
  ownership, unified contracts*. Cada tool tiene dueño distinto y no debe
  depender del código de la otra. No extraer un módulo compartido entre
  fronteras de tools.
- **No tocar el contrato de eventos.** Los nombres de evento y la bandera
  `official: true/false` están confirmados con el cliente y documentados
  en `docs/OFFICIAL-EXTERNAL-ADMIN-CONTRACT.md`. Cambiarlos rompe la
  integración.
- **La persistencia jamás puede tumbar el servicio.** El pool de Postgres
  tiene un listener de `error` por una razón concreta: sin él, una
  conexión inactiva caída lanza una excepción no capturada, Node se sale
  y el servicio aparece offline. Mantener ese patrón y la degradación a
  memoria.
- **Reportar honestamente.** El sistema nunca debe afirmar una capacidad
  que no tiene: si no hay base de datos, `/health` lo dice. Mantener ese
  criterio en todo lo nuevo.
- **Nunca commitear secretos.** `.env` está en `.gitignore`. Todas las
  llaves se leen de variables de entorno.
- **Comentarios y nombres en inglés**, siguiendo la convención del repo,
  aunque esta conversación sea en español.

## Criterios de aceptación

1. `node test/run-tests.js` pasa completo.
2. No hay dependencias npm nuevas (revisar los tres `package.json`).
3. Arrancar cualquier servicio en local muestra el banner con la config
   efectiva en las primeras líneas.
4. `GET /version` responde el commit desplegado.
5. Una llamada a `/events` produce exactamente una línea JSON de log, sin
   la API key.
6. Los servicios siguen arrancando sin `npm install` y sin
   `DATABASE_URL`.

## Antes de empezar

Leer `docs/DEPLOYMENT.md` y `docs/OFFICIAL-EXTERNAL-ADMIN-CONTRACT.md`, y
revisar `tools/calculate-cpk-ppk/src/server.js` y `src/db.js` como
referencia del estilo y de los patrones que hay que conservar.
