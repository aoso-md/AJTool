"use strict";

function round(value, decimals = 4) {
  return Number(value.toFixed(decimals));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function buildEvent(type, payload, official) {
  return {
    type,
    source: "run-msa-analysis",
    occurredAt: new Date().toISOString(),
    official: !!official,
    payload
  };
}

function validationError(message, details) {
  return {
    ok: false,
    status: "validation-error",
    message,
    details,
    emittedEvents: [],
    recommendation: "Request a formal MSA study with device ID and repeated observations by part, operator, and trial."
  };
}

function warning(message, details) {
  return {
    ok: false,
    status: "warning",
    message,
    details,
    emittedEvents: [],
    recommendation: "Create an MSA_STUDY_REQUESTED event after collecting repeated device observations."
  };
}

function normalizeEvent(event) {
  if (!event || !event.type) {
    return { error: validationError("Missing event type.", ["type is required"]) };
  }

  if (event.type === "MSA_STUDY_REQUESTED") {
    return { payload: event.payload || {}, compatibilityPath: false };
  }

  if (event.type === "NEW_DEVICE_REGISTERED") {
    const payload = event.payload || {};
    if (!Array.isArray(payload.observations) || payload.observations.length === 0) {
      return {
        error: warning("NEW_DEVICE_REGISTERED does not include observations for MSA.", ["observations are required for analysis"])
      };
    }
    return {
      payload: {
        studyId: payload.studyId || `MSA-${payload.deviceId || "unknown"}`,
        deviceId: payload.deviceId,
        partNumber: payload.partNumber,
        observations: payload.observations
      },
      compatibilityPath: true
    };
  }

  return { error: validationError("Unsupported event type.", ["expected MSA_STUDY_REQUESTED or NEW_DEVICE_REGISTERED"]) };
}

function validatePayload(payload) {
  const details = [];
  if (!payload.studyId) details.push("studyId is required");
  if (!payload.deviceId) details.push("deviceId is required");
  if (!Array.isArray(payload.observations) || payload.observations.length < 2) {
    details.push("observations must contain at least two rows");
  } else {
    for (const [index, observation] of payload.observations.entries()) {
      for (const field of ["partId", "operatorId", "trial"]) {
        if (observation[field] === undefined || observation[field] === null || observation[field] === "") {
          details.push(`observations[${index}].${field} is required`);
        }
      }
      if (!Number.isFinite(observation.value)) {
        details.push(`observations[${index}].value must be numeric`);
      }
    }
  }

  return details.length ? validationError("MSA analysis cannot run with incomplete study data.", details) : null;
}

function groupedStandardDeviation(observations, keyBuilder) {
  const groups = new Map();
  for (const observation of observations) {
    const key = keyBuilder(observation);
    const values = groups.get(key) || [];
    values.push(observation.value);
    groups.set(key, values);
  }

  const deviations = Array.from(groups.values())
    .filter((values) => values.length > 1)
    .map((values) => sampleStandardDeviation(values));

  return deviations.length ? mean(deviations) : 0;
}

function analyze(payload) {
  const observations = payload.observations;
  const values = observations.map((observation) => observation.value);
  const totalVariation = sampleStandardDeviation(values);
  const repeatability = groupedStandardDeviation(observations, (observation) => `${observation.partId}:${observation.operatorId}`);
  const operatorMeans = new Map();

  for (const observation of observations) {
    const valuesForOperator = operatorMeans.get(observation.operatorId) || [];
    valuesForOperator.push(observation.value);
    operatorMeans.set(observation.operatorId, valuesForOperator);
  }

  const operatorMeanValues = Array.from(operatorMeans.values()).map((operatorValues) => mean(operatorValues));
  const reproducibility = sampleStandardDeviation(operatorMeanValues);
  const gageRR = Math.sqrt(Math.pow(repeatability, 2) + Math.pow(reproducibility, 2));
  const gageRRPercent = totalVariation === 0 ? 100 : (gageRR / totalVariation) * 100;
  const partMeans = Array.from(new Set(observations.map((observation) => observation.partId))).map((partId) => {
    return mean(observations.filter((observation) => observation.partId === partId).map((observation) => observation.value));
  });
  const partVariation = sampleStandardDeviation(partMeans);
  const ndc = gageRR === 0 ? 0 : Math.floor(1.41 * (partVariation / gageRR));
  const acceptable = gageRRPercent <= 10 && ndc >= 5;

  return {
    studyId: payload.studyId,
    deviceId: payload.deviceId,
    partNumber: payload.partNumber,
    gageRRPercent: round(gageRRPercent),
    repeatability: round(repeatability),
    reproducibility: round(reproducibility),
    ndc,
    verdict: acceptable ? "acceptable" : "not-acceptable",
    recommendation: acceptable
      ? "Measurement system is acceptable for the current study. Keep the device in the approved measurement path."
      : "Measurement system is not acceptable. Review fixture, operator method, device calibration, and study design before use."
  };
}

function handle(event) {
  const normalized = normalizeEvent(event);
  if (normalized.error) return normalized.error;

  const validation = validatePayload(normalized.payload);
  if (validation) return validation;

  const result = analyze(normalized.payload);
  /* MSA_ANALYSIS_COMPLETED and MSA_NOT_ACCEPTABLE are not part of Carlos' confirmed
     contract yet — emitted as proposed/internal events only (official: false). The
     only official output event is MSA_VALIDATED, confirmed by Carlos:
     NEW_DEVICE_REGISTERED -> MSA_VALIDATED. */
  const emittedEvents = [buildEvent("MSA_ANALYSIS_COMPLETED", result, false)];
  const acceptable = result.verdict === "acceptable";
  emittedEvents.push(buildEvent(acceptable ? "MSA_VALIDATED" : "MSA_NOT_ACCEPTABLE", {
    studyId: result.studyId,
    deviceId: result.deviceId,
    gageRRPercent: result.gageRRPercent,
    ndc: result.ndc,
    recommendation: result.recommendation
  }, acceptable));

  return {
    ok: true,
    status: "completed",
    compatibilityPath: normalized.compatibilityPath,
    result,
    emittedEvents,
    recommendation: result.recommendation
  };
}

module.exports = { handle };

if (require.main === module) {
  const fs = require("fs");
  const event = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  console.log(JSON.stringify(handle(event), null, 2));
}

