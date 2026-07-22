"use strict";

/* =====================================================================
   Quality Tools Workspace — Operations Console v0.3
   ---------------------------------------------------------------------
   REAL (implemented):
     - Handler logic ported 1:1 from tools/calculate-cpk-ppk/src/handler.js
       and tools/run-msa-analysis/src/handler.js (same validation, same math,
       same emitted events).
     - Live contract checking while you edit the input JSON or forms.
     - Correlation / causation ID generation and propagation.
   DEMO DATA:
     - Scenario events (mirror tools/<tool>/demo/*.json).
     - Ledger seed rows. Ledger is in-memory; the column structure is
       PostgreSQL-ready but no database is connected.
   MOCK:
     - Event bus transport (in-process function call).
   FUTURE ADAPTER:
     - MARLI. Not implemented in current tool code.
   ===================================================================== */

/* ============================ i18n ============================ */
const I18N = {
  en: {
    modeExternal: "External Tool Event", modeManual: "Manual Input", modeRaw: "Raw JSON Event",
    toolRegistry: "Tool Registry", legend: "Badge Legend",
    flowTitle: "Event Flow",
    ribbon: ["Producer Tool", "Published Event", "Event Broker / Ledger", "Consuming Tool",
             "Contract Validation", "Handler Execution", "Output Event", "Downstream Consumers"],
    s1Title: "Input Source — connect a tool, build one, or paste raw JSON",
    s1Sub: "An external tool event, a manual form, or a raw event envelope. Same contract, same pipeline.",
    editorLabel: "Incoming event · editable JSON",
    editorHint: "Edit any field — the compatibility check below updates live.",
    rawEditorLabel: "Full event envelope · editable JSON",
    payloadLabel: "Payload JSON",
    loadExampleLabel: "Load Example Event",
    fTargetTool: "Target Tool", fEventType: "Event Type", fOwner: "Owner / Team",
    btnValidate: "Validate Event", btnResetPayload: "Reset Payload", btnLoadExample: "Load Example",
    validateOk: "Valid JSON.", validateBad: "Invalid JSON — see hint below.",
    s2Title: "Compatibility Check — is this event consumable?",
    s2Sub: "Selected event vs. the target tool's contract. This is the boundary between tools.",
    reqData: "Required fields", missingFieldsLabel: "Missing fields", emptyContract: "Load an example, fill a form, or paste an event.",
    cmpSelectedEvent: "Selected event", cmpTargetTool: "Target tool", cmpConsumable: "Consumable by this tool?",
    cmpYes: "Yes", cmpNo: "No",
    cmpCompatible: "COMPATIBLE", cmpMissingData: "MISSING DATA", cmpNotConsumable: "NOT CONSUMABLE", cmpNeedsConfirm: "NEEDS CARLOS CONFIRMATION",
    notConsumableMsg: "Event not directly consumable by selected tool. Adapter or mapping needed.",
    deviceCompatWarn: "Device registration is compatible as a trigger, but formal MSA requires MSA_STUDY_REQUESTED with repeated observations.",
    s3Title: "Execution — the handler runs",
    s3Sub: "Same logic as tools/<tool>/src/handler.js, ported 1:1 into this console.",
    btnRunExternal: "▶ Run Tool", btnRunManual: "▶ Run Manual Input", btnRunRaw: "▶ Run Tool", btnReset: "Reset",
    s4Title: "Output — where the result goes",
    s4Sub: "Emitted events, and the downstream tools that could consume them.",
    emptyResult: "No execution yet. Run a scenario to see the handler result here.",
    emptyEmit: "Nothing emitted yet.",
    emittedRouting: "Emitted events → downstream routing",
    awaiting: "AWAITING RUN", noRun: "No analysis executed in this session.",
    inspector: "Inspector",
    hIncoming: "Incoming Event", hPayload: "Payload", hRequired: "Required Data", hMissing: "Missing Data",
    hResult: "Handler Result", hEmitted: "Emitted Events", hJson: "Technical JSON", hEvidence: "Contract Evidence",
    emptyInsp: "Run a scenario to inspect the pipeline.",
    ledgerTitle: "Event Ledger",
    ledgerBadge: "DEMO LEDGER — POSTGRESQL-READY STRUCTURE",
    ledgerNote: "in-memory demo data, schema ready for PostgreSQL",
    formalStudy: "Formal MSA Study", deviceCompat: "Device Registration",
    manualCpkTitle: "Manual Input — build MEASUREMENTS_CAPTURED",
    manualMsaTitle: "Manual Input — build MSA_STUDY_REQUESTED",
    manualDevTitle: "Manual Input — build NEW_DEVICE_REGISTERED",
    fSetId: "Measurement Set ID", fPart: "Part Number", fChar: "Characteristic",
    fMeas: "Measurements", hMeas: "Comma-separated numeric values (min. 2).",
    fTarget: "Target", fMinCpk: "Minimum Cpk", fSource: "Source Tool", fTolerance: "Tolerance",
    hTolerance: "Optional — informational only, not yet enforced by the real handler.",
    hCorr: "Leave empty to auto-generate.",
    fObs: "Observations JSON",
    hObs: "Array of { partId, operatorId, trial, value } — same shape the real handler consumes.",
    fDevType: "Device Type", fCalStatus: "Calibration Status", fRegBy: "Registered By", fRegDate: "Registration Date",
    devNote: "No observations on this path — the handler will answer with a warning and recommend MSA_STUDY_REQUESTED. That is correct behavior, not an error.",
    marliBadge: "FUTURE ADAPTER — NOT IMPLEMENTED IN CURRENT TOOL CODE",
    marliNote: "Planned consumer of CAPABILITY_BELOW_TARGET and MSA_NOT_ACCEPTABLE. No code exists for this adapter today.",
    m1: "Technical Event", m2: "Skill Gap", m3: "Microtraining", m4: "Evaluation",
    m5: "Supervisor Review", m6: "Readiness", m7: "Evidence",
    bLogicReal: "HANDLER LOGIC · IMPLEMENTED",
    consumes: "Consumes", produces: "Produces", upstream: "Upstream producers", downstream: "Downstream consumers",
    btnConnect: "⇄  Connect a Tool",
    navInput: "1 · Input", navContract: "2 · Contract", navExec: "3 · Execution", navOutput: "4 · Output",
    navDash: "Dashboards", navMarli: "MARLI",
    connectTitle: "Connect a Tool",
    connectSub: "Any producer — a real MES, a manual form, a future system, or Carlos' own tools — connects the same way: emit an event shaped like the contract below. No direct coupling, ever.",
    cgRequired: "Required payload fields", cgExample: "Example payload — real, matches a demo fixture",
    cgSteps: "How any tool connects", cgCopy: "Copy JSON", cgCopied: "Copied!", cgLoad: "Load into Raw JSON Editor & Test",
    cgSchema: "Schema", cgTarget: "Target tool",
    ts: ["Event received", "Payload loaded", "Contract validated", "Handler executed",
         "Result produced", "Events emitted", "Ledger updated", "Downstream routing evaluated"],
    stPending: "PENDING", stRunning: "RUNNING", stOk: "OK", stFail: "FAILED", stWarn: "WARNING", stSkip: "SKIPPED",
    runIdle: "IDLE", runRunning: "RUNNING", runSuccess: "SUCCESS", runCritical: "CRITICAL",
    runWarning: "WARNING", runVError: "VALIDATION ERROR",
    verdictCapable: "Capable", verdictBelow: "Below Target", verdictAcceptable: "Acceptable",
    verdictNotAcceptable: "Not Acceptable", verdictWarning: "Warning", verdictVError: "Validation Error",
    mean: "Mean", stddev: "Std Dev", sample: "Sample Size", verdict: "Verdict",
    grr: "Gage R&R %", repeat: "Repeatability", repro: "Reproducibility",
    contractOk: "CONTRACT SATISFIED", contractFail: "CONTRACT NOT SATISFIED — handler will stop with validation-error",
    contractWarn: "COMPATIBILITY PATH — handler will warn and recommend MSA_STUDY_REQUESTED",
    noneMissing: "None — contract satisfied.",
    execNoteExternal: "Runs the event built from Source Tool / Event Type / Target Tool / Payload above.",
    execNoteManual: "Builds the event from the form and runs the same pipeline.",
    execNoteRaw: "Runs the full envelope exactly as shown in the editor.",
    stoppedAt: "Stopped at contract validation. No result invented, no event emitted.",
    evidence: [
      ["ok", "handler logic: ported 1:1 from tools/*/src/handler.js — IMPLEMENTED"],
      ["ok", "contract check: real required-field validation — IMPLEMENTED"],
      ["ok", "correlationId / causationId: generated and propagated — IMPLEMENTED"],
      ["mk", "event bus transport: in-process call — MOCK"],
      ["mk", "ledger persistence: in-memory, PostgreSQL-ready columns — DEMO DATA"],
      ["mk", "downstream consumers: names from adapters/carlos-ecosystem — NEEDS CARLOS CONFIRMATION"]
    ]
  },
  es: {
    modeExternal: "Evento de Tool Externa", modeManual: "Entrada Manual", modeRaw: "Evento JSON Crudo",
    toolRegistry: "Registro de Tools", legend: "Leyenda de Badges",
    flowTitle: "Flujo de Eventos",
    ribbon: ["Tool Productora", "Evento Publicado", "Broker de Eventos / Ledger", "Tool Consumidora",
             "Validación de Contrato", "Ejecución del Handler", "Evento de Salida", "Consumidores Downstream"],
    s1Title: "Fuente de Input — conecta una tool, arma una, o pega JSON crudo",
    s1Sub: "Un evento de tool externa, un formulario manual, o un envelope de evento crudo. Mismo contrato, mismo pipeline.",
    editorLabel: "Evento entrante · JSON editable",
    editorHint: "Edita cualquier campo — el chequeo de compatibilidad se actualiza en vivo.",
    rawEditorLabel: "Envelope completo del evento · JSON editable",
    payloadLabel: "Payload JSON",
    loadExampleLabel: "Cargar Evento de Ejemplo",
    fTargetTool: "Tool Destino", fEventType: "Tipo de Evento", fOwner: "Owner / Equipo",
    btnValidate: "Validar Evento", btnResetPayload: "Reiniciar Payload", btnLoadExample: "Cargar Ejemplo",
    validateOk: "JSON válido.", validateBad: "JSON inválido — ver hint abajo.",
    s2Title: "Chequeo de Compatibilidad — ¿este evento es consumible?",
    s2Sub: "Evento seleccionado vs. el contrato de la tool destino. Esta es la frontera entre tools.",
    reqData: "Campos requeridos", missingFieldsLabel: "Campos faltantes", emptyContract: "Carga un ejemplo, llena un formulario, o pega un evento.",
    cmpSelectedEvent: "Evento seleccionado", cmpTargetTool: "Tool destino", cmpConsumable: "¿Consumible por esta tool?",
    cmpYes: "Sí", cmpNo: "No",
    cmpCompatible: "COMPATIBLE", cmpMissingData: "MISSING DATA", cmpNotConsumable: "NOT CONSUMABLE", cmpNeedsConfirm: "NEEDS CARLOS CONFIRMATION",
    notConsumableMsg: "Este evento no es consumible directamente por la tool seleccionada. Se necesita un adapter o mapping.",
    deviceCompatWarn: "El registro de equipo es compatible como trigger, pero un MSA formal requiere MSA_STUDY_REQUESTED con observations repetidas.",
    s3Title: "Ejecución — corre el handler",
    s3Sub: "La misma lógica de tools/<tool>/src/handler.js, portada 1:1 a esta consola.",
    btnRunExternal: "▶ Ejecutar Tool", btnRunManual: "▶ Ejecutar Entrada Manual", btnRunRaw: "▶ Ejecutar Tool", btnReset: "Reiniciar",
    s4Title: "Output — a dónde va el resultado",
    s4Sub: "Eventos emitidos y las tools downstream que podrían consumirlos.",
    emptyResult: "Sin ejecución aún. Corre un escenario para ver aquí el resultado del handler.",
    emptyEmit: "Nada emitido todavía.",
    emittedRouting: "Eventos emitidos → ruteo downstream",
    awaiting: "SIN EJECUTAR", noRun: "Ningún análisis ejecutado en esta sesión.",
    inspector: "Inspector",
    hIncoming: "Evento Entrante", hPayload: "Payload", hRequired: "Datos Requeridos", hMissing: "Datos Faltantes",
    hResult: "Resultado del Handler", hEmitted: "Eventos Emitidos", hJson: "JSON Técnico", hEvidence: "Evidencia de Contrato",
    emptyInsp: "Ejecuta un escenario para inspeccionar el pipeline.",
    ledgerTitle: "Ledger de Eventos",
    ledgerBadge: "LEDGER DEMO — ESTRUCTURA LISTA PARA POSTGRESQL",
    ledgerNote: "datos demo en memoria, esquema listo para PostgreSQL",
    formalStudy: "Estudio MSA Formal", deviceCompat: "Registro de Equipo",
    manualCpkTitle: "Entrada Manual — arma MEASUREMENTS_CAPTURED",
    manualMsaTitle: "Entrada Manual — arma MSA_STUDY_REQUESTED",
    manualDevTitle: "Entrada Manual — arma NEW_DEVICE_REGISTERED",
    fSetId: "ID de Set de Medición", fPart: "Número de Parte", fChar: "Característica",
    fMeas: "Mediciones", hMeas: "Valores numéricos separados por coma (mín. 2).",
    fTarget: "Target", fMinCpk: "Cpk Mínimo", fSource: "Tool de Origen", fTolerance: "Tolerancia",
    hTolerance: "Opcional — solo informativo, el handler real todavía no lo exige.",
    hCorr: "Déjalo vacío para autogenerar.",
    fObs: "JSON de Observaciones",
    hObs: "Array de { partId, operatorId, trial, value } — la misma forma que consume el handler real.",
    fDevType: "Tipo de Equipo", fCalStatus: "Estado de Calibración", fRegBy: "Registrado Por", fRegDate: "Fecha de Registro",
    devNote: "Esta vía no trae observations — el handler responderá con warning y recomendará MSA_STUDY_REQUESTED. Es el comportamiento correcto, no un error.",
    marliBadge: "ADAPTADOR FUTURO — NO IMPLEMENTADO EN EL CÓDIGO ACTUAL",
    marliNote: "Consumidor planeado de CAPABILITY_BELOW_TARGET y MSA_NOT_ACCEPTABLE. Hoy no existe código para este adaptador.",
    m1: "Evento Técnico", m2: "Brecha de Habilidad", m3: "Microcapacitación", m4: "Evaluación",
    m5: "Revisión del Supervisor", m6: "Readiness", m7: "Evidencia",
    bLogicReal: "LÓGICA DEL HANDLER · IMPLEMENTED",
    consumes: "Consume", produces: "Produce", upstream: "Productores upstream", downstream: "Consumidores downstream",
    btnConnect: "⇄  Conectar una Tool",
    navInput: "1 · Input", navContract: "2 · Contrato", navExec: "3 · Ejecución", navOutput: "4 · Output",
    navDash: "Dashboards", navMarli: "MARLI",
    connectTitle: "Conectar una Tool",
    connectSub: "Cualquier productor — un MES real, un formulario manual, un sistema futuro, o las tools de Carlos — se conecta igual: emite un evento con la forma del contrato de abajo. Nunca hay acoplamiento directo.",
    cgRequired: "Campos requeridos del payload", cgExample: "Ejemplo de payload — real, sale de un fixture demo",
    cgSteps: "Cómo se conecta cualquier tool", cgCopy: "Copiar JSON", cgCopied: "¡Copiado!", cgLoad: "Cargar en el Editor JSON Crudo y probar",
    cgSchema: "Schema", cgTarget: "Tool destino",
    ts: ["Evento recibido", "Payload cargado", "Contrato validado", "Handler ejecutado",
         "Resultado producido", "Eventos emitidos", "Ledger actualizado", "Ruteo downstream evaluado"],
    stPending: "PENDIENTE", stRunning: "CORRIENDO", stOk: "OK", stFail: "FALLÓ", stWarn: "WARNING", stSkip: "OMITIDO",
    runIdle: "IDLE", runRunning: "CORRIENDO", runSuccess: "SUCCESS", runCritical: "CRITICAL",
    runWarning: "WARNING", runVError: "VALIDATION ERROR",
    verdictCapable: "Capaz", verdictBelow: "Bajo Target", verdictAcceptable: "Aceptable",
    verdictNotAcceptable: "No Aceptable", verdictWarning: "Warning", verdictVError: "Error de Validación",
    mean: "Media", stddev: "Desv Est", sample: "Tamaño Muestra", verdict: "Veredicto",
    grr: "Gage R&R %", repeat: "Repetibilidad", repro: "Reproducibilidad",
    contractOk: "CONTRATO SATISFECHO", contractFail: "CONTRATO NO SATISFECHO — el handler se detendrá con validation-error",
    contractWarn: "VÍA DE COMPATIBILIDAD — el handler dará warning y recomendará MSA_STUDY_REQUESTED",
    noneMissing: "Ninguno — contrato satisfecho.",
    execNoteExternal: "Ejecuta el evento armado desde Source Tool / Event Type / Target Tool / Payload de arriba.",
    execNoteManual: "Construye el evento desde el formulario y corre el mismo pipeline.",
    execNoteRaw: "Ejecuta el envelope completo exactamente como se ve en el editor.",
    stoppedAt: "Se detuvo en la validación de contrato. No inventó resultado, no emitió evento.",
    evidence: [
      ["ok", "lógica del handler: portada 1:1 de tools/*/src/handler.js — IMPLEMENTED"],
      ["ok", "chequeo de contrato: validación real de campos requeridos — IMPLEMENTED"],
      ["ok", "correlationId / causationId: generados y propagados — IMPLEMENTED"],
      ["mk", "transporte del bus: llamada in-process — MOCK"],
      ["mk", "persistencia del ledger: en memoria, columnas listas para PostgreSQL — DEMO DATA"],
      ["mk", "consumidores downstream: nombres de adapters/carlos-ecosystem — NEEDS CARLOS CONFIRMATION"]
    ]
  }
};
let LANG = "en";
const t = (k) => I18N[LANG][k] !== undefined ? I18N[LANG][k] : (I18N.en[k] !== undefined ? I18N.en[k] : k);

/* =====================================================================
   HANDLERS — ported 1:1 from the tool source. Do not edit here without
   editing the tool first. Source of truth:
     tools/calculate-cpk-ppk/src/handler.js
     tools/run-msa-analysis/src/handler.js
   ===================================================================== */
const DEFAULT_MINIMUM_CPK = 1.33;
function round(value, decimals = 4) { return Number(value.toFixed(decimals)); }
function mean(values) { return values.reduce((s, v) => s + v, 0) / values.length; }
function sampleStdDev(values, average) {
  if (values.length < 2) return 0;
  const avg = average === undefined ? mean(values) : average;
  const variance = values.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}
function buildEvent(type, source, payload) {
  return { type, source, occurredAt: new Date().toISOString(), payload };
}

/* ---- calculate-cpk-ppk ---- */
function cpkValidationError(message, details) {
  return { ok: false, status: "validation-error", message, details, emittedEvents: [],
    recommendation: "Capture complete measurement data, including numeric LSL, USL, target, and at least two numeric measurements." };
}
function cpkValidatePayload(payload) {
  if (!payload || typeof payload !== "object") return cpkValidationError("Missing payload.", ["payload is required"]);
  const details = [];
  if (!Array.isArray(payload.measurements) || payload.measurements.length < 2) {
    details.push("measurements must contain at least two numeric values");
  } else if (!payload.measurements.every((v) => Number.isFinite(v))) {
    details.push("measurements must be numeric");
  }
  for (const field of ["lsl", "usl", "target"]) {
    if (!Number.isFinite(payload[field])) details.push(field + " must be numeric");
  }
  if (Number.isFinite(payload.lsl) && Number.isFinite(payload.usl) && payload.lsl >= payload.usl) {
    details.push("lsl must be lower than usl");
  }
  if (Number.isFinite(payload.target) && Number.isFinite(payload.lsl) && Number.isFinite(payload.usl) &&
      (payload.target < payload.lsl || payload.target > payload.usl)) {
    details.push("target must be between lsl and usl");
  }
  return details.length ? cpkValidationError("Capability analysis cannot run with missing or invalid specs.", details) : null;
}
function cpkHandle(event) {
  if (!event || event.type !== "MEASUREMENTS_CAPTURED") {
    return cpkValidationError("Unsupported event type.", ["expected MEASUREMENTS_CAPTURED"]);
  }
  const payload = event.payload;
  const validation = cpkValidatePayload(payload);
  if (validation) return validation;
  const measurements = payload.measurements;
  const average = mean(measurements);
  const standardDeviation = sampleStdDev(measurements, average);
  if (standardDeviation === 0) {
    return cpkValidationError("Capability analysis cannot run when all measurements are identical.", ["standard deviation is zero"]);
  }
  const cp = (payload.usl - payload.lsl) / (6 * standardDeviation);
  const cpu = (payload.usl - average) / (3 * standardDeviation);
  const cpl = (average - payload.lsl) / (3 * standardDeviation);
  const cpk = Math.min(cpu, cpl);
  const minimumCpk = Number.isFinite(payload.minimumCpk) ? payload.minimumCpk : DEFAULT_MINIMUM_CPK;
  const belowTarget = cpk < minimumCpk;
  const recommendation = belowTarget
    ? "Capability is below target. Review centering, variation sources, measurement method, and containment needs before release."
    : "Capability meets the target. Continue routine monitoring and preserve the current control plan.";
  const result = {
    measurementSetId: payload.measurementSetId || "unknown",
    partNumber: payload.partNumber, characteristic: payload.characteristic,
    cp: round(cp), cpk: round(cpk), mean: round(average),
    standardDeviation: round(standardDeviation), sampleSize: measurements.length,
    minimumCpk, verdict: belowTarget ? "below-target" : "capable", recommendation
  };
  const emittedEvents = [buildEvent("CAPABILITY_ANALYSIS_COMPLETED", "calculate-cpk-ppk", result)];
  if (belowTarget) {
    emittedEvents.push(buildEvent("CAPABILITY_BELOW_TARGET", "calculate-cpk-ppk", {
      measurementSetId: result.measurementSetId, cpk: result.cpk, minimumCpk, recommendation
    }));
  }
  return { ok: true, status: "completed", result, emittedEvents, recommendation };
}

/* ---- run-msa-analysis ---- */
function msaValidationError(message, details) {
  return { ok: false, status: "validation-error", message, details, emittedEvents: [],
    recommendation: "Request a formal MSA study with device ID and repeated observations by part, operator, and trial." };
}
function msaWarning(message, details) {
  return { ok: false, status: "warning", message, details, emittedEvents: [],
    recommendation: "Create an MSA_STUDY_REQUESTED event after collecting repeated device observations." };
}
function msaNormalizeEvent(event) {
  if (!event || !event.type) return { error: msaValidationError("Missing event type.", ["type is required"]) };
  if (event.type === "MSA_STUDY_REQUESTED") return { payload: event.payload || {}, compatibilityPath: false };
  if (event.type === "NEW_DEVICE_REGISTERED") {
    const payload = event.payload || {};
    if (!Array.isArray(payload.observations) || payload.observations.length === 0) {
      return { error: msaWarning("NEW_DEVICE_REGISTERED does not include observations for MSA.", ["observations are required for analysis"]) };
    }
    return {
      payload: {
        studyId: payload.studyId || ("MSA-" + (payload.deviceId || "unknown")),
        deviceId: payload.deviceId, partNumber: payload.partNumber, observations: payload.observations
      },
      compatibilityPath: true
    };
  }
  return { error: msaValidationError("Unsupported event type.", ["expected MSA_STUDY_REQUESTED or NEW_DEVICE_REGISTERED"]) };
}
function msaValidatePayload(payload) {
  const details = [];
  if (!payload.studyId) details.push("studyId is required");
  if (!payload.deviceId) details.push("deviceId is required");
  if (!Array.isArray(payload.observations) || payload.observations.length < 2) {
    details.push("observations must contain at least two rows");
  } else {
    payload.observations.forEach((observation, index) => {
      for (const field of ["partId", "operatorId", "trial"]) {
        if (observation[field] === undefined || observation[field] === null || observation[field] === "") {
          details.push("observations[" + index + "]." + field + " is required");
        }
      }
      if (!Number.isFinite(observation.value)) details.push("observations[" + index + "].value must be numeric");
    });
  }
  return details.length ? msaValidationError("MSA analysis cannot run with incomplete study data.", details) : null;
}
function groupedStdDev(observations, keyBuilder) {
  const groups = new Map();
  for (const o of observations) {
    const key = keyBuilder(o);
    const values = groups.get(key) || [];
    values.push(o.value);
    groups.set(key, values);
  }
  const deviations = Array.from(groups.values()).filter((v) => v.length > 1).map((v) => sampleStdDev(v));
  return deviations.length ? mean(deviations) : 0;
}
function msaAnalyze(payload) {
  const observations = payload.observations;
  const values = observations.map((o) => o.value);
  const totalVariation = sampleStdDev(values);
  const repeatability = groupedStdDev(observations, (o) => o.partId + ":" + o.operatorId);
  const operatorMeans = new Map();
  for (const o of observations) {
    const vs = operatorMeans.get(o.operatorId) || [];
    vs.push(o.value);
    operatorMeans.set(o.operatorId, vs);
  }
  const operatorMeanValues = Array.from(operatorMeans.values()).map((vs) => mean(vs));
  const reproducibility = sampleStdDev(operatorMeanValues);
  const gageRR = Math.sqrt(Math.pow(repeatability, 2) + Math.pow(reproducibility, 2));
  const gageRRPercent = totalVariation === 0 ? 100 : (gageRR / totalVariation) * 100;
  const partMeans = Array.from(new Set(observations.map((o) => o.partId)))
    .map((partId) => mean(observations.filter((o) => o.partId === partId).map((o) => o.value)));
  const partVariation = sampleStdDev(partMeans);
  const ndc = gageRR === 0 ? 0 : Math.floor(1.41 * (partVariation / gageRR));
  const acceptable = gageRRPercent <= 10 && ndc >= 5;
  return {
    studyId: payload.studyId, deviceId: payload.deviceId, partNumber: payload.partNumber,
    gageRRPercent: round(gageRRPercent), repeatability: round(repeatability),
    reproducibility: round(reproducibility), ndc,
    verdict: acceptable ? "acceptable" : "not-acceptable",
    recommendation: acceptable
      ? "Measurement system is acceptable for the current study. Keep the device in the approved measurement path."
      : "Measurement system is not acceptable. Review fixture, operator method, device calibration, and study design before use."
  };
}
function msaHandle(event) {
  const normalized = msaNormalizeEvent(event);
  if (normalized.error) return normalized.error;
  const validation = msaValidatePayload(normalized.payload);
  if (validation) return validation;
  const result = msaAnalyze(normalized.payload);
  const emittedEvents = [buildEvent("MSA_ANALYSIS_COMPLETED", "run-msa-analysis", result)];
  emittedEvents.push(buildEvent(result.verdict === "acceptable" ? "MSA_VALIDATED" : "MSA_NOT_ACCEPTABLE", "run-msa-analysis", {
    studyId: result.studyId, deviceId: result.deviceId,
    gageRRPercent: result.gageRRPercent, ndc: result.ndc, recommendation: result.recommendation
  }));
  return { ok: true, status: "completed", compatibilityPath: normalized.compatibilityPath, result, emittedEvents, recommendation: result.recommendation };
}
/* ================== end of ported handlers ================== */

/* ============================ registry data ============================ */
const TOOLS = [
  {
    name: "calculate-cpk-ppk", handler: cpkHandle, key: "cpk",
    consumes: ["MEASUREMENTS_CAPTURED"],
    produces: [["CAPABILITY_ANALYSIS_COMPLETED", "produces"], ["CAPABILITY_BELOW_TARGET", "alert"]],
    upstream: [["collect_quality_measurements", ""], ["manual_quality_input", ""], ["csv_import", ""], ["mes_connector", "mock"]],
    downstream: [["manage_product_specs", "confirm"], ["audit_report", "confirm"], ["calculate_control_charts", "confirm"], ["marli_adapter", "future"]],
    src: "tools/calculate-cpk-ppk/src/handler.js"
  },
  {
    name: "run-msa-analysis", handler: msaHandle, key: "msa",
    consumes: ["MSA_STUDY_REQUESTED", "NEW_DEVICE_REGISTERED"],
    produces: [["MSA_ANALYSIS_COMPLETED", "produces"], ["MSA_VALIDATED", "produces"], ["MSA_NOT_ACCEPTABLE", "alert"]],
    upstream: [["manage_device_registry", ""], ["metrology_input_form", ""], ["calibration_registry", ""], ["manual_msa_input", ""]],
    downstream: [["calculate_control_charts", "confirm"], ["manage_nonconformances", "confirm"], ["audit_report", "confirm"], ["marli_adapter", "future"]],
    src: "tools/run-msa-analysis/src/handler.js"
  }
];
const EVENT_TO_TOOL = {
  MEASUREMENTS_CAPTURED: TOOLS[0],
  MSA_STUDY_REQUESTED: TOOLS[1],
  NEW_DEVICE_REGISTERED: TOOLS[1]
};
const ROUTING = {
  CAPABILITY_ANALYSIS_COMPLETED: [["manage_product_specs", "confirm"], ["audit_report", "confirm"]],
  CAPABILITY_BELOW_TARGET: [["calculate_control_charts", "confirm"], ["marli_adapter", "future"]],
  MSA_ANALYSIS_COMPLETED: [["audit_report", "confirm"], ["calculate_control_charts", "confirm"]],
  MSA_VALIDATED: [["calculate_control_charts", "confirm"]],
  MSA_NOT_ACCEPTABLE: [["manage_nonconformances", "confirm"], ["marli_adapter", "future"]]
};

/* ============================ scenarios ============================ */
/* Embedded copies of data/cpk-scenarios.json and data/msa-scenarios.json.
   Embedded so index.html works from file:// with a double-click (no fetch,
   no "Failed to fetch"). Keep in sync with the JSON files and with
   tools/<tool>/demo/*.json. */
const SCENARIOS = [
  {
    id: "cpk-capable", tool: "calculate-cpk-ppk", targetKey: "cpk", expect: "SUCCESS",
    name: { en: "Load collect_quality_measurements → MEASUREMENTS_CAPTURED", es: "Cargar collect_quality_measurements → MEASUREMENTS_CAPTURED" },
    desc: { en: "Healthy shaft diameter data. Emits CAPABILITY_ANALYSIS_COMPLETED.", es: "Datos sanos de diámetro de eje. Emite CAPABILITY_ANALYSIS_COMPLETED." },
    owner: "", event: { type: "MEASUREMENTS_CAPTURED", source: "collect_quality_measurements",
      payload: { measurementSetId: "MS-CPK-001", partNumber: "PN-9001", characteristic: "shaft diameter",
        measurements: [10.01, 10.02, 9.99, 10.0, 10.01, 9.98, 10.02, 10.0],
        lsl: 9.9, usl: 10.1, target: 10.0, minimumCpk: 1.33 } }
  },
  {
    id: "cpk-below-target", tool: "calculate-cpk-ppk", targetKey: "cpk", expect: "CRITICAL",
    name: { en: "Load csv_import → MEASUREMENTS_CAPTURED below target", es: "Cargar csv_import → MEASUREMENTS_CAPTURED bajo target" },
    desc: { en: "Wide slot-width variation. Also emits CAPABILITY_BELOW_TARGET.", es: "Variación amplia de ancho de ranura. Emite además CAPABILITY_BELOW_TARGET." },
    owner: "", event: { type: "MEASUREMENTS_CAPTURED", source: "csv_import",
      payload: { measurementSetId: "MS-CPK-002", partNumber: "PN-9002", characteristic: "slot width",
        measurements: [5.01, 5.08, 4.95, 5.12, 4.91, 5.06, 4.98, 5.1],
        lsl: 4.9, usl: 5.1, target: 5.0, minimumCpk: 1.33 } }
  },
  {
    id: "cpk-missing-specs", tool: "calculate-cpk-ppk", targetKey: "cpk", expect: "VALIDATION ERROR",
    name: { en: "Load manual_quality_input → MEASUREMENTS_CAPTURED missing specs", es: "Cargar manual_quality_input → MEASUREMENTS_CAPTURED sin specs" },
    desc: { en: "No LSL/USL. The handler stops at the contract — no invented result.", es: "Sin LSL/USL. El handler se detiene en el contrato — no inventa resultado." },
    owner: "", event: { type: "MEASUREMENTS_CAPTURED", source: "manual_quality_input",
      payload: { measurementSetId: "MS-CPK-003", partNumber: "PN-9003", characteristic: "bore depth",
        measurements: [2.1, 2.12, 2.09, 2.11], target: 2.1 } }
  },
  {
    id: "msa-acceptable", tool: "run-msa-analysis", targetKey: "msa", expect: "SUCCESS",
    name: { en: "Load metrology_input_form → MSA_STUDY_REQUESTED", es: "Cargar metrology_input_form → MSA_STUDY_REQUESTED" },
    desc: { en: "Formal study, low Gage R&R. Emits MSA_VALIDATED.", es: "Estudio formal, Gage R&R bajo. Emite MSA_VALIDATED." },
    owner: "", event: { type: "MSA_STUDY_REQUESTED", source: "metrology_input_form",
      payload: { studyId: "MSA-001", deviceId: "CAL-100", partNumber: "PN-9001",
        observations: [
          { partId: "P1", operatorId: "A", trial: 1, value: 10.01 },
          { partId: "P1", operatorId: "A", trial: 2, value: 10.011 },
          { partId: "P1", operatorId: "B", trial: 1, value: 10.012 },
          { partId: "P1", operatorId: "B", trial: 2, value: 10.013 },
          { partId: "P2", operatorId: "A", trial: 1, value: 10.2 },
          { partId: "P2", operatorId: "A", trial: 2, value: 10.201 },
          { partId: "P2", operatorId: "B", trial: 1, value: 10.202 },
          { partId: "P2", operatorId: "B", trial: 2, value: 10.203 }
        ] } }
  },
  {
    id: "msa-not-acceptable", tool: "run-msa-analysis", targetKey: "msa", expect: "CRITICAL",
    name: { en: "Load calibration_registry → MSA_STUDY_REQUESTED not acceptable", es: "Cargar calibration_registry → MSA_STUDY_REQUESTED no aceptable" },
    desc: { en: "Noisy repeated readings. Emits MSA_NOT_ACCEPTABLE.", es: "Lecturas repetidas ruidosas. Emite MSA_NOT_ACCEPTABLE." },
    owner: "", event: { type: "MSA_STUDY_REQUESTED", source: "calibration_registry",
      payload: { studyId: "MSA-002", deviceId: "CAL-200", partNumber: "PN-9002",
        observations: [
          { partId: "P1", operatorId: "A", trial: 1, value: 5.01 },
          { partId: "P1", operatorId: "A", trial: 2, value: 5.12 },
          { partId: "P1", operatorId: "B", trial: 1, value: 4.95 },
          { partId: "P1", operatorId: "B", trial: 2, value: 5.09 },
          { partId: "P2", operatorId: "A", trial: 1, value: 5.05 },
          { partId: "P2", operatorId: "A", trial: 2, value: 4.93 },
          { partId: "P2", operatorId: "B", trial: 1, value: 5.14 },
          { partId: "P2", operatorId: "B", trial: 2, value: 4.91 }
        ] } }
  },
  {
    id: "msa-incomplete-device", tool: "run-msa-analysis", targetKey: "msa", expect: "WARNING",
    name: { en: "Load manage_device_registry → NEW_DEVICE_REGISTERED", es: "Cargar manage_device_registry → NEW_DEVICE_REGISTERED" },
    desc: { en: "NEW_DEVICE_REGISTERED without observations. Warning, no analysis event.", es: "NEW_DEVICE_REGISTERED sin observations. Warning, sin evento de análisis." },
    owner: "", event: { type: "NEW_DEVICE_REGISTERED", source: "manage_device_registry",
      payload: { deviceId: "CAL-300", deviceName: "Digital Caliper 300", calibrationStatus: "new" } }
  },
  {
    id: "demian-nonconformance", tool: null, targetKey: null, expect: "NOT CONSUMABLE",
    name: { en: "Load Demian example → NONCONFORMANCE_CREATED / needs adapter", es: "Cargar ejemplo de Demian → NONCONFORMANCE_CREATED / necesita adapter" },
    desc: { en: "manage_nonconformance emits NONCONFORMANCE_CREATED. Neither tool consumes it yet — needs a mapping.", es: "manage_nonconformance emite NONCONFORMANCE_CREATED. Ninguna tool lo consume todavía — necesita un mapping." },
    owner: "Demian", needsConfirm: true,
    event: { type: "NONCONFORMANCE_CREATED", source: "manage_nonconformance",
      payload: { nonconformanceId: "NC-EXAMPLE-001", partNumber: "PN-9001",
        description: "Example payload — shape not yet confirmed with Carlos.", detectedBy: "Demian" } }
  }
];
/* Source Tool options per target tool — plus the always-available unconfirmed/external paths.
   Mirrors the upstream producer lists in TOOLS[].upstream, section A of the connect-a-tool brief. */
const SOURCE_OPTIONS = {
  cpk: ["collect_quality_measurements", "manual_quality_input", "csv_import", "mes_connector (mock)", "external_tool_unconfirmed", "manage_nonconformance"],
  msa: ["manage_device_registry", "metrology_input_form", "calibration_registry", "manual_msa_input", "external_tool_unconfirmed", "manage_nonconformance"]
};
/* Every event type a producer could plausibly send — including one (NONCONFORMANCE_CREATED)
   neither tool consumes yet, so the compatibility check has a real NOT-CONSUMABLE/NEEDS-CONFIRMATION case to show. */
const EVENT_TYPE_OPTIONS = ["MEASUREMENTS_CAPTURED", "MSA_STUDY_REQUESTED", "NEW_DEVICE_REGISTERED", "NONCONFORMANCE_CREATED"];
let activeScenario = SCENARIOS[0];
let mode = "external";       /* external | manual | raw */
let extState = { source: "collect_quality_measurements", owner: "", eventType: "MEASUREMENTS_CAPTURED", targetKey: "cpk", corr: "" };
let activeManualTab = "cpk"; /* cpk | msa | dev */

/* ============================ connect-a-tool guides ============================ */
/* Field lists mirror contracts/events/*.schema.json 1:1 (read-only reference,
   not modified by this workspace). Examples are real SCENARIOS fixtures, not invented. */
const CONNECT_GUIDES = [
  {
    id: "measurements", eventType: "MEASUREMENTS_CAPTURED", tool: "calculate-cpk-ppk",
    tab: { en: "Measurements → Cpk/Ppk", es: "Mediciones → Cpk/Ppk" },
    schema: "contracts/events/MEASUREMENTS_CAPTURED.schema.json",
    fields: [
      ["measurementSetId", "string", { en: "Your own ID for this measurement batch.", es: "Tu propio ID para este lote de mediciones." }],
      ["measurements", "number[] · min 2", { en: "Raw readings, same unit as lsl/usl.", es: "Lecturas crudas, misma unidad que lsl/usl." }],
      ["lsl", "number", { en: "Lower specification limit.", es: "Límite inferior de especificación." }],
      ["usl", "number", { en: "Upper specification limit.", es: "Límite superior de especificación." }],
      ["target", "number", { en: "Nominal / target value.", es: "Valor nominal / target." }],
      ["minimumCpk", "number · optional, default 1.33", { en: "Acceptance threshold.", es: "Umbral de aceptación." }]
    ],
    example: SCENARIOS[0].event,
    steps: {
      en: [
        "Build an event: { type: \"MEASUREMENTS_CAPTURED\", source: \"&lt;your-tool-name&gt;\", payload: { ...fields above } }.",
        "“source” is just a string identifying the producer — your MES, a manual form, a CSV import, anything.",
        "Today the event bus is MOCK: “sending” means pasting this JSON into the Raw JSON Event editor and clicking Run.",
        "Once a real bus exists, the same JSON is what gets published — nothing on our side has to change.",
        "Our handler checks the contract first. Missing lsl/usl/target stops with validation-error — it never invents a Cpk."
      ],
      es: [
        "Arma un evento: { type: \"MEASUREMENTS_CAPTURED\", source: \"&lt;tu-tool&gt;\", payload: { ...campos de arriba } }.",
        "“source” es solo un string que identifica al productor — tu MES, un formulario manual, un import de CSV, lo que sea.",
        "Hoy el event bus es MOCK: “enviar” significa pegar este JSON en el editor de Evento JSON Crudo y darle Ejecutar.",
        "Cuando exista un bus real, se publica el mismo JSON — de nuestro lado no cambia nada.",
        "Nuestro handler valida el contrato primero. Si faltan lsl/usl/target se detiene con validation-error — nunca inventa un Cpk."
      ]
    }
  },
  {
    id: "msa-study", eventType: "MSA_STUDY_REQUESTED", tool: "run-msa-analysis",
    tab: { en: "MSA Study → run-msa-analysis", es: "Estudio MSA → run-msa-analysis" },
    schema: "contracts/events/MSA_STUDY_REQUESTED.schema.json",
    fields: [
      ["studyId", "string", { en: "Your own ID for this MSA study.", es: "Tu propio ID para este estudio MSA." }],
      ["deviceId", "string", { en: "Device / gage under study.", es: "Equipo / gage en estudio." }],
      ["partNumber", "string · optional", { en: "Part measured during the study.", es: "Parte medida durante el estudio." }],
      ["observations", "object[] · min 2", { en: "Repeated readings — see rows below.", es: "Lecturas repetidas — ver filas abajo." }],
      ["observations[].partId / operatorId / trial", "string / string / integer", { en: "Required per row, so variation can be split by part, operator, and trial.", es: "Requerido por fila, para separar variación por parte, operador y trial." }],
      ["observations[].value", "number", { en: "The actual reading.", es: "La lectura en sí." }]
    ],
    example: SCENARIOS[3].event,
    steps: {
      en: [
        "Build an event: { type: \"MSA_STUDY_REQUESTED\", source: \"&lt;your-tool-name&gt;\", payload: { ...fields above } }.",
        "This is the formal path — use it whenever you already have repeated part/operator/trial observations.",
        "Paste this JSON into the Raw JSON Event editor and click Run to see Gage R&R, repeatability, reproducibility, and ndc computed live.",
        "The handler validates studyId, deviceId, and every observation row before computing anything.",
        "Result: MSA_ANALYSIS_COMPLETED always, plus MSA_VALIDATED or MSA_NOT_ACCEPTABLE depending on the numbers."
      ],
      es: [
        "Arma un evento: { type: \"MSA_STUDY_REQUESTED\", source: \"&lt;tu-tool&gt;\", payload: { ...campos de arriba } }.",
        "Esta es la vía formal — úsala cuando ya tengas observaciones repetidas por parte/operador/trial.",
        "Pega este JSON en el editor de Evento JSON Crudo y dale Ejecutar para ver Gage R&R, repetibilidad, reproducibilidad y ndc en vivo.",
        "El handler valida studyId, deviceId y cada fila de observations antes de calcular nada.",
        "Resultado: siempre MSA_ANALYSIS_COMPLETED, más MSA_VALIDATED o MSA_NOT_ACCEPTABLE según los números."
      ]
    }
  },
  {
    id: "device", eventType: "NEW_DEVICE_REGISTERED", tool: "run-msa-analysis",
    tab: { en: "Device Registration (compatibility)", es: "Registro de Equipo (compatibilidad)" },
    schema: "no dedicated schema — compatibility path only, see tools/run-msa-analysis/src/handler.js",
    fields: [
      ["deviceId", "string", { en: "Device / gage being registered.", es: "Equipo / gage que se registra." }],
      ["deviceType", "string · optional", { en: "e.g. digital caliper, micrometer.", es: "p. ej. calibrador digital, micrómetro." }],
      ["calibrationStatus", "string · optional", { en: "new / calibrated / due / expired.", es: "new / calibrated / due / expired." }],
      ["observations", "absent on this path", { en: "This event never carries observations — that is the whole point of the compatibility path.", es: "Este evento nunca trae observations — ese es el punto de la vía de compatibilidad." }]
    ],
    example: SCENARIOS[5].event,
    steps: {
      en: [
        "This is a compatibility path, not a formal MSA request — it exists because manage_device_registry emits NEW_DEVICE_REGISTERED without observations.",
        "Paste this JSON into the Raw JSON Event editor and click Run: you will see a WARNING, not an analysis result.",
        "The handler never fakes a Gage R&R from a device registration alone — that would be an invented result.",
        "Its recommendation is always the same: emit a proper MSA_STUDY_REQUESTED (left tab) once observations exist.",
        "NEEDS CARLOS CONFIRMATION: no tool in his catalog is yet registered as the producer of MSA_STUDY_REQUESTED."
      ],
      es: [
        "Esta es una vía de compatibilidad, no una solicitud MSA formal — existe porque manage_device_registry emite NEW_DEVICE_REGISTERED sin observations.",
        "Pega este JSON en el editor de Evento JSON Crudo y dale Ejecutar: verás un WARNING, no un resultado de análisis.",
        "El handler nunca inventa un Gage R&R solo a partir de un registro de equipo — sería un resultado inventado.",
        "Su recomendación es siempre la misma: emitir un MSA_STUDY_REQUESTED formal (tab izquierda) una vez que existan observations.",
        "NEEDS CARLOS CONFIRMATION: ningún tool de su catálogo está registrado todavía como productor de MSA_STUDY_REQUESTED."
      ]
    }
  }
];
let activeConnectGuide = CONNECT_GUIDES[0].id;

/* ============================ live contract check ============================ */
/* Compatibility engine — section B of the connect-a-tool brief.
   Priority: unknown event type (never in our contracts/events/) → unconfirmed;
   known type but wrong/no target tool → not-consumable; known+right target →
   field-level compatible/missing. tolerance is listed for MSA_STUDY_REQUESTED
   per the brief, but kept optional/non-blocking: the real contract
   (contracts/events/MSA_STUDY_REQUESTED.schema.json) and the ported handler
   never required or used it, and this workspace does not invent stricter
   enforcement than the real handler has. */
function computeCompatibility(event, targetKey) {
  const type = event && event.type;
  const p = (event && event.payload) || {};
  const target = TOOLS.find((tl) => tl.key === targetKey) || null;
  if (!type) return { status: "missing", items: [], target, known: false, note: "" };
  const known = Object.prototype.hasOwnProperty.call(EVENT_TO_TOOL, type);
  if (!known) return { status: "unconfirmed", items: [], target, known: false, note: t("notConsumableMsg") };
  if (!target || target.consumes.indexOf(type) < 0) {
    return { status: "not-consumable", items: [], target, known: true, note: t("notConsumableMsg") };
  }
  const items = [];
  const req = (field, ok, detail, optional) => items.push({ field, ok, detail: detail || "", optional: !!optional });
  let note = "";
  if (type === "MEASUREMENTS_CAPTURED") {
    req("measurements", Array.isArray(p.measurements) && p.measurements.length >= 2 && p.measurements.every(Number.isFinite),
      Array.isArray(p.measurements) ? p.measurements.length + " values" : "array required");
    req("lsl", Number.isFinite(p.lsl), Number.isFinite(p.lsl) ? String(p.lsl) : "numeric required");
    req("usl", Number.isFinite(p.usl), Number.isFinite(p.usl) ? String(p.usl) : "numeric required");
    req("target", Number.isFinite(p.target), Number.isFinite(p.target) ? String(p.target) : "numeric required");
    if (Number.isFinite(p.lsl) && Number.isFinite(p.usl)) req("lsl < usl", p.lsl < p.usl, p.lsl + " < " + p.usl);
  } else if (type === "MSA_STUDY_REQUESTED") {
    req("studyId", !!p.studyId, p.studyId || "required");
    req("deviceId", !!p.deviceId, p.deviceId || "required");
    req("tolerance", true, p.tolerance !== undefined ? String(p.tolerance) : "optional, not yet enforced", true);
    const obsOk = Array.isArray(p.observations) && p.observations.length >= 2 &&
      p.observations.every((o) => o && o.partId !== undefined && o.operatorId !== undefined && o.trial !== undefined && Number.isFinite(o.value));
    req("observations[]", obsOk, Array.isArray(p.observations) ? p.observations.length + " rows" : "array required");
    req("observations[].partId / operatorId / trial / value", obsOk, "per row");
  } else if (type === "NEW_DEVICE_REGISTERED") {
    req("deviceId", !!p.deviceId, p.deviceId || "required");
    req("deviceType", !!p.deviceType, p.deviceType || "required");
    req("calibrationStatus", !!p.calibrationStatus, p.calibrationStatus || "required");
    const hasObs = Array.isArray(p.observations) && p.observations.length > 0;
    if (!hasObs) note = t("deviceCompatWarn");
  }
  const blocking = items.filter((i) => !i.optional);
  const status = blocking.every((i) => i.ok) ? "compatible" : "missing";
  return { status, items, target, known: true, note };
}

/* ============================ ledger ============================ */
let ledgerRows = [];
let nextLedgerId = 1005;
let corrSeq = 4;
function newCorrId() { corrSeq += 1; return "corr-qtw-" + String(corrSeq).padStart(4, "0"); }
function newEventId() { return "evt-" + Math.random().toString(16).slice(2, 8); }
function nowTs() { return new Date().toISOString().replace("T", " ").slice(0, 23); }
function seedLedger() {
  ledgerRows = [
    { id: 1001, ts: "2026-07-09 07:12:44.201", corr: "corr-qtw-0001", cause: "evt-a41c02", src: "collect_quality_measurements",
      ev: "MEASUREMENTS_CAPTURED", tgt: "calculate-cpk-ppk", st: "SUCCESS",
      em: "CAPABILITY_ANALYSIS_COMPLETED", dc: "manage_product_specs, audit_report" },
    { id: 1002, ts: "2026-07-09 07:31:02.977", corr: "corr-qtw-0002", cause: "evt-b7f2d9", src: "manage_device_registry",
      ev: "NEW_DEVICE_REGISTERED", tgt: "run-msa-analysis", st: "WARNING", em: "—", dc: "—" },
    { id: 1003, ts: "2026-07-09 08:04:18.530", corr: "corr-qtw-0003", cause: "evt-c9a1e4", src: "metrology_input_form",
      ev: "MSA_STUDY_REQUESTED", tgt: "run-msa-analysis", st: "SUCCESS",
      em: "MSA_ANALYSIS_COMPLETED, MSA_VALIDATED", dc: "calculate_control_charts, audit_report" },
    { id: 1004, ts: "2026-07-09 08:22:51.114", corr: "corr-qtw-0004", cause: "evt-d2c477", src: "csv_import",
      ev: "MEASUREMENTS_CAPTURED", tgt: "calculate-cpk-ppk", st: "CRITICAL",
      em: "CAPABILITY_ANALYSIS_COMPLETED, CAPABILITY_BELOW_TARGET", dc: "manage_product_specs, audit_report, calculate_control_charts" }
  ];
  renderLedger();
}
function appendLedger(row) { ledgerRows.unshift(Object.assign({ fresh: true }, row)); renderLedger(); }
function renderLedger() {
  const cls = (s) => s === "SUCCESS" ? "badge success" : s === "CRITICAL" || s === "NOT CONSUMABLE" ? "badge critical" :
    s === "WARNING" ? "badge warning" : s === "NEEDS CONFIRMATION" ? "badge confirm" : "badge verror";
  document.getElementById("ledgerBody").innerHTML = ledgerRows.map((r) =>
    "<tr class=\"" + (r.fresh ? "fresh" : "") + "\"><td>" + r.id + "</td><td>" + r.ts + "</td>" +
    "<td class=\"c-corr\">" + r.corr + "</td><td class=\"c-corr\">" + r.cause + "</td>" +
    "<td class=\"c-tool\">" + r.src + "</td><td class=\"c-ev\">" + r.ev + "</td>" +
    "<td class=\"c-tool\">" + r.tgt + "</td><td><span class=\"" + cls(r.st) + "\">" + r.st + "</span></td>" +
    "<td>" + r.em + "</td><td>" + r.dc + "</td></tr>").join("");
  ledgerRows.forEach((r) => { r.fresh = false; });
  document.getElementById("pgCount").textContent = "event_ledger · " + ledgerRows.length;
}

/* ============================ rendering: registry ============================ */
function renderRegistry() {
  const activeTool = currentTool();
  document.getElementById("registry").innerHTML = TOOLS.map((tool) =>
    "<div class=\"toolcard" + (activeTool && activeTool.name === tool.name ? " active" : "") + "\">" +
    "<div class=\"tc-head\"><span class=\"dot ok\"></span><span class=\"tc-name\">" + tool.name + "</span>" +
    "<span class=\"badge implemented\">IMPLEMENTED</span></div>" +
    "<div class=\"tc-sec\"><div class=\"tc-label\">" + t("consumes") + "</div>" +
    tool.consumes.map((e) => "<span class=\"evchip consumes\">" + e + "</span>").join("") + "</div>" +
    "<div class=\"tc-sec\"><div class=\"tc-label\">" + t("produces") + "</div>" +
    tool.produces.map((e) => "<span class=\"evchip " + e[1] + "\">" + e[0] + "</span>").join("") + "</div>" +
    "<div class=\"tc-sec\"><div class=\"tc-label\">" + t("upstream") + "</div><div class=\"peers\">" +
    tool.upstream.map((u) => "<span class=\"peer " + u[1] + "\">" + u[0] + (u[1] === "mock" ? " · MOCK" : "") + "</span>").join("") + "</div></div>" +
    "<div class=\"tc-sec\"><div class=\"tc-label\">" + t("downstream") + "</div><div class=\"peers\">" +
    tool.downstream.map((d) => "<span class=\"peer " + d[1] + "\">" + d[0] + (d[1] === "future" ? " ⌛" : "") + "</span>").join("") + "</div></div>" +
    "<div class=\"tc-foot\">" + tool.src + "</div></div>").join("");
}

/* ============================ connect-a-tool modal ============================ */
function renderConnectTabs() {
  document.getElementById("connectTabs").innerHTML = CONNECT_GUIDES.map((g) =>
    "<button type=\"button\" class=\"ctab" + (g.id === activeConnectGuide ? " on" : "") + "\" data-gid=\"" + g.id + "\">" +
    g.tab[LANG] + "</button>").join("");
  Array.prototype.forEach.call(document.querySelectorAll(".ctab"), (el) => {
    el.onclick = () => { activeConnectGuide = el.dataset.gid; renderConnectTabs(); renderConnectBody(); };
  });
}
function renderConnectBody() {
  const g = CONNECT_GUIDES.find((x) => x.id === activeConnectGuide);
  const body = document.getElementById("connectBody");
  const fieldsHtml = g.fields.map((f) =>
    "<div class=\"cg-field\"><span class=\"cg-name\">" + f[0] + "</span><span class=\"cg-type\">" + f[1] + "</span>" +
    "<span class=\"cg-desc\">" + f[2][LANG] + "</span></div>").join("");
  const stepsHtml = g.steps[LANG].map((s) => "<li>" + s + "</li>").join("");
  body.innerHTML =
    "<div class=\"kv\" style=\"margin-bottom:16px\">" +
    "<span class=\"k\">" + t("cgTarget") + "</span><span class=\"v hl\">" + g.tool + "</span>" +
    "<span class=\"k\">" + t("cgSchema") + "</span><span class=\"v\">" + g.schema + "</span></div>" +
    "<div class=\"cg-grid\">" +
    "<div><div class=\"cg-col-title\">" + t("cgRequired") + "</div>" + fieldsHtml + "</div>" +
    "<div><div class=\"cg-example-head\"><div class=\"cg-col-title\" style=\"margin:0\">" + t("cgExample") + "</div>" +
    "<span class=\"badge demo\">DEMO DATA</span></div>" + jsonHtml(g.example) + "</div></div>" +
    "<div class=\"cg-col-title\" style=\"margin-top:18px\">" + t("cgSteps") + "</div>" +
    "<ol class=\"cg-steps\">" + stepsHtml + "</ol>" +
    "<div class=\"cg-actions\">" +
    "<button class=\"btn quiet\" id=\"cgCopyBtn\">" + t("cgCopy") + "</button>" +
    "<button class=\"btn primary\" id=\"cgLoadBtn\">" + t("cgLoad") + "</button></div>";
  document.getElementById("cgCopyBtn").onclick = (ev) => copyConnectExample(g, ev.currentTarget);
  document.getElementById("cgLoadBtn").onclick = () => loadConnectExample(g);
}
function copyConnectExample(g, btn) {
  const text = JSON.stringify(g.example, null, 2);
  const flash = () => {
    const original = t("cgCopy");
    btn.textContent = t("cgCopied");
    btn.classList.add("copied-flash");
    setTimeout(() => { btn.textContent = original; btn.classList.remove("copied-flash"); }, 1400);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(flash, () => fallbackCopy(text, flash));
  } else {
    fallbackCopy(text, flash);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand("copy"); } catch (e) { /* clipboard unavailable */ }
  document.body.removeChild(ta);
  done();
}
function loadConnectExample(g) {
  closeConnectModal();
  setMode("raw");
  const matched = SCENARIOS.find((s) => JSON.stringify(s.event) === JSON.stringify(g.example));
  if (matched) { activeScenario = matched; renderScenarios(); }
  document.getElementById("eventEditor").value = JSON.stringify(g.example, null, 2);
  refreshFromInput();
  const el = document.getElementById("stageInput");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}
function openConnectModal() {
  renderConnectTabs();
  renderConnectBody();
  document.getElementById("connectOverlay").classList.remove("hidden");
}
function closeConnectModal() { document.getElementById("connectOverlay").classList.add("hidden"); }

/* ============================ quick nav ============================ */
function initQuicknav() {
  const nav = document.getElementById("quicknav");
  if (!nav) return;
  const buttons = Array.prototype.slice.call(nav.querySelectorAll("button"));
  buttons.forEach((b) => {
    b.onclick = () => {
      const el = document.getElementById(b.dataset.jump);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });
  const sections = buttons.map((b) => document.getElementById(b.dataset.jump));
  if (!("IntersectionObserver" in window)) return;
  const visible = new Set();
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const idx = sections.indexOf(entry.target);
      if (idx < 0) return;
      if (entry.isIntersecting) visible.add(idx); else visible.delete(idx);
    });
    if (!visible.size) return;
    const active = Math.min.apply(null, Array.from(visible));
    buttons.forEach((b, i) => b.classList.toggle("on", i === active));
  }, { root: document.getElementById("canvas"), threshold: 0.35 });
  sections.forEach((s) => { if (s) obs.observe(s); });
}

/* ============================ gauges ============================ */
function gaugeMetricHtml(k, vDisplay, value, max, threshold, bad, thresholdLabel) {
  const pct = Math.max(2, Math.min(100, (value / max) * 100));
  const tpct = Math.max(0, Math.min(100, (threshold / max) * 100));
  return "<div class=\"metric\"><div class=\"mk\">" + k + "</div><div class=\"mv " + (bad ? "critical" : "success") + "\">" + vDisplay + "</div>" +
    "<div class=\"gauge\"><div class=\"gauge-fill " + (bad ? "critical" : "success") + "\" style=\"width:" + pct + "%\"></div>" +
    "<div class=\"gauge-mark\" data-label=\"" + thresholdLabel + "\" style=\"left:" + tpct + "%\"></div></div></div>";
}

/* ============================ rendering: ribbon ============================ */
/* Event Flow language — section E of the brief: Producer Tool → Published Event →
   Event Broker / Ledger → Consuming Tool → Contract Validation → Handler Execution →
   Output Event → Downstream Consumers. Matches the broker model: tool publishes,
   platform stores/routes, our tool polls/consumes, our tool emits an output event. */
function renderRibbon() {
  const keys = t("ribbon");
  document.getElementById("ribbon").innerHTML = keys.map((k, i) =>
    (i > 0 ? "<span class=\"rarr\" id=\"ra" + i + "\">→</span>" : "") +
    "<div class=\"rnode\" id=\"rn" + i + "\"><div class=\"rk\">" + k + "</div><div class=\"rv\" id=\"rv" + i + "\">—</div></div>"
  ).join("");
}
function primeRibbon(event, targetKey) {
  const tool = TOOLS.find((tl) => tl.key === targetKey) || null;
  const set = (i, v) => { document.getElementById("rv" + i).innerHTML = v; };
  for (let i = 0; i < 8; i++) {
    const n = document.getElementById("rn" + i);
    n.className = "rnode";
    if (i > 0) document.getElementById("ra" + i).className = "rarr";
  }
  set(0, event ? (event.source || "manual") : "—");
  set(1, event ? event.type : "—");
  set(2, "event_ledger (mock broker)");
  set(3, tool ? tool.name : "—");
  set(4, "contracts/events");
  set(5, tool ? "handle()" : "—");
  set(6, "—"); set(7, "—");
  document.getElementById("flowSub").textContent = event && tool ? (event.source || "manual") + " → " + event.type + " → " + tool.name : "";
}

/* ============================ rendering: timeline ============================ */
function renderTimeline() {
  document.getElementById("timeline").innerHTML = t("ts").map((name, i) =>
    "<div class=\"tstep\" id=\"tl" + i + "\"><div class=\"tn\">0" + (i + 1) + "</div>" +
    "<div class=\"tt\">" + name + "</div><div class=\"ts\" id=\"tls" + i + "\">" + t("stPending") + "</div></div>").join("");
}
function setStep(i, state) {
  const el = document.getElementById("tl" + i);
  const st = document.getElementById("tls" + i);
  el.className = "tstep " + state;
  st.textContent = state === "running" ? t("stRunning") : state === "done" ? t("stOk") :
    state === "failed" ? t("stFail") : state === "warned" ? t("stWarn") : state === "skipped" ? t("stSkip") : t("stPending");
}

/* ============================ rendering: compatibility check stage ============================ */
const COMPAT_BADGE = {
  compatible: ["success", "cmpCompatible"],
  missing: ["verror", "cmpMissingData"],
  "not-consumable": ["critical", "cmpNotConsumable"],
  unconfirmed: ["confirm", "cmpNeedsConfirm"]
};
function renderCompatibility(event, targetKey) {
  const summary = document.getElementById("compatSummary");
  const list = document.getElementById("contractList");
  const missingList = document.getElementById("missingList");
  if (!event || !event.type) {
    summary.innerHTML = "";
    list.innerHTML = "<div class=\"insp-empty\">" + t("emptyContract") + "</div>";
    missingList.innerHTML = "";
    return { status: "missing", items: [], target: null, known: false, note: "" };
  }
  const check = computeCompatibility(event, targetKey);
  const badge = COMPAT_BADGE[check.status];
  const consumable = check.status === "compatible" || check.status === "missing";
  summary.innerHTML =
    "<div class=\"kv\">" +
    "<span class=\"k\">" + t("cmpSelectedEvent") + "</span><span class=\"v hl\">" + esc(event.type) + "</span>" +
    "<span class=\"k\">" + t("cmpTargetTool") + "</span><span class=\"v\">" + (check.target ? check.target.name : "—") + "</span>" +
    "<span class=\"k\">" + t("cmpConsumable") + "</span><span class=\"v\">" + (consumable ? t("cmpYes") : t("cmpNo")) + "</span>" +
    "</div>" +
    "<div class=\"compat-verdict\"><span class=\"badge " + badge[0] + "\">" + t(badge[1]) + "</span>" +
    (check.note ? "<span class=\"compat-note\">" + esc(check.note) + "</span>" : "") + "</div>";
  if (!check.items.length) {
    list.innerHTML = "<div class=\"insp-empty\">" + (consumable ? t("emptyContract") : t("notConsumableMsg")) + "</div>";
  } else {
    list.innerHTML = check.items.map((i) => {
      const cls = i.ok ? "ok" : "miss";
      const mark = i.ok ? "✓" : "✕";
      return "<div class=\"citem " + cls + "\"><span class=\"ck\">" + mark + "</span>" +
        "<span class=\"cf\">" + i.field + (i.optional ? " <small>· optional</small>" : "") + "</span><span class=\"cd\">" + i.detail + "</span></div>";
    }).join("");
  }
  if (!consumable) {
    missingList.innerHTML = "<div class=\"insp-empty\">" + t("notConsumableMsg") + "</div>";
    return check;
  }
  const missing = check.items.filter((i) => !i.ok && !i.optional);
  missingList.innerHTML = missing.length
    ? missing.map((i) => "<div class=\"citem miss\"><span class=\"ck\">✕</span><span class=\"cf\">" + i.field + "</span></div>").join("")
    : "<span class=\"badge success\">" + t("noneMissing") + "</span>";
  return check;
}
function renderLogicBox(event) {
  const tool = event ? EVENT_TO_TOOL[event.type] : null;
  const box = document.getElementById("logicBox");
  if (!tool) { box.innerHTML = ""; return; }
  const en = LANG === "en";
  if (tool.key === "cpk") {
    box.innerHTML =
      "<div class=\"lg-title\">" + (en ? "Handler logic (readable)" : "Lógica del handler (legible)") + "</div>" +
      "<span class=\"kw\">validate</span> measurements[≥2] · lsl · usl · target · lsl&lt;usl<br>" +
      "<span class=\"kw\">compute</span> mean, σ(sample) · Cp=(USL−LSL)/6σ · Cpk=min(CPU,CPL)<br>" +
      "<span class=\"kw\">emit</span> <span class=\"ev\">CAPABILITY_ANALYSIS_COMPLETED</span><br>" +
      "<span class=\"kw\">if</span> Cpk &lt; minimumCpk <span class=\"kw\">→ also emit</span> <span class=\"ev\">CAPABILITY_BELOW_TARGET</span><br>" +
      "<span class=\"kw\">if</span> " + (en ? "contract fails" : "el contrato falla") + " <span class=\"kw\">→</span> validation-error, " + (en ? "no invented result" : "no inventa resultado") +
      "<div class=\"src-note\">source: " + tool.src + " · IMPLEMENTED</div>";
  } else {
    box.innerHTML =
      "<div class=\"lg-title\">" + (en ? "Handler logic (readable)" : "Lógica del handler (legible)") + "</div>" +
      "<span class=\"ev\">MSA_STUDY_REQUESTED</span> <span class=\"kw\">→</span> " + (en ? "formal study path" : "vía de estudio formal") + "<br>" +
      "<span class=\"ev\">NEW_DEVICE_REGISTERED</span> " + (en ? "without observations" : "sin observations") + " <span class=\"kw\">→ warning</span>, " + (en ? "no analysis event" : "sin evento de análisis") + "<br>" +
      "<span class=\"kw\">validate</span> studyId · deviceId · observations{partId, operatorId, trial, value}<br>" +
      "<span class=\"kw\">compute</span> repeatability · reproducibility · GRR% · ndc<br>" +
      "<span class=\"kw\">acceptable if</span> GRR% ≤ 10 <span class=\"kw\">and</span> ndc ≥ 5<br>" +
      "<span class=\"kw\">emit</span> <span class=\"ev\">MSA_ANALYSIS_COMPLETED</span> + (<span class=\"ev\">MSA_VALIDATED</span> | <span class=\"ev\">MSA_NOT_ACCEPTABLE</span>)" +
      "<div class=\"src-note\">source: " + tool.src + " · IMPLEMENTED</div>";
  }
}

/* ============================ rendering: scenarios ============================ */
function renderScenarios() {
  const grid = document.getElementById("scenGrid");
  grid.innerHTML = SCENARIOS.map((s) => {
    const expCls = s.expect === "SUCCESS" ? "success" : s.expect === "CRITICAL" ? "critical" :
      s.expect === "WARNING" ? "warning" : "verror";
    return "<button type=\"button\" class=\"scen" + (s.id === activeScenario.id ? " on" : "") + "\" data-sid=\"" + s.id + "\">" +
      "<div class=\"s-tool\">" + (s.tool || "unmapped") + " · " + s.event.source + "</div>" +
      "<div class=\"s-name\">" + s.name[LANG] + "</div>" +
      "<div class=\"s-desc\">" + s.desc[LANG] + "</div>" +
      "<div class=\"s-badges\"><span class=\"badge demo\">DEMO DATA</span><span class=\"badge " + expCls + "\">" + s.expect + "</span>" +
      (s.needsConfirm ? "<span class=\"badge confirm\">NEEDS CARLOS CONFIRMATION</span>" : "") + "</div></button>";
  }).join("");
  Array.prototype.forEach.call(grid.querySelectorAll(".scen"), (el) => {
    el.onclick = () => {
      activeScenario = SCENARIOS.find((s) => s.id === el.dataset.sid);
      loadScenarioIntoEditor();
      renderScenarios();
    };
  });
}
function loadScenarioIntoEditor() {
  document.getElementById("eventEditor").value = JSON.stringify(activeScenario.event, null, 2);
  refreshFromInput();
}

/* ============================ current event builders ============================ */
function parseEditor() {
  const ta = document.getElementById("eventEditor");
  const hint = document.getElementById("editorHint");
  try {
    const ev = JSON.parse(ta.value);
    ta.classList.remove("invalid");
    hint.className = "editor-hint";
    hint.textContent = t("editorHint");
    return ev;
  } catch (e) {
    ta.classList.add("invalid");
    hint.className = "editor-hint err";
    hint.textContent = "JSON: " + e.message;
    return null;
  }
}
function numOrUndef(id) {
  const raw = document.getElementById(id).value.trim();
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
function val(id) { return document.getElementById(id).value.trim(); }
function buildManualEvent() {
  if (activeManualTab === "cpk") {
    const meas = val("c_meas").split(/[\s,;]+/).filter(Boolean).map(Number);
    return { type: "MEASUREMENTS_CAPTURED", source: val("c_source") || "manual_quality_input",
      payload: { measurementSetId: val("c_setId") || undefined, partNumber: val("c_part") || undefined,
        characteristic: val("c_char") || undefined,
        measurements: meas.length ? meas : undefined,
        lsl: numOrUndef("c_lsl"), usl: numOrUndef("c_usl"), target: numOrUndef("c_target"),
        minimumCpk: numOrUndef("c_minCpk") } };
  }
  if (activeManualTab === "msa") {
    let obs;
    try { obs = JSON.parse(val("m_obs")); } catch (e) { obs = undefined; }
    return { type: "MSA_STUDY_REQUESTED", source: val("m_source") || "manual_msa_input",
      payload: { studyId: val("m_study") || undefined, deviceId: val("m_device") || undefined,
        partNumber: val("m_part") || undefined, tolerance: numOrUndef("m_tolerance"), observations: obs } };
  }
  return { type: "NEW_DEVICE_REGISTERED", source: val("d_source") || "manage_device_registry",
    payload: { deviceId: val("d_device") || undefined, deviceType: val("d_type") || undefined,
      calibrationStatus: val("d_cal") || undefined, registeredBy: val("d_by") || undefined,
      registrationDate: val("d_date") || undefined } };
}
/* external tool event mode — assembled from the Source/Owner/Event Type/Target selects
   plus a payload-only textarea, mirroring the "connect a tool" fields (section A). */
function parseExtPayload() {
  const ta = document.getElementById("extPayload");
  const hint = document.getElementById("extPayloadHint");
  try {
    const payload = JSON.parse(ta.value || "{}");
    ta.classList.remove("invalid");
    hint.className = "editor-hint";
    hint.textContent = t("editorHint");
    return payload;
  } catch (e) {
    ta.classList.add("invalid");
    hint.className = "editor-hint err";
    hint.textContent = "JSON: " + e.message;
    return null;
  }
}
function buildExternalEvent() {
  const payload = parseExtPayload();
  if (payload === null) return null;
  return { type: extState.eventType, source: extState.source, owner: extState.owner || undefined, payload };
}
function currentEvent() {
  if (mode === "external") return buildExternalEvent();
  if (mode === "manual") return buildManualEvent();
  return parseEditor();
}
function currentTool() {
  if (mode === "external") return TOOLS.find((tl) => tl.key === extState.targetKey) || null;
  const ev = mode === "manual"
    ? buildManualEvent()
    : (function () { try { return JSON.parse(document.getElementById("eventEditor").value); } catch (e) { return activeScenario.event; } })();
  return ev ? (EVENT_TO_TOOL[ev.type] || null) : null;
}
function currentTargetKey() {
  if (mode === "external") return extState.targetKey;
  const tool = currentTool();
  return tool ? tool.key : null;
}
function currentCorrId() {
  if (mode === "external") return val("ext_corr") || null;
  if (mode === "manual") {
    const id = activeManualTab === "cpk" ? val("c_corr") : activeManualTab === "msa" ? val("m_corr") : val("d_corr");
    return id || null;
  }
  return null;
}

/* refresh compatibility + ribbon + logic from whatever input is active */
function refreshFromInput() {
  const ev = currentEvent();
  const targetKey = currentTargetKey();
  primeRibbon(ev, targetKey);
  renderCompatibility(ev, targetKey);
  renderLogicBox(ev);
  renderRegistry();
}

/* ============================ inspector ============================ */
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
function kvHtml(obj) {
  return "<div class=\"kv\">" + Object.entries(obj).map(([k, v]) =>
    "<span class=\"k\">" + esc(k) + "</span><span class=\"v" + (k === "type" || k === "correlationId" ? " hl" : "") + "\">" + esc(v) + "</span>").join("") + "</div>";
}
function jsonHtml(obj) {
  const s = esc(JSON.stringify(obj, null, 2));
  return "<pre class=\"json\">" + s
    .replace(/"([^"]+)":/g, "<span class=\"jk\">\"$1\"</span>:")
    .replace(/: "([^"]*)"/g, ": <span class=\"js\">\"$1\"</span>")
    .replace(/: (-?\d[\d.]*)/g, ": <span class=\"jn\">$1</span>") + "</pre>";
}
function clearInspector() {
  const ids = ["iEvent", "iPayload", "iRequired", "iMissing", "iResult", "iEmitted", "iJson", "iEvidence"];
  ids.forEach((id, i) => {
    const el = document.getElementById(id);
    el.className = "insp-empty";
    el.textContent = i === 0 ? t("emptyInsp") : "—";
  });
  document.getElementById("inspCorr").textContent = "";
}
function paintInspector(ctx) {
  const ids = ["iEvent", "iPayload", "iRequired", "iMissing", "iResult", "iEmitted", "iJson", "iEvidence"];
  ids.forEach((id) => { document.getElementById(id).className = ""; });
  document.getElementById("inspCorr").textContent = ctx.corr;
  document.getElementById("iEvent").innerHTML = kvHtml({
    type: ctx.event.type, sourceTool: ctx.event.source || "manual",
    eventId: ctx.eventId, correlationId: ctx.corr, causationId: ctx.cause, occurredAt: ctx.ts
  });
  document.getElementById("iPayload").innerHTML = jsonHtml(ctx.event.payload || {});
  document.getElementById("iRequired").innerHTML = ctx.contract.items.map((i) =>
    "<div class=\"citem " + (i.ok ? "ok" : (i.warn ? "warn" : "miss")) + "\"><span class=\"ck\">" + (i.ok ? "✓" : (i.warn ? "!" : "✕")) + "</span>" +
    "<span class=\"cf\">" + esc(i.field) + "</span></div>").join("");
  const missing = (ctx.outcome.details || []).length ? ctx.outcome.details :
    ctx.contract.items.filter((i) => !i.ok).map((i) => i.field);
  document.getElementById("iMissing").innerHTML = missing.length
    ? missing.map((m) => "<div class=\"citem miss\"><span class=\"ck\">✕</span><span class=\"cf\">" + esc(m) + "</span></div>").join("")
    : "<span class=\"badge success\">" + t("noneMissing") + "</span>";
  const o = ctx.outcome;
  document.getElementById("iResult").innerHTML =
    "<div style=\"margin-bottom:8px\"><span class=\"badge " + ctx.statusCls + "\">" + ctx.statusLabel + "</span></div>" +
    (o.result ? kvHtml(o.result) : "<div class=\"kv\"><span class=\"k\">message</span><span class=\"v\">" + esc(o.message || "") + "</span></div>");
  document.getElementById("iEmitted").innerHTML = o.emittedEvents.length
    ? o.emittedEvents.map((e) => "<div style=\"padding:3px 0\"><span class=\"evchip " + (e.type.indexOf("BELOW") >= 0 || e.type.indexOf("NOT_") >= 0 ? "alert" : "produces") + "\">" + e.type + "</span></div>").join("")
    : "<span class=\"insp-empty\">— (" + (o.status === "warning" ? "warning path" : "validation-error") + ": no analysis event)</span>";
  document.getElementById("iJson").innerHTML = jsonHtml(o);
  document.getElementById("iEvidence").innerHTML = "<div class=\"evidence\">" +
    t("evidence").map((l) => "<span class=\"" + (l[0] === "ok" ? "ok" : "") + "\">" + (l[0] === "ok" ? "✓" : "◦") + "</span> " + esc(l[1]) + "<br>").join("") + "</div>";
}

/* ============================ output stage ============================ */
function verdictInfo(outcome, toolKey) {
  if (outcome.status === "not-consumable") return { label: t("cmpNotConsumable"), cls: "critical", chip: "verror", chipLabel: t("cmpNotConsumable") };
  if (outcome.status === "unconfirmed") return { label: t("cmpNeedsConfirm"), cls: "warning", chip: "confirm", chipLabel: t("cmpNeedsConfirm") };
  if (outcome.status === "validation-error") return { label: t("verdictVError"), cls: "critical", chip: "verror", chipLabel: t("runVError") };
  if (outcome.status === "warning") return { label: t("verdictWarning"), cls: "warning", chip: "warning", chipLabel: t("runWarning") };
  const v = outcome.result.verdict;
  if (v === "capable") return { label: t("verdictCapable"), cls: "success", chip: "success", chipLabel: t("runSuccess") };
  if (v === "below-target") return { label: t("verdictBelow"), cls: "critical", chip: "critical", chipLabel: t("runCritical") };
  if (v === "acceptable") return { label: t("verdictAcceptable"), cls: "success", chip: "success", chipLabel: t("runSuccess") };
  return { label: t("verdictNotAcceptable"), cls: "critical", chip: "critical", chipLabel: t("runCritical") };
}
function metricHtml(k, v, cls) {
  return "<div class=\"metric\"><div class=\"mk\">" + k + "</div><div class=\"mv " + (cls || "") + "\">" + v + "</div></div>";
}
function paintResultCard(outcome, toolKey, vi) {
  const card = document.getElementById("resultCard");
  if (outcome.status !== "completed") {
    card.innerHTML =
      "<div class=\"result-verdict-row\"><span class=\"verdict-big " + vi.cls + "\">" + vi.label + "</span>" +
      "<span class=\"badge " + vi.chip + "\">" + vi.chipLabel + "</span></div>" +
      "<div class=\"kv\" style=\"margin-bottom:10px\"><span class=\"k\">message</span><span class=\"v\">" + esc(outcome.message) + "</span></div>" +
      (outcome.details && outcome.details.length
        ? outcome.details.map((d) => "<div class=\"citem miss\"><span class=\"ck\">✕</span><span class=\"cf\">" + esc(d) + "</span></div>").join("")
        : "") +
      "<div class=\"recommendation\">" + esc(outcome.recommendation) + "</div>" +
      "<div class=\"empty-note\" style=\"margin-top:8px\">" + t("stoppedAt") + "</div>";
    return;
  }
  const r = outcome.result;
  let metrics = "";
  if (toolKey === "cpk") {
    const bad = r.verdict === "below-target";
    metrics =
      metricHtml("Cp", r.cp) +
      gaugeMetricHtml("Cpk", r.cpk + " <small>min " + r.minimumCpk + "</small>", r.cpk, 2.5, r.minimumCpk, bad, "min " + r.minimumCpk) +
      metricHtml(t("mean"), r.mean) +
      metricHtml(t("stddev"), r.standardDeviation) +
      metricHtml(t("sample"), r.sampleSize) +
      metricHtml(t("verdict"), vi.label, bad ? "critical" : "success");
  } else {
    const bad = r.verdict === "not-acceptable";
    metrics =
      gaugeMetricHtml(t("grr"), r.gageRRPercent + "%", r.gageRRPercent, 30, 10, r.gageRRPercent > 10, "≤10%") +
      metricHtml(t("repeat"), r.repeatability) +
      metricHtml(t("repro"), r.reproducibility) +
      gaugeMetricHtml("ndc", r.ndc + " <small>≥5</small>", r.ndc, 10, 5, r.ndc < 5, "≥5") +
      metricHtml("Study", esc(r.studyId || "—")) +
      metricHtml(t("verdict"), vi.label, bad ? "critical" : "success");
  }
  card.innerHTML =
    "<div class=\"result-verdict-row\"><span class=\"verdict-big " + vi.cls + "\">" + vi.label + "</span>" +
    "<span class=\"badge " + vi.chip + "\">" + vi.chipLabel + "</span>" +
    (outcome.compatibilityPath ? "<span class=\"badge warning\">COMPATIBILITY PATH</span>" : "") + "</div>" +
    "<div class=\"metric-grid\">" + metrics + "</div>" +
    "<div class=\"recommendation\">" + esc(outcome.recommendation) + "</div>";
}
function paintEmitted(outcome) {
  const list = document.getElementById("emitList");
  if (!outcome.emittedEvents.length) {
    const msg = outcome.status === "not-consumable" || outcome.status === "unconfirmed"
      ? (LANG === "en" ? "No handler was called — this event was never routed to a tool." : "No se llamó a ningún handler — este evento nunca se ruteó a una tool.")
      : outcome.status === "warning"
      ? (LANG === "en" ? "No analysis event emitted — the handler recommends creating MSA_STUDY_REQUESTED." : "No se emitió evento de análisis — el handler recomienda crear MSA_STUDY_REQUESTED.")
      : (LANG === "en" ? "No event emitted — contract not satisfied, nothing invented." : "No se emitió evento — contrato no satisfecho, nada inventado.");
    list.innerHTML = "<div class=\"empty-note\">" + msg + "</div>";
    return;
  }
  list.innerHTML = outcome.emittedEvents.map((e) => {
    const routes = (ROUTING[e.type] || []).map((r) =>
      "<span class=\"peer " + r[1] + "\">" + r[0] + "</span>" +
      "<span class=\"badge " + (r[1] === "future" ? "future" : "confirm") + "\">" + (r[1] === "future" ? "FUTURE ADAPTER" : "NEEDS CARLOS CONFIRMATION") + "</span>"
    ).join("<span class=\"earrow\">·</span>");
    return "<div class=\"emit-row\"><span class=\"evchip " + (e.type.indexOf("BELOW") >= 0 || e.type.indexOf("NOT_") >= 0 ? "alert" : "produces") + "\">" + e.type + "</span>" +
      "<span class=\"earrow\">→</span>" + (routes || "<span class=\"empty-note\">—</span>") + "</div>";
  }).join("");
}
function paintDashboards(outcome, toolKey, vi) {
  const isCpk = toolKey === "cpk";
  const dash = document.getElementById(isCpk ? "dashCpk" : "dashMsa");
  const state = document.getElementById(isCpk ? "cpkState" : "msaState");
  const rec = document.getElementById(isCpk ? "cpkRec" : "msaRec");
  const emits = document.getElementById(isCpk ? "cpkEmits" : "msaEmits");
  const grid = document.getElementById(isCpk ? "cpkMetrics" : "msaMetrics");
  dash.classList.remove("dimmed");
  state.className = "badge " + vi.chip;
  state.textContent = vi.chipLabel;
  rec.innerHTML = "<b>" + (LANG === "en" ? "Recommendation:" : "Recomendación:") + "</b> " + esc(outcome.recommendation);
  emits.innerHTML = outcome.emittedEvents.length
    ? outcome.emittedEvents.map((e) => "<span class=\"evchip " + (e.type.indexOf("BELOW") >= 0 || e.type.indexOf("NOT_") >= 0 ? "alert" : "produces") + "\">" + e.type + "</span>").join("")
    : "<span class=\"insp-empty\">" + (LANG === "en" ? "no events emitted" : "sin eventos emitidos") + "</span>";
  if (outcome.status !== "completed") {
    grid.innerHTML = metricHtml(t("verdict"), vi.label, "critical");
    return;
  }
  const r = outcome.result;
  grid.innerHTML = isCpk
    ? metricHtml("Cp", r.cp) + gaugeMetricHtml("Cpk", r.cpk, r.cpk, 2.5, r.minimumCpk, r.verdict !== "capable", "min " + r.minimumCpk) +
      metricHtml(t("mean"), r.mean) + metricHtml(t("stddev"), r.standardDeviation) +
      metricHtml(t("sample"), r.sampleSize) + metricHtml(t("verdict"), vi.label, r.verdict === "capable" ? "success" : "critical")
    : gaugeMetricHtml(t("grr"), r.gageRRPercent + "%", r.gageRRPercent, 30, 10, r.gageRRPercent > 10, "≤10%") +
      metricHtml(t("repeat"), r.repeatability) + metricHtml(t("repro"), r.reproducibility) +
      gaugeMetricHtml("ndc", r.ndc, r.ndc, 10, 5, r.ndc < 5, "≥5") +
      metricHtml("Study", esc(r.studyId || "—")) + metricHtml(t("verdict"), vi.label, r.verdict === "acceptable" ? "success" : "critical");
}

/* ============================ run engine ============================ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = false;
function setRunChip(cls, label) {
  const chip = document.getElementById("runChip");
  chip.className = "run-chip " + cls;
  chip.textContent = label;
}
async function run() {
  if (running) return;
  const event = currentEvent();
  if (!event) return; /* invalid JSON — hint already shown */
  running = true;
  document.getElementById("btnRun").disabled = true;

  const targetKey = currentTargetKey();
  const tool = TOOLS.find((tl) => tl.key === targetKey) || TOOLS[0];
  const corr = currentCorrId() || newCorrId();
  const eventId = newEventId();
  const ts = nowTs();
  document.getElementById("corrChip").textContent = "corr: " + corr;
  setRunChip("running", t("runRunning"));
  renderTimeline();
  primeRibbon(event, targetKey);
  const compat = renderCompatibility(event, targetKey);
  renderLogicBox(event);

  const blocked = compat.status === "not-consumable" || compat.status === "unconfirmed";
  /* Blocked events (unknown event type, or a known type sent to the wrong target tool)
     never reach a handler — there is no real mapping to call, so this never invents
     a result the way a real broker with no matching consumer never would either. */
  const outcome = blocked
    ? { ok: false, status: compat.status, message: compat.note || t("notConsumableMsg"), details: [], emittedEvents: [],
        recommendation: compat.status === "unconfirmed" ? t("cmpNeedsConfirm") : t("notConsumableMsg") }
    : tool.handler(event);
  const vi = verdictInfo(outcome, tool.key);
  const failed = blocked || outcome.status === "validation-error";
  const warned = !blocked && outcome.status === "warning";

  const lit = (i, v) => {
    document.getElementById("rn" + i).classList.add("lit");
    if (i > 0) document.getElementById("ra" + i).classList.add("lit");
    if (v !== undefined) document.getElementById("rv" + i).innerHTML = v;
  };
  const mark = (i, cls) => { document.getElementById("rn" + i).classList.add(cls); };

  /* step 1 — event received: Producer Tool + Published Event */
  setStep(0, "running"); lit(0); lit(1); await sleep(360); setStep(0, "done");
  /* step 2 — payload loaded: Event Broker / Ledger */
  setStep(1, "running"); lit(2); await sleep(360); setStep(1, "done");
  /* step 3 — contract validated: Consuming Tool + Contract Validation */
  setStep(2, "running"); lit(3); lit(4); await sleep(430);
  if (failed) {
    setStep(2, "failed"); mark(4, "err");
    for (let i = 3; i < 8; i++) setStep(i, "skipped");
  } else if (warned) {
    setStep(2, "warned"); mark(4, "warn");
    for (let i = 3; i < 8; i++) setStep(i, "skipped");
  } else {
    setStep(2, "done");
    /* step 4 — handler executed: Handler Execution */
    setStep(3, "running"); lit(5); await sleep(400); setStep(3, "done");
    /* step 5 — result produced: Handler Execution value updated with the number */
    setStep(4, "running");
    lit(5, tool.key === "cpk" ? "handle() → Cpk " + outcome.result.cpk : "handle() → GRR " + outcome.result.gageRRPercent + "%");
    await sleep(360); setStep(4, "done");
    /* step 6 — events emitted: Output Event */
    setStep(5, "running"); lit(6, outcome.emittedEvents.map((e) => e.type).join("<br>")); await sleep(360); setStep(5, "done");
    /* step 7 — ledger updated: Event Broker / Ledger, again */
    setStep(6, "running"); lit(2, "event_ledger (mock broker) · updated"); await sleep(320); setStep(6, "done");
    /* step 8 — downstream routing evaluated: Downstream Consumers */
    setStep(7, "running");
    const consumers = [];
    outcome.emittedEvents.forEach((e) => (ROUTING[e.type] || []).forEach((r) => {
      if (consumers.indexOf(r[0]) < 0) consumers.push(r[0]);
    }));
    lit(7, consumers.join("<br>") || "—");
    await sleep(320); setStep(7, "done");
  }

  /* ledger row (in-memory; PostgreSQL-ready columns) */
  const consumers = [];
  outcome.emittedEvents.forEach((e) => (ROUTING[e.type] || []).forEach((r) => {
    if (consumers.indexOf(r[0]) < 0) consumers.push(r[0] + (r[1] === "future" ? " (future)" : ""));
  }));
  const stLabel = blocked
    ? (compat.status === "unconfirmed" ? "NEEDS CONFIRMATION" : "NOT CONSUMABLE")
    : (vi.chipLabel === t("runSuccess") ? "SUCCESS" : vi.chipLabel === t("runCritical") ? "CRITICAL" :
       vi.chipLabel === t("runWarning") ? "WARNING" : "VALIDATION ERROR");
  appendLedger({
    id: nextLedgerId++, ts, corr, cause: eventId,
    src: event.source || "manual", ev: event.type, tgt: tool.name,
    st: stLabel,
    em: outcome.emittedEvents.map((e) => e.type).join(", ") || "—",
    dc: consumers.join(", ") || "—"
  });

  paintResultCard(outcome, tool.key, vi);
  paintEmitted(outcome);
  if (!blocked) paintDashboards(outcome, tool.key, vi);
  paintInspector({
    event, corr, cause: eventId, eventId, ts, contract: compat, outcome,
    statusCls: vi.chip, statusLabel: vi.chipLabel
  });
  setRunChip(vi.chip, vi.chipLabel);

  running = false;
  document.getElementById("btnRun").disabled = false;
}

/* ============================ mode & wiring ============================ */
function setMode(next) {
  mode = next;
  document.getElementById("modeExternal").classList.toggle("on", mode === "external");
  document.getElementById("modeManual").classList.toggle("on", mode === "manual");
  document.getElementById("modeRaw").classList.toggle("on", mode === "raw");
  document.getElementById("externalInput").classList.toggle("hidden", mode !== "external");
  document.getElementById("manualInput").classList.toggle("hidden", mode !== "manual");
  document.getElementById("rawInput").classList.toggle("hidden", mode !== "raw");
  document.getElementById("btnRun").innerHTML = mode === "external" ? t("btnRunExternal") : mode === "manual" ? t("btnRunManual") : t("btnRunRaw");
  document.getElementById("execNote").textContent = mode === "external" ? t("execNoteExternal") : mode === "manual" ? t("execNoteManual") : t("execNoteRaw");
  refreshFromInput();
}
/* ============================ external tool event mode ============================ */
function populateExtSourceOptions() {
  const sel = document.getElementById("ext_source");
  const opts = SOURCE_OPTIONS[extState.targetKey] || SOURCE_OPTIONS.cpk;
  if (opts.indexOf(extState.source) < 0) extState.source = opts[0];
  sel.innerHTML = opts.map((o) => "<option" + (o === extState.source ? " selected" : "") + ">" + o + "</option>").join("");
}
function syncExtFormFromState() {
  document.getElementById("ext_target").value = extState.targetKey;
  populateExtSourceOptions();
  document.getElementById("ext_eventType").value = extState.eventType;
  document.getElementById("ext_owner").value = extState.owner;
  document.getElementById("ext_corr").value = extState.corr;
}
function renderExtExamples() {
  document.getElementById("extExamples").innerHTML = SCENARIOS.map((s) => {
    const expCls = s.expect === "SUCCESS" ? "success" : s.expect === "CRITICAL" ? "critical" :
      s.expect === "WARNING" ? "warning" : "verror";
    return "<button type=\"button\" class=\"scen" + (s.id === activeScenario.id ? " on" : "") + "\" data-sid=\"" + s.id + "\">" +
      "<div class=\"s-tool\">" + (s.tool || "unmapped") + " · " + s.event.source + "</div>" +
      "<div class=\"s-name\">" + s.name[LANG] + "</div>" +
      "<div class=\"s-desc\">" + s.desc[LANG] + "</div>" +
      "<div class=\"s-badges\"><span class=\"badge demo\">DEMO DATA</span><span class=\"badge " + expCls + "\">" + s.expect + "</span>" +
      (s.needsConfirm ? "<span class=\"badge confirm\">NEEDS CARLOS CONFIRMATION</span>" : "") + "</div></button>";
  }).join("");
  Array.prototype.forEach.call(document.getElementById("extExamples").querySelectorAll(".scen"), (el) => {
    el.onclick = () => loadExtExample(el.dataset.sid);
  });
}
function loadExtExample(sid) {
  const s = SCENARIOS.find((x) => x.id === sid);
  if (!s) return;
  activeScenario = s;
  extState.source = s.event.source;
  extState.owner = s.owner || "";
  extState.eventType = s.event.type;
  extState.targetKey = s.targetKey || extState.targetKey;
  extState.corr = "";
  syncExtFormFromState();
  document.getElementById("ext_source").value = extState.source;
  document.getElementById("extPayload").value = JSON.stringify(s.event.payload || {}, null, 2);
  renderExtExamples();
  refreshFromInput();
}
/* ============================ raw JSON event mode ============================ */
function renderRawExampleSelect() {
  const sel = document.getElementById("rawExampleSelect");
  if (!sel) return;
  sel.innerHTML = SCENARIOS.map((s) => "<option value=\"" + s.id + "\">" + s.name[LANG] + "</option>").join("");
  sel.value = activeScenario.id;
}
function setManualTab(tab) {
  activeManualTab = tab;
  Array.prototype.forEach.call(document.querySelectorAll(".mtab"), (el) => {
    el.classList.toggle("on", el.dataset.mtab === tab);
  });
  document.getElementById("formCpk").classList.toggle("show", tab === "cpk");
  document.getElementById("formMsa").classList.toggle("show", tab === "msa");
  document.getElementById("formDev").classList.toggle("show", tab === "dev");
  refreshFromInput();
}
function resetAll() {
  renderTimeline();
  clearInspector();
  document.getElementById("resultCard").innerHTML = "<div class=\"empty-note\">" + t("emptyResult") + "</div>";
  document.getElementById("emitList").innerHTML = "<div class=\"empty-note\">" + t("emptyEmit") + "</div>";
  ["dashCpk", "dashMsa"].forEach((id) => document.getElementById(id).classList.add("dimmed"));
  ["cpkState", "msaState"].forEach((id) => {
    const el = document.getElementById(id);
    el.className = "badge neutral";
    el.textContent = t("awaiting");
  });
  ["cpkRec", "msaRec"].forEach((id) => { document.getElementById(id).textContent = t("noRun"); });
  ["cpkMetrics", "msaMetrics"].forEach((id) => { document.getElementById(id).innerHTML = ""; });
  ["cpkEmits", "msaEmits"].forEach((id) => { document.getElementById(id).innerHTML = ""; });
  document.getElementById("corrChip").textContent = "corr: —";
  setRunChip("", t("runIdle"));
  refreshFromInput();
}

/* language */
function applyLang() {
  Array.prototype.forEach.call(document.querySelectorAll("[data-i18n]"), (el) => {
    const v = t(el.dataset.i18n);
    if (typeof v === "string") el.innerHTML = v;
  });
  document.getElementById("langEn").classList.toggle("on", LANG === "en");
  document.getElementById("langEs").classList.toggle("on", LANG === "es");
  renderScenarios();
  renderExtExamples();
  renderRawExampleSelect();
  renderRibbon();
  renderTimeline();
  refreshFromInput();
  document.getElementById("btnRun").innerHTML = mode === "external" ? t("btnRunExternal") : mode === "manual" ? t("btnRunManual") : t("btnRunRaw");
  document.getElementById("execNote").textContent = mode === "external" ? t("execNoteExternal") : mode === "manual" ? t("execNoteManual") : t("execNoteRaw");
}

/* theme */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("qtw-theme", theme); } catch (e) { /* file:// private mode */ }
}

/* ============================ boot ============================ */
document.getElementById("btnRun").onclick = run;
document.getElementById("btnReset").onclick = resetAll;
document.getElementById("modeExternal").onclick = () => setMode("external");
document.getElementById("modeManual").onclick = () => setMode("manual");
document.getElementById("modeRaw").onclick = () => setMode("raw");
document.getElementById("langEn").onclick = () => { LANG = "en"; applyLang(); };
document.getElementById("langEs").onclick = () => { LANG = "es"; applyLang(); };
document.getElementById("themeBtn").onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(cur);
};
Array.prototype.forEach.call(document.querySelectorAll(".mtab"), (el) => {
  el.onclick = () => setManualTab(el.dataset.mtab);
});
document.getElementById("eventEditor").addEventListener("input", refreshFromInput);
document.getElementById("manualInput").addEventListener("input", refreshFromInput);
document.getElementById("btnConnect").onclick = openConnectModal;
document.getElementById("connectClose").onclick = closeConnectModal;
document.getElementById("connectOverlay").addEventListener("click", (e) => {
  if (e.target.id === "connectOverlay") closeConnectModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("connectOverlay").classList.contains("hidden")) closeConnectModal();
});

/* external tool event mode wiring */
document.getElementById("ext_target").onchange = (e) => {
  extState.targetKey = e.target.value;
  populateExtSourceOptions();
  extState.source = document.getElementById("ext_source").value;
  refreshFromInput();
};
document.getElementById("ext_source").onchange = (e) => {
  extState.source = e.target.value;
  if (e.target.value === "manage_nonconformance") {
    extState.owner = "Demian";
    document.getElementById("ext_owner").value = "Demian";
  }
  refreshFromInput();
};
document.getElementById("ext_eventType").onchange = (e) => { extState.eventType = e.target.value; refreshFromInput(); };
document.getElementById("ext_owner").addEventListener("input", (e) => { extState.owner = e.target.value; refreshFromInput(); });
document.getElementById("ext_corr").addEventListener("input", (e) => { extState.corr = e.target.value; });
document.getElementById("extPayload").addEventListener("input", refreshFromInput);

/* raw JSON event mode wiring */
document.getElementById("btnValidate").onclick = () => {
  const msg = document.getElementById("rawValidateMsg");
  const ev = parseEditor();
  refreshFromInput();
  if (!ev) { msg.textContent = t("validateBad"); msg.className = "exec-note err"; return; }
  msg.textContent = t("validateOk");
  msg.className = "exec-note ok";
};
document.getElementById("btnResetPayload").onclick = () => {
  document.getElementById("eventEditor").value = "{\n\n}";
  document.getElementById("rawValidateMsg").textContent = "";
  refreshFromInput();
};
document.getElementById("btnLoadExample").onclick = () => {
  const sid = document.getElementById("rawExampleSelect").value;
  activeScenario = SCENARIOS.find((s) => s.id === sid) || SCENARIOS[0];
  loadScenarioIntoEditor();
  renderScenarios();
  document.getElementById("rawValidateMsg").textContent = "";
};

try {
  const saved = localStorage.getItem("qtw-theme");
  if (saved) applyTheme(saved);
} catch (e) { /* ignore */ }

renderRibbon();
renderTimeline();
renderScenarios();
renderExtExamples();
renderRawExampleSelect();
syncExtFormFromState();
seedLedger();
loadScenarioIntoEditor();
loadExtExample(SCENARIOS[0].id);
setMode("external");
setRunChip("", t("runIdle"));
initQuicknav();
