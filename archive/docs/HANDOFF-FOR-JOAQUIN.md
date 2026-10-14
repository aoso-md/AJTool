# Handoff for Joaquín — run-msa-analysis + Quality Tools Workspace

Estado del repo al día de hoy. Tu tool (`run-msa-analysis`) sigue siendo
100% tuya — nada de esto cambia tu lógica, solo te doy cómo correrla,
probarla y verla en la consola compartida.

## 1. Correr y probar tu tool directo (sin UI)

```bash
node --check tools/run-msa-analysis/src/handler.js

node tools/run-msa-analysis/src/handler.js tools/run-msa-analysis/demo/acceptable-case.json
node tools/run-msa-analysis/src/handler.js tools/run-msa-analysis/demo/not-acceptable-case.json
node tools/run-msa-analysis/src/handler.js tools/run-msa-analysis/demo/incomplete-device-case.json
```

Esto corre tu `handler.js` real, sin nada de por medio. Resultados que
deberías ver (ya verificados):

- `acceptable-case.json` → `gageRRPercent: 1.5568`, `ndc: 119`, verdict `acceptable`, emite `MSA_VALIDATED`.
- `not-acceptable-case.json` → `gageRRPercent: 119.508`, `ndc: 0`, verdict `not-acceptable`, emite `MSA_NOT_ACCEPTABLE`.
- `incomplete-device-case.json` → sin `observations`, responde `status: "warning"`, no inventa análisis.

## 2. Contrato oficial confirmado por [EXTERNAL_ADMIN] (tu tool)

- **Input oficial**: `NEW_DEVICE_REGISTERED` → **Output oficial**: `MSA_VALIDATED`.
- Todo lo demás que tu handler acepta o emite (`MSA_STUDY_REQUESTED` como
  input, `MSA_ANALYSIS_COMPLETED` y `MSA_NOT_ACCEPTABLE` como output) es
  **propuesto / no oficial** — sigue funcionando local, pero está marcado
  como tal en el código (`official: true/false` en cada evento emitido) y
  en toda la UI. Detalle completo: `docs/OFFICIAL-EXTERNAL-ADMIN-CONTRACT.md`.
- Ojo con esto: `MSA_NOT_ACCEPTABLE` — el caso que más importa para
  enrutar a nonconformance — todavía **no** es oficial. Vale la pena que
  lo confirmes con [EXTERNAL_ADMIN].

## 3. Ver tu tool corriendo en la consola compartida

Doble clic en `workspace/ui/index.html` (no necesita servidor).

1. Modo **External Tool Event** (el que abre por default).
2. En "Load Example Event" hay 3 tarjetas de tu tool: *Acceptable MSA
   study*, *MSA not acceptable*, *Incomplete device registration*. Clic en
   cualquiera → **▶ Run Tool**.
3. Verás el timeline de 8 pasos correr, la tarjeta de tu dashboard
   (Gage R&R %, Repeatability, Reproducibility, ndc, verdict) llenarse, y
   los eventos emitidos con su badge (oficial o propuesto).
4. Cambia a modo **Manual Input** → tab *run-msa-analysis* para armar un
   `MSA_STUDY_REQUESTED` a mano, o *Device Registration* para
   `NEW_DEVICE_REGISTERED`.
5. Botón **⇄ Connect a Tool** arriba: ahí está la guía completa de campos
   requeridos para cualquier tool externa que te quiera mandar datos.

Tu lógica no vive en la UI — `app.js` solo tiene una copia portada 1:1 de
tu `handler.js` (mismo cálculo, mismas validaciones). Si tocas tu handler,
avísame para mantener la copia sincronizada, o dime y lo dejamos como
tarea pendiente.

## 4. El bus de eventos ahora es real (no solo mock)

Nuevo: `bus-proxy/server.js` — un proceso Node aparte (sin dependencias)
que expone el contrato real que pide [EXTERNAL_ADMIN]: `POST /events`,
`GET /events/subscriptions/:toolId`, `GET /events/chain/:correlationId`.

```bash
node bus-proxy/server.js
```

Corre en modo `LOCAL` (en memoria, en tu máquina) hasta que se le pongan
las credenciales reales de [EXTERNAL_ADMIN] en `bus-proxy/.env` (copia
`bus-proxy/.env.example`, nunca se commitea). Con el proxy corriendo, la
pastilla "Event Bus" en la UI cambia sola de `MOCK` a `LIVE (LOCAL
PROXY)`, y cada corrida en la consola también publica el evento ahí.
Detalle completo: `bus-proxy/README.md`.

Tu `toolId` oficial para consultar el bus es `run_msa_analysis` (no
`run-msa-analysis` — ese es solo el nombre de carpeta):

```powershell
Invoke-RestMethod http://localhost:8787/events/subscriptions/run_msa_analysis
```

## 5. Pendientes que dependen de [EXTERNAL_ADMIN] (los tuyos)

De `docs/OPEN-QUESTIONS-FOR-EXTERNAL-ADMIN.md` y `docs/OFFICIAL-EXTERNAL-ADMIN-CONTRACT.md`:

- ¿`MSA_NOT_ACCEPTABLE` debería ser oficial y disparar
  `manage_nonconformances` automáticamente?
- ¿Cuál es el criterio exacto de "aceptable" que [EXTERNAL_ADMIN] quiere (hoy el
  handler usa Gage R&R ≤ 10% y ndc ≥ 5 — estándar típico, pero no
  confirmado por él)?
- ¿`NEW_DEVICE_REGISTERED` sin observations debería disparar
  automáticamente un `MSA_STUDY_REQUESTED`, o se queda como warning
  manual (comportamiento actual)?

## 6. Qué NO toqué de tu lado

No modifiqué `tools/run-msa-analysis/src/handler.js` más allá de lo que ya
estaba en progreso (agregar el flag `official` a cada evento emitido — ya
estaba escrito, solo lo dejé consistente con `README.md` y la UI). Tu
lógica de cálculo (Gage R&R, repeatability, reproducibility, ndc) está
intacta.
