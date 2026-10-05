// src/domain/capability.js
// -----------------------------------------------------------------------------
// Process capability. Pure functions: no I/O, no platform, no HTTP. Everything
// here is checked against hand-computed values in test/capability.test.js.
//
// Two sigmas, because the contract asks for both short- and long-term indices
// (core tools.json, outputSchema of calculate_cpk_ppk: cp, cpk, pp, ppk):
//
//   sigma WITHIN  (short term) = MR-bar / d2, d2 = 1.128 for moving ranges of 2.
//                 The variation the process shows between consecutive parts.
//                 Drives Cp and Cpk.
//   sigma OVERALL (long term)  = sample standard deviation (n - 1).
//                 Everything, including drift and shifts. Drives Pp and Ppk.
//
// The previous version of this tool computed "Cpk" with the overall sigma —
// that number is actually Ppk. With a drifting process the two differ, and
// reporting Ppk as Cpk overstates how capable the process inherently is.
//
// Assumes individual measurements in production order (subgroup size 1), which
// is what MEASUREMENTS_CAPTURED carries. Normality is assumed for ppm.
// -----------------------------------------------------------------------------

const D2_N2 = 1.128;
export const DEFAULT_MINIMUM_CPK = 1.33;
export const RECOMMENDED_SAMPLE_SIZE = 25;

/** Complementary error function. Numerical Recipes `erfcc`, |rel. error| < 1.2e-7. */
export function erfc (x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(
    -z * z - 1.26551223 +
    t * (1.00002368 +
    t * (0.37409196 +
    t * (0.09678418 +
    t * (-0.18628806 +
    t * (0.27886807 +
    t * (-1.13520398 +
    t * (1.48851587 +
    t * (-0.82215223 +
    t * 0.17087277))))))))
  );
  return x >= 0 ? r : 2 - r;
}

/** P(Z > z) for a standard normal. Computed from erfc so tails stay accurate. */
export function upperTail (z) {
  return 0.5 * erfc(z / Math.SQRT2);
}

function round (value, decimals = 4) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function mean (values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function sampleStdDev (values, avg) {
  if (values.length < 2) return 0;
  const ss = values.reduce((sum, v) => sum + (v - avg) ** 2, 0);
  return Math.sqrt(ss / (values.length - 1));
}

/** Classification the contract expects: capable | marginal | not_capable. */
export function classify (cpk, minimumCpk) {
  if (cpk >= minimumCpk) return 'capable';
  if (cpk >= 1.0) return 'marginal';
  return 'not_capable';
}

/**
 * @param {object} input
 * @param {number[]} input.measurements  individual values, in production order
 * @param {number}   input.usl
 * @param {number}   input.lsl
 * @param {number}  [input.minimumCpk=1.33]
 * @param {number}  [input.target]       informative only
 * @returns {{ ok: true, result: object, warnings: string[] } | { ok: false, errors: string[] }}
 */
export function analyzeCapability ({ measurements, usl, lsl, minimumCpk, target } = {}) {
  const errors = [];

  if (!Array.isArray(measurements) || measurements.length < 2) {
    errors.push('Se necesitan al menos 2 mediciones.');
  } else if (!measurements.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    errors.push('Todas las mediciones deben ser números.');
  }
  if (typeof usl !== 'number' || !Number.isFinite(usl)) errors.push('Falta el límite superior (USL) o no es numérico.');
  if (typeof lsl !== 'number' || !Number.isFinite(lsl)) errors.push('Falta el límite inferior (LSL) o no es numérico.');
  if (Number.isFinite(usl) && Number.isFinite(lsl) && lsl >= usl) errors.push('LSL debe ser menor que USL.');

  const minCpk = minimumCpk == null ? DEFAULT_MINIMUM_CPK : minimumCpk;
  if (typeof minCpk !== 'number' || !Number.isFinite(minCpk) || minCpk <= 0) {
    errors.push('El Cpk mínimo debe ser un número mayor que 0.');
  }
  if (errors.length) return { ok: false, errors };

  const n = measurements.length;
  const avg = mean(measurements);
  const sigmaOverall = sampleStdDev(measurements, avg);

  let mrSum = 0;
  for (let i = 1; i < n; i += 1) mrSum += Math.abs(measurements[i] - measurements[i - 1]);
  const mrBar = mrSum / (n - 1);
  const sigmaWithin = mrBar / D2_N2;

  if (sigmaOverall === 0 || sigmaWithin === 0) {
    return {
      ok: false,
      errors: ['Las mediciones no tienen variación (o las consecutivas son idénticas): la capacidad no está definida. Revise la resolución del instrumento.']
    };
  }

  const tolerance = usl - lsl;
  const cp = tolerance / (6 * sigmaWithin);
  const cpk = Math.min(usl - avg, avg - lsl) / (3 * sigmaWithin);
  const pp = tolerance / (6 * sigmaOverall);
  const ppk = Math.min(usl - avg, avg - lsl) / (3 * sigmaOverall);

  // Expected nonconforming parts per million, long term (overall sigma).
  const ppm = 1e6 * (upperTail((usl - avg) / sigmaOverall) + upperTail((avg - lsl) / sigmaOverall));
  const observedOutOfSpec = measurements.filter((v) => v > usl || v < lsl).length;

  const status = classify(cpk, minCpk);

  const warnings = [];
  if (n < RECOMMENDED_SAMPLE_SIZE) {
    warnings.push(`Muestra de ${n} mediciones: con menos de ${RECOMMENDED_SAMPLE_SIZE} el intervalo de confianza del Cpk es amplio. Úselo como indicativo.`);
  }
  if (typeof target === 'number' && Number.isFinite(target) && (target < lsl || target > usl)) {
    warnings.push('El valor objetivo está fuera de los límites de especificación.');
  }
  if (observedOutOfSpec > 0) {
    warnings.push(`${observedOutOfSpec} medición(es) fuera de especificación en la muestra.`);
  }

  return {
    ok: true,
    warnings,
    result: {
      sampleSize: n,
      mean: round(avg, 6),
      sigmaWithin: round(sigmaWithin, 6),
      sigmaOverall: round(sigmaOverall, 6),
      usl,
      lsl,
      target: typeof target === 'number' && Number.isFinite(target) ? target : null,
      cp: round(cp),
      cpk: round(cpk),
      pp: round(pp),
      ppk: round(ppk),
      // Same convention as the core's reference handler: sigma level = 3 · Cpk.
      sigmaLevel: round(3 * cpk, 3),
      ppmDefects: round(ppm, 1),
      observedOutOfSpec,
      minimumCpk: minCpk,
      status,
      belowTarget: cpk < minCpk
    }
  };
}

export default { analyzeCapability, classify, erfc, upperTail, DEFAULT_MINIMUM_CPK };
