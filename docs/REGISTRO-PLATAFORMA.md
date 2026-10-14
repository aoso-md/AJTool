# Registro en la plataforma (`deployments.json` del core)

El último paso del proceso estandarizado (`plantillas/integracion/README.md`,
paso 5): una entrada por tool en `src/data/platform/deployments.json` del repo
del core. Eso es lo que hace aparecer la tool **en línea** en el dashboard.

**Antes de aplicarlo:** `docs/DESPLIEGUE.md` §4 en verde (la tool recibe
eventos, persistencia en Postgres, publicación en `shadow`). Aplicarlo con la
tool apagada deja la cadena ISO muda río abajo.

---

## El cambio

Archivo listo para aplicar: [`deployments-ajtool.patch`](./deployments-ajtool.patch)
(contra `feature/filter` del core).

```bash
# en el repo del core
git apply /ruta/a/AJTool/docs/deployments-ajtool.patch
npm run validate      # -> OK · 125 tools en el catalogo · 16 registradas
```

Verificado así antes de entregarlo: el validador del core pasa, y las dos
tools dejan de aparecer en sus avisos de "federated sin subdomain".

Las dos entradas quedan:

```json
{
  "toolId": "calculate_cpk_ppk",
  "kind": "federated",
  "status": "live",
  "subdomain": "ccp",
  "localPort": 8108,
  "owner": "Equipo externo (AJTool)",
  "repo": "AJTool",
  "isoClause": "9.1.3",
  "summary": "Capacidad de proceso Cp/Cpk (σ dentro) y Pp/Ppk (σ global) con ppm esperado; publica CAPABILITY_BELOW_TARGET cuando Cpk < mínimo.",
  "note": "…ver el parche…"
},
{
  "toolId": "run_msa_analysis",
  "kind": "federated",
  "status": "live",
  "subdomain": "rma",
  "localPort": 8109,
  "owner": "Equipo externo (AJTool)",
  "repo": "AJTool",
  "isoClause": "7.1.5.2",
  "summary": "Estudio Gage R&R (AIAG, promedios y rangos) por cada equipo registrado; publica MSA_VALIDATED con el veredicto acceptable | marginal | unacceptable.",
  "note": "…ver el parche…"
}
```

- `subdomain` `ccp` / `rma`: los que ya están provisionados en `orcalabs.mx`.
- `localPort` 8108 / 8109: libres en el registro (8101–8107 ya están tomados),
  y son los puertos por defecto de cada tool, así que el modo local del core
  (`PLATFORM_LOCAL_TOOLS=true`) las encuentra sin configurar nada.
- `requiredRoles` se omite a propósito: se heredan de la categoría `quality`
  (`quality.engineer` … `quality.director`), como en las demás de calidad.
- `owner`: confirmar el nombre del equipo con el que plataforma quiere
  registrarlo.

---

## Qué pasa en el core al aplicarlo

`isHandledExternally()` (`src/services/deploymentService.js`) devuelve `true`
en cuanto la tool tiene URL resoluble. Desde ese momento el bus:

- marca la arista como **delegada** en la cadena, en lugar de ejecutar
  `src/tools/calculate_cpk_ppk.js` / `run_msa_analysis.js` (los mocks del core,
  que quedan como referencia del contrato);
- deja el evento en el log, donde la tool lo recoge por
  `/events/subscriptions/<toolId>`.

Y la sonda del dashboard (`healthProbe.js`) empieza a pegarle a
`https://ccp.orcalabs.mx/health` y `https://rma.orcalabs.mx/health` cada vez
que alguien abre el dashboard (con caché de 15 s).

---

## Prueba de punta a punta contra el core real

Hecha antes de entregar, con el código del core (`feature/filter`), su
`db/init.sql`, una API key creada con su `scripts/createApiKey.js`, el parche
aplicado y `PLATFORM_LOCAL_TOOLS=true`:

```
PRODUCT_SPEC_UPDATED → bus: collect_quality_measurements → MEASUREMENTS_CAPTURED
                           calculate_control_charts     → CHART_POINTS_UPDATED
                           calculate_cpk_ppk            → DELEGADA

log de evidencia del core (GET /events/chain/:correlationId):
  PRODUCT_SPEC_UPDATED     manage_product_specs
  MEASUREMENTS_CAPTURED    collect_quality_measurements   causado por PRODUCT_SPEC_UPDATED
  CHART_POINTS_UPDATED     calculate_control_charts       causado por MEASUREMENTS_CAPTURED
  CAPABILITY_BELOW_TARGET  calculate_cpk_ppk              causado por MEASUREMENTS_CAPTURED  (cpk 0.4387, not_capable)

NEW_DEVICE_REGISTERED → bus: run_msa_analysis → DELEGADA
  (estudio pendiente → captura en la UI → publicado)
  NEW_DEVICE_REGISTERED    manage_device_registry
  MSA_VALIDATED            run_msa_analysis               causado por NEW_DEVICE_REGISTERED  (acceptable)
  CHART_POINTS_UPDATED     calculate_control_charts       causado por MSA_VALIDATED  ← la cadena sigue desde nuestro evento

sonda del dashboard (GET /api/v1/console/health):
  calculate_cpk_ppk   up · 200
  run_msa_analysis    up · 200
```

Y en el dashboard: ambas fichas en **"en línea"**, modo federada, con sus
eventos publicados y el botón "Abrir herramienta".
