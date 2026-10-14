# AJTool — tools de calidad federadas en ORCA

Dos tools de la plataforma ORCA (IsoTools), cada una con su propio servicio,
su propio subdominio y su propia interfaz:

| Tool | Cláusula ISO 9001:2015 | Consume | Publica | Subdominio |
|---|---|---|---|---|
| [`calculate_cpk_ppk`](tools/calculate-cpk-ppk/) — Calcular Cpk y Ppk | 9.1.3 | `MEASUREMENTS_CAPTURED` | `CAPABILITY_BELOW_TARGET` | `ccp.orcalabs.mx` |
| [`run_msa_analysis`](tools/run-msa-analysis/) — Análisis del sistema de medición | 7.1.5.2 | `NEW_DEVICE_REGISTERED` | `MSA_VALIDATED` | `rma.orcalabs.mx` |

Construidas siguiendo el proceso estandarizado del core
(`carcamfer/IsoTools` → `plantillas/integracion/`): SSO copiado de la
plantilla, un Dockerfile por tool con backend y frontend en una imagen, tema
**Control Room**, despliegue por GitHub Actions a un proyecto Railway por tool,
y registro en `deployments.json`.

## Cómo funcionan

```
                         core ORCA (/api/v1/events)
                 ┌──────────────────────────────────────┐
  otras tools ──▶│ log de eventos · bus · reglas · cadena│
                 └──────────────────────────────────────┘
                     ▲  poll /events/subscriptions/<toolId>
                     │  POST /events (resultado, encadenado a su causa)
                     │
       ┌─────────────┴─────────────┐
       │  tool federada (1 imagen)  │
       │  /        interfaz (SPA)   │◀── ingeniero de calidad (SSO)
       │  /api/*   API              │
       │  /auth/*  OIDC             │
       │  /health  /ready  abiertos │◀── sonda del dashboard
       └─────────────┬─────────────┘
                     │
                  Postgres (estudios, cursor, especificaciones)
```

Nadie llama a estas tools: cada una **consulta** su suscripción en el core,
calcula, guarda el estudio, y publica el resultado como evento hijo del que lo
causó. Lo que captura una persona en la interfaz queda guardado con su
identidad (tomada de la sesión, nunca del formulario).

## Documentación

- [`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md) — por qué salían offline, y el
  orden exacto para dejarlas en línea.
- [`docs/REGISTRO-PLATAFORMA.md`](docs/REGISTRO-PLATAFORMA.md) — el cambio a
  `deployments.json` del core, validado, y la prueba contra el core real.
- [`docs/CONTRATO.md`](docs/CONTRATO.md) — el contrato de eventos y qué cambió.
- [`docs/PREGUNTAS-ABIERTAS.md`](docs/PREGUNTAS-ABIERTAS.md) — lo que falta
  confirmar con el equipo de plataforma.
- [`db/schema.sql`](db/schema.sql) — qué se guarda.

## Estructura

```
tools/<tool>/
  src/server.js            arranque: HTTP + poller
  src/tool.js              el dominio de la tool en la plataforma
  src/domain/              cálculo puro (sin E/S), probado contra valores a mano
  src/platform/            integración: sobre IES, cliente del core, poller, persistencia, HTTP
  src/platform/auth/       plantilla SSO del core, copiada tal cual
  test/                    node --test
  web/                     interfaz React (tema Control Room), su propio toolchain
docker/<tool>.Dockerfile   imagen única back + front (plantilla del core)
railway.toml               config de despliegue compartida
.github/workflows/         pruebas + despliegue a Railway
archive/                   versión anterior de este repo, conservada como referencia
```

## Probar

```powershell
cd tools\calculate-cpk-ppk
pnpm install
pnpm test
```

Cada tool corre sin base de datos y sin core configurado (lo dice en su
pestaña Integración). Para ambas con Postgres y las mismas imágenes de
producción: `docker compose up --build`.
