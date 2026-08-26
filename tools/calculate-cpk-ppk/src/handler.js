"use strict";

const DEFAULT_MINIMUM_CPK = 1.33;

function round(value, decimals = 4) {
  return Number(value.toFixed(decimals));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStandardDeviation(values, average) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function validationError(message, details) {
  return {
    ok: false,
    status: "validation-error",
    message,
    details,
    emittedEvents: [],
    recommendation: "Capture complete measurement data, including numeric LSL, USL, target, and at least two numeric measurements."
  };
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return validationError("Missing payload.", ["payload is required"]);
  }

  const details = [];
  if (!Array.isArray(payload.measurements) || payload.measurements.length < 2) {
    details.push("measurements must contain at least two numeric values");
  } else if (!payload.measurements.every((value) => Number.isFinite(value))) {
    details.push("measurements must be numeric");
  }

  for (const field of ["lsl", "usl", "target"]) {
    if (!Number.isFinite(payload[field])) {
      details.push(`${field} must be numeric`);
    }
  }

  if (Number.isFinite(payload.lsl) && Number.isFinite(payload.usl) && payload.lsl >= payload.usl) {
    details.push("lsl must be lower than usl");
  }

  if (
    Number.isFinite(payload.target) &&
    Number.isFinite(payload.lsl) &&
    Number.isFinite(payload.usl) &&
    (payload.target < payload.lsl || payload.target > payload.usl)
  ) {
    details.push("target must be between lsl and usl");
  }

  return details.length ? validationError("Capability analysis cannot run with missing or invalid specs.", details) : null;
}

function buildEvent(type, payload, official) {
  return {
    type,
    source: "calculate-cpk-ppk",
    occurredAt: new Date().toISOString(),
    official: !!official,
    payload
  };
}

function handle(event) {
  if (!event || event.type !== "MEASUREMENTS_CAPTURED") {
    return validationError("Unsupported event type.", ["expected MEASUREMENTS_CAPTURED"]);
  }

  const payload = event.payload;
  const validation = validatePayload(payload);
  if (validation) return validation;

  const measurements = payload.measurements;
  const average = mean(measurements);
  const standardDeviation = sampleStandardDeviation(measurements, average);

  if (standardDeviation === 0) {
    return validationError("Capability analysis cannot run when all measurements are identical.", ["standard deviation is zero"]);
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
    partNumber: payload.partNumber,
    characteristic: payload.characteristic,
    cp: round(cp),
    cpk: round(cpk),
    mean: round(average),
    standardDeviation: round(standardDeviation),
    sampleSize: measurements.length,
    minimumCpk,
    verdict: belowTarget ? "below-target" : "capable",
    recommendation
  };

  /* CAPABILITY_ANALYSIS_COMPLETED is not part of Carlos' confirmed contract yet —
     emitted as a proposed/internal event only (official: false). The only official
     output event is CAPABILITY_BELOW_TARGET, confirmed by Carlos:
     MEASUREMENTS_CAPTURED -> CAPABILITY_BELOW_TARGET. */
  const emittedEvents = [buildEvent("CAPABILITY_ANALYSIS_COMPLETED", result, false)];
  if (belowTarget) {
    emittedEvents.push(buildEvent("CAPABILITY_BELOW_TARGET", {
      measurementSetId: result.measurementSetId,
      cpk: result.cpk,
      minimumCpk,
      recommendation
    }, true));
  }

  return {
    ok: true,
    status: "completed",
    result,
    emittedEvents,
    recommendation
  };
}

module.exports = { handle };

if (require.main === module) {
  const fs = require("fs");
  const event = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  console.log(JSON.stringify(handle(event), null, 2));
}

