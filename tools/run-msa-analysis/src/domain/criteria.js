// src/domain/criteria.js
// -----------------------------------------------------------------------------
// Acceptance criteria for measurement-system studies (Gage R&R). The defaults are
// the AIAG MSA 4th-edition guideline; a plant may have its own, so they are
// editable — with a confirmation step (see platform/settings.js).
//
//   grrAcceptable  %GRR strictly below this is "acceptable".   AIAG: 10
//   grrMarginal    %GRR up to and including this is "marginal"; above it
//                  "unacceptable".                              AIAG: 30
//   minNdc         Number of distinct categories needed for a system to be
//                  acceptable. With fewer, an otherwise-acceptable system is
//                  downgraded to marginal.                      AIAG: 5
//
// The verdict values (`acceptable | marginal | unacceptable`) are the platform's
// contract; only the thresholds move. Note the routing rule rule-pkg-005 sends a
// result to control charts only when verdict == 'acceptable', so RAISING
// grrAcceptable makes more gauges flow into SPC.
//
// Criteria apply to NEW studies; each study keeps the snapshot it was judged by.
// -----------------------------------------------------------------------------

export const SETTINGS_KEY = 'msa_criteria';

export const DEFAULTS = Object.freeze({ grrAcceptable: 10, grrMarginal: 30, minNdc: 5 });

export const BOUNDS = Object.freeze({
  grrAcceptable: { min: 1, max: 20, step: 0.5, label: '%GRR aceptable (menor que)', unit: '%', reference: 10 },
  grrMarginal: { min: 10, max: 50, step: 0.5, label: '%GRR marginal (hasta)', unit: '%', reference: 30 },
  minNdc: { min: 2, max: 10, step: 1, label: 'Categorías distintas mínimas (ndc)', unit: '', reference: 5, integer: true }
});

const LABELS = { grrAcceptable: BOUNDS.grrAcceptable.label, grrMarginal: BOUNDS.grrMarginal.label, minNdc: BOUNDS.minNdc.label };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function toNumber (v) {
  if (isNum(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function validateCriteria (candidate) {
  const errors = [];
  const src = candidate && typeof candidate === 'object' ? candidate : {};
  const value = {};
  for (const key of Object.keys(DEFAULTS)) {
    const n = toNumber(src[key] === undefined ? DEFAULTS[key] : src[key]);
    const b = BOUNDS[key];
    if (n === undefined) { errors.push(`${LABELS[key]}: debe ser un número.`); continue; }
    if (b.integer && !Number.isInteger(n)) { errors.push(`${LABELS[key]}: debe ser un entero.`); continue; }
    if (n < b.min || n > b.max) { errors.push(`${LABELS[key]}: debe estar entre ${b.min} y ${b.max}.`); continue; }
    value[key] = Math.round(n * 100) / 100;
  }
  if (isNum(value.grrAcceptable) && isNum(value.grrMarginal) && value.grrAcceptable >= value.grrMarginal) {
    errors.push('El límite «aceptable» debe ser menor que el límite «marginal».');
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function describeChanges (before, after) {
  return Object.keys(DEFAULTS)
    .filter((key) => before[key] !== after[key])
    .map((key) => ({ field: key, label: LABELS[key], from: before[key], to: after[key] }));
}

/** Departures from the AIAG guideline. Warnings, never blockers. */
export function deviations (value) {
  const out = [];
  if (value.grrAcceptable > 10) {
    out.push(`Aceptar un %GRR de hasta ${value.grrAcceptable}% se aparta de AIAG (menos de 10%): más equipos de medición quedarán «aceptables» y pasarán a control estadístico del proceso por la regla rule-pkg-005.`);
  }
  if (value.grrMarginal > 30) {
    out.push(`Un límite marginal de ${value.grrMarginal}% supera el 30% de AIAG: un sistema que AIAG considera inaceptable se clasificará como marginal.`);
  }
  if (value.minNdc < 5) {
    out.push(`Exigir solo ${value.minNdc} categorías distintas se aparta de AIAG (5 o más): el sistema podría no distinguir piezas con la finura que el control del proceso necesita.`);
  }
  return out;
}

/** What the new thresholds would have meant for studies already on file. Informative only. */
export function impactOn (studies, before, after, verdictFor) {
  const examples = [];
  let evaluated = 0;
  let changed = 0;
  let nowAcceptable = 0;
  let noLongerAcceptable = 0;
  for (const s of studies) {
    if (s.status !== 'completed' || !s.result || !isNum(s.result.gageRRPercent) || !isNum(s.result.ndc)) continue;
    evaluated += 1;
    const was = verdictFor(s.result.gageRRPercent, s.result.ndc, before);
    const now = verdictFor(s.result.gageRRPercent, s.result.ndc, after);
    if (was === now) continue;
    changed += 1;
    if (now === 'acceptable') nowAcceptable += 1;
    if (was === 'acceptable') noLongerAcceptable += 1;
    if (examples.length < 5) {
      examples.push({ id: s.id, label: s.gaugeId || s.id.slice(0, 8), gageRRPercent: s.result.gageRRPercent, from: was, to: now });
    }
  }
  return { evaluated, changed, nowAcceptable, noLongerAcceptable, examples };
}

export default { SETTINGS_KEY, DEFAULTS, BOUNDS, validateCriteria, describeChanges, deviations, impactOn };
