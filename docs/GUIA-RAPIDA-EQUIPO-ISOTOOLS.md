# Quality Tools Workspace — guía rápida para el equipo

Para Carlos, programadores de IsoTools, Joaquín y Angel. Explicación
simple de qué es esto, cómo funciona, y cómo probarlo tú mismo.

## Qué es, en una frase

Dos herramientas de calidad (Cpk/Ppk y MSA) que viven separadas, pero se
conectan entre sí y con el resto del ecosistema de Carlos mandándose
"mensajes estándar" en vez de llamarse directamente entre código.

La regla de oro: **cada tool es dueña de su propia lógica — se conectan
solo por contrato, nunca por llamada directa.**

## Definiciones rápidas

- **Cpk / Cp**: qué tan bien un proceso de manufactura se mantiene dentro
  de los límites que pide el cliente. Cpk ≥ 1.33 = proceso capaz.
- **MSA / Gage R&R**: si el instrumento de medición (y quien lo usa) es
  confiable. Gage R&R ≤ 10% = sistema de medición aceptable.
- **Evento**: un mensaje estándar que una tool manda cuando pasa algo
  (ej. "ya tengo mediciones nuevas"). Trae un `type` (tipo) y un `payload`
  (los datos).
- **Contrato**: la lista de campos que un evento debe traer para ser
  válido. Si faltan, la tool no inventa un resultado — se detiene y avisa.
- **Bus de eventos**: el "cartero" que reparte los eventos entre tools.
  Nadie llama directo a nadie, todos publican y consumen del mismo bus.
- **Oficial vs. propuesto**: "oficial" significa que Carlos ya confirmó
  ese evento como parte real del contrato. "Propuesto" significa que la
  tool lo usa localmente, pero todavía no está confirmado — se etiqueta
  así en todos lados para no fingir que ya es definitivo.

## Cómo funciona, paso a paso

1. Una tool productora (ej. `collect_quality_measurements`) publica un
   evento — por ejemplo `MEASUREMENTS_CAPTURED` con las mediciones.
2. El evento llega al bus / ledger (hoy: un servicio real corriendo en
   Railway, con un ledger en memoria; a futuro, PostgreSQL).
3. La tool consumidora (ej. `calculate_cpk_ppk`) revisa si el evento
   cumple su contrato — si faltan datos, se detiene ahí mismo.
4. Si el contrato se cumple, la tool corre su cálculo real (Cpk, Gage
   R&R, lo que sea).
5. La tool emite un evento de salida con el resultado (ej.
   `CAPABILITY_BELOW_TARGET`).
6. Ese evento queda registrado, y cualquier otra tool interesada
   (`audit_report`, `manage_nonconformances`, etc.) lo podría consumir
   después.

## Las dos tools de hoy

**`calculate_cpk_ppk`** (Angel) — consume `MEASUREMENTS_CAPTURED`,
produce oficialmente `CAPABILITY_BELOW_TARGET`.

**`run_msa_analysis`** (Joaquín) — consume `NEW_DEVICE_REGISTERED`,
produce oficialmente `MSA_VALIDATED`.

Ambos contratos ya los confirmó Carlos. Todo lo demás que las tools
aceptan o emiten es propuesto, no oficial todavía.

## Qué es real y qué es simulado (sin adornos)

- **Real**: la lógica de cálculo de ambas tools, la validación de
  contratos, el bus de eventos corriendo en Railway, el registro de cada
  evento.
- **Simulado / demo**: el ledger vive en memoria (no hay PostgreSQL
  todavía), y el bus de Railway todavía no está conectado a la API real
  de IsoTools — corre en modo local hasta que Carlos confirme URL y
  credenciales.
- **Futuro, no construido**: MARLI. Aparece en la consola como referencia
  de hacia dónde podría ir esto, pero no hay código de MARLI hoy.

## Cómo probarlo tú mismo

1. Abre `workspace/ui/index.html` (doble clic, no necesita servidor).
2. Elige un ejemplo en "Load Example Event" y dale **Run Tool**.
3. Mira el flujo de 8 pasos correr, el resultado calcularse, y el evento
   quedar en el Event Ledger de abajo.
4. Arriba, "Event Bus" muestra si estás conectado al proxy real en
   Railway.

Para programadores: el código fuente de cada tool está en
`tools/<nombre>/src/handler.js` — se puede correr directo con Node,
sin la consola:

```bash
node tools/calculate-cpk-ppk/src/handler.js tools/calculate-cpk-ppk/demo/capable-case.json
```

## Lo que falta confirmar con Carlos

- ¿`MSA_NOT_ACCEPTABLE` debería ser un evento oficial (hoy no lo es)?
- ¿El caso "capable" de Cpk debería tener también un evento oficial de
  salida (hoy solo `CAPABILITY_BELOW_TARGET` lo es)?
- URL y API key reales de la plataforma de IsoTools, para pasar el bus de
  Railway de modo "local" a modo "conectado".
