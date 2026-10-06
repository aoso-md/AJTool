# run_msa_analysis — Ejecutar Análisis de Sistema de Medición (MSA)

Tool federada de la plataforma ORCA · ISO 9001:2015 **7.1.5.2** · `rma.orcalabs.mx`

Consume `NEW_DEVICE_REGISTERED` por poll y abre un estudio Gage R&R pendiente
para cada equipo registrado. Un ingeniero captura las lecturas en la interfaz
(cuadrícula piezas × operador · ensayo, admite pegar desde Excel); al guardar,
calcula con el método AIAG de promedios y rangos y publica `MSA_VALIDATED` con
el veredicto, encadenado al registro del equipo. Contrato completo:
[`docs/CONTRATO.md`](../../docs/CONTRATO.md).

| Ruta | Acceso | Qué |
|---|---|---|
| `GET /health` | abierta | liveness (la sonda del dashboard) |
| `GET /ready` | abierta | persistencia, poller, modo de publicación |
| `GET /auth/me` | abierta | sesión (o modo abierto) |
| `GET /api/status` | credencial | configuración efectiva y estado de la suscripción |
| `GET /api/studies[?status=pending]` · `/api/studies/:id` | credencial | estudios |
| `POST /api/studies/:id/capture` | rol de calidad | capturar el estudio de un equipo registrado (publica) |
| `POST /api/studies` | rol de calidad | estudio sin registro (se guarda) |
| `POST /api/studies/:id/publish` | rol de calidad | publicar / reintentar |
| `GET /api/summary` | credencial | conteo por urgencia, equipos pendientes y «qué atender primero» |
| `GET /api/settings` | credencial | criterios vigentes, límites, versión e historial |
| `POST /api/settings/preview` | rol de calidad | vista previa: cambios, desviaciones de AIAG e impacto (no escribe) |
| `PUT /api/settings` | rol de calidad | aplicar un cambio de criterios: exige `confirm: true`, la versión vista y un motivo |
| `POST /api/invoke` | credencial | calcular sin guardar ni publicar |
| `/` | sesión (si hay SSO) | interfaz |

```powershell
pnpm install
pnpm test                         # 54 pruebas: cálculo AIAG, criterios, prioridad, contrato, poller, HTTP
cd web; pnpm install; pnpm run build; cd ..
$env:UI_DIST_DIR = "web/dist"; pnpm start      # http://localhost:8109
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
