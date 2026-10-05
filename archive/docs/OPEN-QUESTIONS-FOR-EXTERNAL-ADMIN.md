# Preguntas abiertas para el equipo de la plataforma

Documento de trabajo para la siguiente sesión con el equipo de
plataforma (ORCA). Está escrito para alguien que **conoce la plataforma
pero no conoce el código de estas tools** — por eso empieza con un
resumen de qué son, y cada pregunta explica qué desbloquea.

---

## 1. Qué son estas tools, en ocho líneas

Dos herramientas de calidad independientes, cada una con su propio dueño
y su propio servicio HTTP. No se llaman entre sí: se comunican por
eventos con un contrato fijo.

- **`calculate_cpk_ppk`** — recibe mediciones de una característica y
  calcula capacidad de proceso (Cp, Cpk). Entrada oficial
  `MEASUREMENTS_CAPTURED`, salida oficial `CAPABILITY_BELOW_TARGET`.
- **`run_msa_analysis`** — recibe observaciones repetidas por pieza,
  operador y ensayo, y calcula Gage R&R y NDC para decir si el sistema
  de medición es confiable. Entrada oficial `NEW_DEVICE_REGISTERED`,
  salida oficial `MSA_VALIDATED`.

Cada una expone `GET /health` (abierto), `POST /events` (la llamada
real, con el evento completo en el body) y `GET /reports` (historial).
`POST /events` y `/reports` exigen el header `x-api-key` cuando la
variable `INBOUND_API_KEY` está configurada.

Si al evento le faltan datos, la tool **no inventa un resultado**:
responde `422` con el detalle exacto de qué falta. Eso es deliberado —
un resultado de capacidad calculado sobre datos incompletos es peor que
ningún resultado.

---

## 2. Las cinco que más desbloquean

Si solo hay tiempo para cinco, son estas.

1. **¿Nos pueden pasar un ejemplo real del JSON que la plataforma
   envía?** Aunque sea con datos ficticios. Hoy validamos contra un
   contrato que definimos nosotros; si la forma real difiere en un
   nombre de campo, todas las llamadas se rechazan con `422` y desde
   afuera parece que la tool está rota.
2. **¿La plataforma llama directo a `POST /events` de cada tool, o pasa
   por un broker intermedio?** Construimos las dos rutas y nunca se
   confirmó cuál es la real. Saberlo decide qué mantenemos y qué se
   retira.
3. **¿Me pueden dar acceso de lectura al proyecto de Railway?** Todo el
   diagnóstico se ha hecho por capturas de pantalla de terceros. Con
   acceso a los Deploy Logs, la mayoría de estas idas y vueltas
   desaparecen.
4. **¿Qué hace la plataforma con nuestra respuesta?** Devolvemos
   `{ ok, status, result, emittedEvents, recommendation }`. ¿Leen los
   eventos de ahí, o esperan que nosotros los publiquemos a otro lado?
5. **`MSA_NOT_ACCEPTABLE` — ¿lo hacemos oficial?** Hoy lo emitimos
   marcado como *no oficial* porque nunca se confirmó. Es justamente el
   caso que debería disparar una no conformidad, así que es raro que sea
   el único sin estatus.

---

## 3. Cómo nos llaman (lo que no podemos ver desde nuestro lado)

- ¿Cuál es la forma exacta del sobre del evento: `{ type, source,
  payload, correlationId }` u otra? ¿Los nombres de evento van en
  mayúsculas con guion bajo, como los usamos hoy?
- ¿Qué códigos de respuesta tratan como reintentables? Importa porque
  devolvemos `422` cuando faltan datos — ese error **no** se arregla
  reintentando, y un reintento infinito sobre un `422` genera ruido sin
  resolver nada.
- ¿Cuál es el timeout del lado de ustedes? Los cálculos son de
  milisegundos, pero necesitamos saber el presupuesto.
- ¿Nos llaman por la red privada de Railway (`*.railway.internal`) o por
  la URL pública? Cambia si el dominio público es siquiera necesario, y
  cambia la configuración de TLS.
- ¿Mandan un `correlationId` propio? Lo guardamos para poder trazar una
  cadena completa de eventos, pero solo sirve si viene del origen.

## 4. Contexto de producto (para priorizar bien)

- ¿Quién dispara la tool: un ingeniero de calidad desde la interfaz, o
  un flujo automático de la plataforma?
- ¿Dónde aparece el resultado dentro de la plataforma? ¿Se muestra el
  veredicto y la recomendación, o solo se guarda?
- ¿Qué sistema consume `CAPABILITY_BELOW_TARGET` y `MSA_VALIDATED`
  después de nosotros? Saber quién está río abajo nos dice qué campos
  del payload realmente importan.
- ¿Hay volumen esperado? Diez análisis al día y diez mil se diseñan
  distinto.

## 5. Contrato pendiente de confirmar

- `MSA_NOT_ACCEPTABLE` — hoy **no oficial**. ¿Se vuelve oficial?
- El caso "capable" de Cpk no tiene evento oficial de salida; solo el
  caso below-target lo tiene. ¿Debería existir uno para el proceso que
  sí cumple?
- ¿Qué criterio de aceptación de MSA quieren como estándar? Hoy usamos
  Gage R&R ≤ 10% y NDC ≥ 5, que es lo convencional, pero es un parámetro
  de negocio, no técnico.
- ¿`CAPABILITY_BELOW_TARGET` debe crear una no conformidad
  automáticamente, o solo recomendar revisión?
- ¿Va a existir una URL base y una llave de salida para que nosotros
  publiquemos hacia la plataforma? El bus-proxy soporta ese modo pero
  nunca se han entregado credenciales, así que ha corrido siempre en
  modo local.

## 6. Operación y despliegue

- ¿Qué **Root Directory** quedó configurado en cada servicio? En este
  repo la raíz no tiene `package.json`; cada servicio tiene que apuntar
  a su subcarpeta (`tools/calculate-cpk-ppk` y `tools/run-msa-analysis`)
  o el build falla.
- ¿Se configuró un healthcheck path? `/health` responde siempre y sin
  llave, justo para eso.
- ¿Quién ata `ccp.orcalabs.mx` y `rma.orcalabs.mx` a los servicios? Hoy
  los dominios resuelven con certificado válido pero devuelven el 404 de
  Railway, que significa "dominio registrado, servicio no atado".
- ¿Confirmamos que la `INBOUND_API_KEY` configurada en el servicio es
  exactamente la misma que manda la plataforma? Una diferencia de un
  carácter produce `401` en todas las llamadas.
- La llave actual se compartió en texto plano por mensajería y en
  capturas. ¿Cuándo la rotamos?

## 7. Datos y auditoría

- ¿La plataforma ya guarda el historial de cada análisis, o el nuestro
  sería el único registro?
- Si agregamos Postgres: ¿en el proyecto de ustedes o en uno nuestro?
  Define quién es dueño del rastro de auditoría de calidad, que no es
  una decisión técnica sino de responsabilidad.
- ¿Hay requisito de retención? ¿Alguna restricción sobre guardar los
  valores de medición crudos?

---

## 8. Paso a paso de mejora, en orden de dependencia

Cada paso está ordenado por lo que desbloquea, no por dificultad.

**Ya está hecho:** suite de 36 pruebas automatizadas, historial en dos
niveles (memoria + Postgres opcional), CI que bloquea publicación si
las pruebas fallan, runbook de despliegue, panel de historial visible en
la interfaz de cada tool.

**Paso 1 — Recuperar visibilidad.** Acceso de lectura al proyecto de
Railway. Sin esto, cada diagnóstico cuesta un día de ida y vuelta. Es el
paso más barato y el que más desbloquea.

**Paso 2 — Confirmar la forma real de la llamada.** Con el JSON de
ejemplo (pregunta 1), verificar contra nuestra validación. Si hay
diferencia, ajustarla es cuestión de minutos; no saberlo es lo que
produce fallas que parecen caídas.

**Paso 3 — Observabilidad en el código.** Banner de arranque con la
configuración efectiva, endpoint `/version` con el commit desplegado, y
log estructurado por llamada. Esto responde sin ambigüedad "¿qué build
está corriendo?", que es la pregunta que más veces nos ha trabado. El
prompt de implementación ya está escrito en
`docs/PROMPT-OBSERVABILIDAD-Y-LIMPIEZA.md`.

**Paso 4 — Persistencia real.** Conectar Postgres donde se decida
(sección 7). El código ya está listo: crea sus tablas solo y degrada a
memoria si la base se cae.

**Paso 5 — Cerrar el contrato.** Con las respuestas de la sección 5,
volver oficiales los eventos que falten y actualizar
`docs/OFFICIAL-EXTERNAL-ADMIN-CONTRACT.md`. Hoy media lógica de las
tools emite eventos que nadie confirmó.

**Paso 6 — Cerrar la operación.** Atar los dominios, rotar la llave, y
decidir si el bus-proxy sigue vivo o se retira según la respuesta a la
pregunta 2.
