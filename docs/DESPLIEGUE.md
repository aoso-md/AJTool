# Despliegue en la plataforma ORCA

Cómo quedan en línea `calculate_cpk_ppk` y `run_msa_analysis` en el dashboard
de ORCA, siguiendo el proceso estandarizado del repo del core
(`carcamfer/IsoTools`, rama `feature/filter`, carpeta
`plantillas/integracion/`).

---

## 0. Por qué salían "offline" — la causa, verificada en el código del core

El dashboard **no** mira tu Railway. Dibuja cada tool a partir de
`src/data/platform/deployments.json` del core, y la sonda de salud
(`src/services/healthProbe.js`) solo le pega a una tool si esa entrada tiene
`subdomain`. Las dos estaban así:

```json
{ "toolId": "calculate_cpk_ppk", "kind": "federated", "status": "pending", "owner": "pendiente de asignar" }
{ "toolId": "run_msa_analysis",  "kind": "federated", "status": "pending", "owner": "pendiente de asignar" }
```

Sin `subdomain` → `healthUrl: null` → el dashboard las muestra como
**"sin desplegar"**, sin importar qué tan sano esté el servicio. Las que sí
aparecen en línea (`cpa`, `rdp`, `af`, `nc`, `specs`…) tienen `subdomain`
declarado y su `https://<subdomain>.orcalabs.mx/health` responde 200.

Además, `ccp.orcalabs.mx` y `rma.orcalabs.mx` resuelven con certificado válido
pero devuelven el 404 de Railway ("The train has not arrived at the station"):
el dominio existe en Railway pero **no está atado a ningún servicio**.

Y había un problema de fondo, independiente del dashboard: la versión anterior
de estas tools no hablaba el idioma de la plataforma (otro formato de evento,
y esperaba que la llamaran en vez de consultar). Eso es lo que este repo
corrige; ver `docs/CONTRATO.md`.

---

## 1. Lo que hay que pedirle al equipo de plataforma

| Qué | Para qué | Variable |
|---|---|---|
| **API key del core** con scopes `events:read` **y** `events:write` | Consultar la suscripción y publicar resultados | `ISOTOOLS_API_KEY` |
| **Token de proyecto** de Railway (uno por tool, NO de cuenta) | Que GitHub Actions despliegue | secreto `RAILWAY_TOKEN_CCP` / `RAILWAY_TOKEN_RMA` |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | SSO (puede esperar: sin ellos la tool corre abierta) | ídem |
| Autorizar los callbacks en el IdP — **los dos desde el primer día** | Login | `https://ccp.orcalabs.mx/auth/callback` + `http://localhost:8108/auth/callback` · `https://rma.orcalabs.mx/auth/callback` + `http://localhost:8109/auth/callback` |
| Atar `ccp.orcalabs.mx` / `rma.orcalabs.mx` a cada servicio | Que el dashboard pueda sondear | — |
| Aprobar el registro en `deployments.json` | Que el dashboard las muestre en línea | ver `docs/REGISTRO-PLATAFORMA.md` |

Una llave con solo `events:read` lee bien y falla cada publicación con 403.
La pestaña **Integración** de la tool lo dice explícitamente si pasa.

### `401 {"error":"Invalid API key"}` — diagnóstico (2026-10-13)

El código está bien: con una llave activa, `GET /events/latest` y
`GET /events/subscriptions/calculate_cpk_ppk` (y `run_msa_analysis`) responden
200 con este mismo cliente y la misma cabecera `x-api-key`.
`https://api-events.orcalabs.mx/api/v1` e
`https://isotools-production.up.railway.app/api/v1` son el mismo core; cualquiera
sirve. El 401 significa que **la llave no está dada de alta en el core**:

- El core busca `sha256(x-api-key)` en su tabla `api_keys`
  (`src/middleware/apiKeyAuth.js`); si no hay fila activa, 401. La da de alta el
  admin de plataforma (Carlos) contra la base de producción:
  `npm run apikey:create -- ajtool --scopes=events:read,events:write`, y entrega
  la llave (se muestra una sola vez). Una llave inventada o copiada de otro
  entorno no sirve.
- Una sola llave sirve para ambas tools: el permiso es por scope
  (`events:read` / `events:write`), no por tool.
- Al activarla, la pestaña Integración debe pasar de `state: error` a
  `state: idle` con `lastSuccessAt` reciente. No cambies `CORE_PUBLISH` a `live`
  hasta registrar el subdominio (§5).

### Dominios `ccp` / `rma`

El core ya declara `subdomain: ccp` / `rma` (commit `7d12d3f` del core), así que
el dashboard sondea `https://ccp.orcalabs.mx/health` y `https://rma.orcalabs.mx/health`.
Al 2026-10-16 fallan: `ccp` responde el 404 de Railway
(`x-railway-fallback: true`, "Application not found") y `rma` da error de
certificado. Los servicios sí responden 200 en su `*.up.railway.app`: el dominio
**no está agregado al servicio**.

1. Dueño del proyecto Railway: Settings → Networking → Custom Domain →
   `ccp.orcalabs.mx` (o `rma`). Railway muestra un CNAME (y a veces un TXT de
   verificación).
2. Admin del DNS: poner exactamente esos registros. Si el DNS está en
   Cloudflare con proxy, SSL/TLS en **Full** (no Flexible).
3. Verificar: `curl https://ccp.orcalabs.mx/health` → 200.

**Ojo:** con el `subdomain` declarado, el core ya **delega** estos eventos y
dejó de correr su handler de respaldo. Mientras el poller siga con 401 y
`CORE_PUBLISH=shadow`, nadie procesa `MEASUREMENTS_CAPTURED` ni
`NEW_DEVICE_REGISTERED`.

---

## 2. Railway: un proyecto por tool

Regla de la plataforma (`despliegue/README.md`): **un proyecto Railway por
tool**, todos en el mismo workspace. En cada uno:

**Settings → Source / Build**

- **Root Directory: VACÍO** (raíz del repo). Los Dockerfiles copian desde la
  raíz; si apunta a `tools/<tool>` el build falla. *Esto cambió respecto a la
  configuración anterior.*
- Builder: Dockerfile (lo fija `railway.toml`).

**Variables** (por proyecto)

| Variable | `calculate_cpk_ppk` | `run_msa_analysis` |
|---|---|---|
| `RAILWAY_DOCKERFILE_PATH` | `docker/calculate_cpk_ppk.Dockerfile` | `docker/run_msa_analysis.Dockerfile` |
| `ISOTOOLS_API_URL` | `https://isotools-production.up.railway.app/api/v1` | ídem |
| `ISOTOOLS_API_KEY` | la llave del core | la llave del core |
| `CORE_PUBLISH` | `shadow` (ver §5) | `shadow` |
| `DATABASE_URL` | la inyecta Railway al adjuntar Postgres | ídem |
| `SESSION_SECRET` | `openssl rand -hex 32` (uno por tool) | otro distinto |
| `VITE_DASHBOARD_URL` | URL del dashboard (flecha "volver") | ídem |
| `OIDC_*` | cuando plataforma los entregue | ídem |

**No pongas `PORT`.** Railway lo inyecta y el servicio lo lee.

**No pongas `TOOL_API_KEY` mientras no haya OIDC.** Con esa llave puesta y sin
SSO, el navegador ya no puede entrar (solo servicios con la llave). La interfaz
lo explica si ocurre.

**Base de datos:** New → Database → Add PostgreSQL en cada proyecto. Las tablas
se crean solas. Sin base de datos la tool funciona, pero el cursor y los
estudios viven en memoria y se pierden al reiniciar — `/ready` y la pestaña
Integración lo dicen.

**Networking → Custom Domain:** `ccp.orcalabs.mx` en el de Cpk,
`rma.orcalabs.mx` en el de MSA. Railway da un CNAME; quien administra el DNS lo
apunta. El TLS lo emite Railway.

---

## 3. GitHub: despliegue automático

`.github/workflows/deploy-railway.yml` es la plantilla multi-tool del core con
el bloque `TOOLS` editado y una compuerta de pruebas: **nada se despliega si
las pruebas de backend o el build del frontend fallan.**

1. Settings → Secrets and variables → Actions:
   `RAILWAY_TOKEN_CCP` y `RAILWAY_TOKEN_RMA` (tokens **de proyecto**).
2. Confirma que `service` en el bloque `TOOLS` es el nombre exacto del servicio
   dentro de cada proyecto Railway (hoy dice `calculate_cpk_ppk` y
   `run_msa_analysis`, los nombres que se usaron antes).
3. El último paso espera `200` en `health`. Mientras los dominios no estén
   atados, pon ahí la URL `*.up.railway.app` de cada servicio o el job saldrá
   en rojo (correctamente: es el único paso que prueba que el despliegue sirvió).

> **Una sola vía de despliegue.** Si el proyecto también tiene conectada la
> integración de GitHub de Railway ("Connect Repo"), cada push despliega dos
> veces. El estándar es GitHub Actions + CLI: desconecta la otra.

---

## 4. Verificar el servicio (antes de tocar el registro)

```powershell
curl https://<url-del-servicio>/health      # 200 {"status":"ok"} sin credenciales
curl https://<url-del-servicio>/ready       # 200, persistence.tier = "postgres"
```

Luego abre la tool en el navegador → pestaña **Integración**. Debe decir:

- **Recepción: recibiendo**, con "última consulta hace segundos".
- **Core**: la URL del core, no "no configurado".
- **Persistencia: postgres**.
- **Publicación: sombra**.

Si dice **error de configuración** con `401`/`403`, el problema es la llave
del core (o le falta `events:write`). Si dice **reintentando**, el core no
responde. El detalle exacto aparece en pantalla.

Los **logs** viven en Railway → proyecto → Deployments → el deployment →
*Deploy Logs*. Las primeras líneas son el banner de arranque, que dice qué
versión corre, si el core está configurado, el modo de publicación y la
persistencia — sin exponer ninguna llave.

---

## 5. Registrar en la plataforma — el orden importa

En cuanto `deployments.json` del core declara el `subdomain` de una tool, el
bus **deja de ejecutar su handler de respaldo** y espera que el servicio real
procese los eventos por poll (`isHandledExternally()` en
`deploymentService.js`). Por eso:

1. **Antes de registrar:** §4 en verde. El servicio corre en `shadow`: consume
   eventos reales, calcula, guarda, y registra el evento exacto que *enviaría*
   — sin enviarlo, para no duplicar lo que el respaldo del core sigue
   publicando. Se puede revisar el resultado en la pestaña Estudios.
2. **En el mismo cambio:** se mergea el registro en `deployments.json` (PR
   listo en `docs/REGISTRO-PLATAFORMA.md`) **y** se cambia
   `CORE_PUBLISH=live` en Railway.
3. **Después:** el mosaico del dashboard pasa de gris a verde, y los eventos
   salen con `module.id` = la tool y `causation_id` = el evento que los causó.

Registrar con la tool apagada (o en `shadow`) deja la cadena ISO muda río
abajo: `manage_product_specs` dejaría de recibir `CAPABILITY_BELOW_TARGET` y
`calculate_control_charts` dejaría de recibir `MSA_VALIDATED`.

---

## 6. Síntomas y causas

| Síntoma | Causa | Arreglo |
|---|---|---|
| Mosaico gris "sin desplegar" | Sin `subdomain` en `deployments.json` | §5 |
| Mosaico rojo | El dominio no responde 200 en `/health` | Dominio atado al servicio, DNS, `/health` abierto |
| "The train has not arrived at the station" | Dominio en Railway sin servicio atado | Settings → Networking del servicio correcto |
| Build falla "no such file or directory" | Root Directory apunta a `tools/<tool>` | Root Directory vacío (§2) |
| Construye el Dockerfile equivocado | Falta `RAILWAY_DOCKERFILE_PATH` | §2 |
| Build verde, servicio caído | `PORT` fijado a mano | Quitar `PORT` de las variables |
| Integración: "error de configuración · 401" | Llave del core incorrecta | `ISOTOOLS_API_KEY` |
| Integración: "… 403" | La llave no tiene `events:write` | Pedir los scopes a plataforma |
| Estudios de Cpk "omitidos" | No hay `PRODUCT_SPEC_UPDATED` para esa característica | Lo publica `manage_product_specs`; la tool no inventa límites |
| La interfaz dice que exige credencial | `TOOL_API_KEY` puesta sin OIDC | Quitar `TOOL_API_KEY` hasta tener SSO |
| Nada se publica aunque hay estudios bajo objetivo | `CORE_PUBLISH=shadow` | Es lo correcto hasta el registro (§5) |
| Login: "Entro pero no tengo roles" | El IdP no libera el claim `roles` | Revisar `/auth/me`; es config del IdP |

---

## 7. Local

```powershell
cd tools\calculate-cpk-ppk
pnpm install
pnpm test                        # 60 pruebas (54 en MSA)
cd web; pnpm install; pnpm run build; cd ..
$env:UI_DIST_DIR = "web/dist"; pnpm start      # http://localhost:8108
```

O ambas tools con su Postgres, con las mismas imágenes que en producción:
`docker compose up --build`.
