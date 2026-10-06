// src/domain/criteria.js
// -----------------------------------------------------------------------------
// Acceptance criteria for capability studies — the numbers a plant may
// legitimately want to change, kept apart from the math so changing one never
// touches a formula.
//
//   minimumCpk             Cpk at or above it is "capable"; below it a study is
//                          "below target" and may be escalated to specifications.
//                          1.33 is the usual reference for an established
//                          process (AIAG PPAP); critical characteristics often use
//                          1.67. The platform's own rule (rule-qual-005) fires at
//                          cpk < 1.33, so a LOWER value here makes this tool stay
//                          silent where the chain would have reacted.
//   marginalFloor          Between this and minimumCpk the study is "marginal";
//                          below it, "not_capable".
//   recommendedSampleSize  Studies with fewer readings get a warning (never a
//                          rejection: a small sample is still information).
//   overrides              Per-characteristic minimum Cpk, e.g. { "DIAM-01": 1.67 }.
//
// Precedence when a study is computed (most specific wins):
//   1. a value carried by the event / typed in the form   (explicit)
//   2. the per-characteristic override
//   3. the default minimumCpk
//
// Criteria are applied to NEW studies. Each study stores a snapshot of the
// criteria it was judged with, so history is never silently re-judged.
// -----------------------------------------------------------------------------

export const SETTINGS_KEY = 'capability_criteria';

export const DEFAULTS = Object.freeze({
  minimumCpk: 1.33,
  marginalFloor: 1.0,
  recommendedSampleSize: 25,
  overrides: Object.freeze({})
});

export const BOUNDS = Object.freeze({
  minimumCpk: { min: 1.0, max: 3.0, step: 0.01, label: 'Cpk mínimo (capaz)', unit: '', reference: 1.33 },
  marginalFloor: { min: 0.5, max: 2.0, step: 0.01, label: 'Límite inferior de «marginal»', unit: '', reference: 1.0 },
  recommendedSampleSize: { min: 5, max: 200, step: 1, label: 'Muestra recomendada', unit: 'mediciones', reference: 25, integer: true },
  override: { min: 1.0, max: 3.0, step: 0.01 }
});

const LABELS = {
  minimumCpk: 'Cpk mínimo (capaz)',
  marginalFloor: 'Límite inferior de «marginal»',
  recommendedSampleSize: 'Muestra recomendada'
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function toNumber (v) {
  if (isNum(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function round2 (v) {
  return Math.round(v * 100) / 100;
}

/** Validates a candidate and returns the normalised value, or every problem found. */
export function validateCriteria (candidate) {
  const errors = [];
  const src = candidate && typeof candidate === 'object' ? candidate : {};
  const value = { overrides: {} };

  for (const key of ['minimumCpk', 'marginalFloor', 'recommendedSampleSize']) {
    const raw = src[key] === undefined ? DEFAULTS[key] : src[key];
    const n = toNumber(raw);
    const b = BOUNDS[key];
    if (n === undefined) { errors.push(`${LABELS[key]}: debe ser un número.`); continue; }
    if (b.integer && !Number.isInteger(n)) { errors.push(`${LABELS[key]}: debe ser un entero.`); continue; }
    if (n < b.min || n > b.max) { errors.push(`${LABELS[key]}: debe estar entre ${b.min} y ${b.max}.`); continue; }
    value[key] = b.integer ? n : round2(n);
  }

  if (isNum(value.minimumCpk) && isNum(value.marginalFloor) && value.marginalFloor >= value.minimumCpk) {
    errors.push('El límite inferior de «marginal» debe ser menor que el Cpk mínimo.');
  }

  const overrides = src.overrides && typeof src.overrides === 'object' && !Array.isArray(src.overrides) ? src.overrides : {};
  const ids = Object.keys(overrides);
  if (ids.length > 200) errors.push('Demasiadas excepciones por característica (máximo 200).');
  for (const id of ids.slice(0, 200)) {
    const key = String(id).trim();
    if (!key) { errors.push('Una excepción no tiene identificador de característica.'); continue; }
    if (key.length > 80) { errors.push(`Excepción «${key.slice(0, 20)}…»: identificador demasiado largo.`); continue; }
    const n = toNumber(overrides[id]);
    if (n === undefined || n < BOUNDS.override.min || n > BOUNDS.override.max) {
      errors.push(`Excepción ${key}: el Cpk mínimo debe estar entre ${BOUNDS.override.min} y ${BOUNDS.override.max}.`);
      continue;
    }
    if (isNum(value.marginalFloor) && n <= value.marginalFloor) {
      errors.push(`Excepción ${key}: debe ser mayor que el límite inferior de «marginal» (${value.marginalFloor}).`);
      continue;
    }
    value.overrides[key] = round2(n);
  }

  if (errors.length) return { ok: false, errors };
  // Stable key order so equality and diffs never depend on insertion order.
  value.overrides = Object.fromEntries(Object.entries(value.overrides).sort(([a], [b]) => a.localeCompare(b)));
  return { ok: true, value };
}

/** Which minimum Cpk applies to a characteristic, and why. */
export function minimumCpkFor (criteria, characteristicId, explicit) {
  if (isNum(explicit)) return { value: explicit, source: 'event' };
  const override = characteristicId != null ? criteria.overrides?.[characteristicId] : undefined;
  if (isNum(override)) return { value: override, source: 'characteristic' };
  return { value: criteria.minimumCpk, source: 'default' };
}

/** Human-readable list of what differs between two criteria sets. */
export function describeChanges (before, after) {
  const changes = [];
  for (const key of ['minimumCpk', 'marginalFloor', 'recommendedSampleSize']) {
    if (before[key] !== after[key]) changes.push({ field: key, label: LABELS[key], from: before[key], to: after[key] });
  }
  const ids = new Set([...Object.keys(before.overrides || {}), ...Object.keys(after.overrides || {})]);
  for (const id of [...ids].sort()) {
    const a = before.overrides?.[id];
    const b = after.overrides?.[id];
    if (a === b) continue;
    changes.push({
      field: `overrides.${id}`,
      label: `Excepción · ${id}`,
      from: a ?? null,
      to: b ?? null
    });
  }
  return changes;
}

/** Departures from the usual reference values. Warnings, never blockers. */
export function deviations (value) {
  const out = [];
  if (value.minimumCpk < 1.33) {
    out.push(`Un Cpk mínimo de ${value.minimumCpk} está por debajo de 1.33, la referencia habitual (AIAG PPAP) para un proceso establecido, y por debajo del umbral de la regla rule-qual-005 de la plataforma: esta tool dejaría de avisar casos que la cadena sí vigilaría.`);
  }
  if (value.marginalFloor < 1.0) {
    out.push(`Un límite de «marginal» de ${value.marginalFloor} clasifica como marginal procesos con Cpk menor que 1.0, que por definición producen piezas fuera de especificación.`);
  }
  if (value.recommendedSampleSize < 25) {
    out.push(`Una muestra recomendada de ${value.recommendedSampleSize} está por debajo de las 25 mediciones habituales; el intervalo de confianza del Cpk será amplio.`);
  }
  return out;
}

/**
 * What the new criteria would have meant for studies already on file. Purely
 * informative — nothing is re-judged. It lets the person confirming a change see
 * its weight before applying it.
 */
export function impactOn (studies, before, after, classify) {
  const examples = [];
  let evaluated = 0;
  let changed = 0;
  let newlyBelow = 0;
  let noLongerBelow = 0;
  for (const s of studies) {
    if (s.status !== 'completed' || !s.result || !isNum(s.result.cpk)) continue;
    evaluated += 1;
    const explicit = toNumber(s.input?.minimumCpk);
    const b = minimumCpkFor(before, s.characteristicId, explicit);
    const a = minimumCpkFor(after, s.characteristicId, explicit);
    const wasStatus = classify(s.result.cpk, b.value, before.marginalFloor);
    const nowStatus = classify(s.result.cpk, a.value, after.marginalFloor);
    if (wasStatus === nowStatus) continue;
    changed += 1;
    const wasBelow = s.result.cpk < b.value;
    const nowBelow = s.result.cpk < a.value;
    if (!wasBelow && nowBelow) newlyBelow += 1;
    if (wasBelow && !nowBelow) noLongerBelow += 1;
    if (examples.length < 5) {
      examples.push({
        id: s.id,
        label: [s.partId, s.characteristicId].filter(Boolean).join(' · ') || s.id.slice(0, 8),
        cpk: s.result.cpk,
        from: wasStatus,
        to: nowStatus
      });
    }
  }
  return { evaluated, changed, newlyBelowTarget: newlyBelow, noLongerBelowTarget: noLongerBelow, examples };
}

export default { SETTINGS_KEY, DEFAULTS, BOUNDS, validateCriteria, minimumCpkFor, describeChanges, deviations, impactOn };
