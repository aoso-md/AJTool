# calculate_cpk_ppk — Calcular Cpk y Ppk

Tool federada de la plataforma ORCA · ISO 9001:2015 **9.1.3** · `ccp.orcalabs.mx`

Consume `MEASUREMENTS_CAPTURED` por poll, toma los límites de
`PRODUCT_SPEC_UPDATED`, calcula Cp/Cpk (σ dentro) y Pp/Ppk (σ global) con ppm
esperado, y publica `CAPABILITY_BELOW_TARGET` cuando el Cpk queda bajo el
mínimo. Un ingeniero también puede capturar estudios en la interfaz y escalarlos
con su firma. Contrato completo: [`docs/CONTRATO.md`](../../docs/CONTRATO.md).

| Ruta | Acceso | Qué |
|---|---|---|
| `GET /health` | abierta | liveness (la sonda del dashboard) |
| `GET /ready` | abierta | persistencia, poller, modo de publicación |
| `GET /auth/me` | abierta | sesión (o modo abierto) |
| `GET /api/status` | credencial | configuración efectiva y estado de la suscripción |
| `GET /api/studies` · `/api/studies/:id` | credencial | estudios |
| `POST /api/studies` | rol de calidad | estudio manual |
| `POST /api/studies/:id/publish` | rol de calidad | escalar a especificaciones |
| `GET /api/specs` | credencial | especificaciones conocidas |
| `POST /api/invoke` | credencial | calcular un evento IES sin guardar ni publicar |
| `/` | sesión (si hay SSO) | interfaz |

```powershell
pnpm install
pnpm test                         # 40 pruebas: cálculo, contrato, poller, HTTP
cd web; pnpm install; pnpm run build; cd ..
$env:UI_DIST_DIR = "web/dist"; pnpm start      # http://localhost:8108
```

Variables: [`.env.example`](.env.example) · Despliegue: [`docs/DESPLIEGUE.md`](../../docs/DESPLIEGUE.md)
