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
| `GET /api/summary` | credencial | conteo por urgencia y «qué atender primero» |
| `GET /api/settings` | credencial | criterios vigentes, límites, versión e historial |
| `POST /api/settings/preview` | rol de calidad | vista previa: cambios, desviaciones de la referencia e impacto (no escribe) |
| `PUT /api/settings` | rol de calidad | aplicar un cambio de criterios: exige `confirm: true`, la versión vista y un motivo |
| `POST /api/invoke` | credencial | calcular un evento IES sin guardar ni publicar |
| `/` | sesión (si hay SSO) | interfaz |

```powershell
pnpm install
pnpm test                         # 60 pruebas: cálculo, criterios, prioridad, contrato, poller, HTTP
cd web; pnpm install; pnpm run build; cd ..
$env:UI_DIST_DIR = "web/dist"; pnpm start      # http://localhost:8108
```

Variables: [`.env.example`](.env.example) · Despliegue: [`docs/DESPLIEGUE.md`](../../docs/DESPLIEGUE.md)

## Criterios de aceptación editables

Los umbrales que deciden «capaz / aceptable» se pueden ajustar desde la pestaña
**Criterios**, y el cambio es deliberadamente de dos pasos: primero una vista
previa (qué cambia, qué se aparta de la referencia, qué habría significado para
los estudios ya registrados) y después una confirmación con motivo. El servidor
rechaza (428) cualquier cambio sin `confirm: true`, y cada cambio queda en el
historial con quién, cuándo, por qué y antes/después.

Los cambios aplican solo a estudios **nuevos**: cada estudio guarda los criterios
con los que se evaluó, y el evento publicado a la plataforma los lleva dentro.
