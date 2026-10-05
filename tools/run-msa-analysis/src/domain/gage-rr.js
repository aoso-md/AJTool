// src/domain/gage-rr.js
// -----------------------------------------------------------------------------
// Gage R&R, AIAG MSA (4th ed.) Average & Range method. Pure functions, checked
// against hand-computed values in test/gage-rr.test.js.
//
// Why this method and not the previous ad-hoc formula: it is the one an IATF /
// ISO auditor recognises and can re-derive by hand from the study sheet, with
// published constants. A home-made variance formula gives numbers nobody outside
// this repo can verify.
//
//   EV  (repeatability, equipment)  = R-double-bar · K1
//   AV  (reproducibility, appraiser) = sqrt( (X-diff · K2)^2 − EV^2 / (n·r) )   (0 if negative)
//   GRR                              = sqrt( EV^2 + AV^2 )
//   PV  (part variation)             = Rp · K3
//   TV  (total variation)            = sqrt( GRR^2 + PV^2 )
//   %GRR = 100 · GRR / TV            ndc = floor( 1.41 · PV / GRR )
//
// Acceptance (AIAG): %GRR < 10 acceptable · 10–30 marginal · > 30 unacceptable,
// and ndc must be >= 5. The verdict values are the ones the core contract uses
// inside MSA_VALIDATED (`acceptable | marginal | unacceptable`); the routing rule
// to control charts fires only on `verdict == 'acceptable'`.
//
// Supported design (the range the K-constant tables cover): 2–3 appraisers,
// 2–3 trials, 2–10 parts, balanced. Outside that, the study is rejected with a
// clear message instead of being computed with an extrapolated constant.
// -----------------------------------------------------------------------------

const K1 = { 2: 0.8862, 3: 0.5908 }; // trials
const K2 = { 2: 0.7071, 3: 0.5231 }; // appraisers
const K3 = { 2: 0.7071, 3: 0.5231, 4: 0.4467, 5: 0.4030, 6: 0.3742, 7: 0.3534, 8: 0.3375, 9: 0.3249, 10: 0.3146 }; // parts

export const LIMITS = Object.freeze({ appraisers: [2, 3], trials: [2, 3], parts: [2, 10] });

function round (value, decimals = 4) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function mean (values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function range (values) {
  return Math.max(...values) - Math.min(...values);
}

export function verdictFor (gageRRPercent, ndc) {
  let verdict = gageRRPercent < 10 ? 'acceptable' : gageRRPercent <= 30 ? 'marginal' : 'unacceptable';
  // AIAG: a system that can't separate parts into at least 5 categories is not
  // acceptable for process control even if %GRR looks fine.
  if (verdict === 'acceptable' && ndc < 5) verdict = 'marginal';
  return verdict;
}

/**
 * @param {{partId:string, operatorId:string, trial:number|string, value:number}[]} observations
 * @returns {{ok:true, result:object, warnings:string[]} | {ok:false, errors:string[]}}
 */
export function analyzeGageRR (observations) {
  const errors = [];
  if (!Array.isArray(observations) || observations.length === 0) {
    return { ok: false, errors: ['El estudio no tiene observaciones.'] };
  }

  observations.forEach((o, i) => {
    if (o?.partId === undefined || o?.partId === null || o?.partId === '') errors.push(`Fila ${i + 1}: falta la pieza.`);
    if (o?.operatorId === undefined || o?.operatorId === null || o?.operatorId === '') errors.push(`Fila ${i + 1}: falta el operador.`);
    if (o?.trial === undefined || o?.trial === null || o?.trial === '') errors.push(`Fila ${i + 1}: falta el número de ensayo.`);
    if (typeof o?.value !== 'number' || !Number.isFinite(o.value)) errors.push(`Fila ${i + 1}: la lectura no es numérica.`);
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };

  const parts = [...new Set(observations.map((o) => String(o.partId)))];
  const appraisers = [...new Set(observations.map((o) => String(o.operatorId)))];

  // cell[appraiser][part] = readings
  const cell = new Map(appraisers.map((a) => [a, new Map(parts.map((p) => [p, []]))]));
  const seen = new Set();
  for (const o of observations) {
    const key = `${o.operatorId}|${o.partId}|${o.trial}`;
    if (seen.has(key)) {
      errors.push(`Lectura duplicada: operador ${o.operatorId}, pieza ${o.partId}, ensayo ${o.trial}.`);
      continue;
    }
    seen.add(key);
    cell.get(String(o.operatorId)).get(String(o.partId)).push(o.value);
  }

  const trialCounts = new Set();
  for (const a of appraisers) for (const p of parts) trialCounts.add(cell.get(a).get(p).length);
  if (trialCounts.size !== 1 || trialCounts.has(0)) {
    errors.push('El estudio no está balanceado: cada operador debe medir cada pieza el mismo número de veces.');
  }
  const r = [...trialCounts][0];
  const k = appraisers.length;
  const n = parts.length;

  if (k < LIMITS.appraisers[0] || k > LIMITS.appraisers[1]) errors.push(`Se requieren 2 o 3 operadores (hay ${k}).`);
  if (r < LIMITS.trials[0] || r > LIMITS.trials[1]) errors.push(`Se requieren 2 o 3 ensayos por pieza (hay ${r}).`);
  if (n < LIMITS.parts[0] || n > LIMITS.parts[1]) errors.push(`Se requieren de 2 a 10 piezas (hay ${n}).`);
  if (errors.length) return { ok: false, errors };

  const appraiserMeans = [];
  const appraiserRangeMeans = [];
  for (const a of appraisers) {
    const readings = [];
    const ranges = [];
    for (const p of parts) {
      const values = cell.get(a).get(p);
      readings.push(...values);
      ranges.push(range(values));
    }
    appraiserMeans.push(mean(readings));
    appraiserRangeMeans.push(mean(ranges));
  }
  const rDoubleBar = mean(appraiserRangeMeans);
  const xDiff = range(appraiserMeans);

  const partMeans = parts.map((p) => mean(appraisers.flatMap((a) => cell.get(a).get(p))));
  const rp = range(partMeans);

  const ev = rDoubleBar * K1[r];
  const avSquared = (xDiff * K2[k]) ** 2 - (ev ** 2) / (n * r);
  const av = avSquared > 0 ? Math.sqrt(avSquared) : 0;
  const grr = Math.sqrt(ev ** 2 + av ** 2);
  const pv = rp * K3[n];
  const tv = Math.sqrt(grr ** 2 + pv ** 2);

  if (tv === 0) {
    return { ok: false, errors: ['Todas las lecturas son idénticas: no hay variación que analizar.'] };
  }
  if (grr === 0) {
    return {
      ok: false,
      errors: ['Las lecturas repetidas son idénticas en todos los casos (EV = 0). Casi siempre es resolución insuficiente del instrumento: revise la regla 10:1 antes de dar el sistema por bueno.']
    };
  }

  const gageRRPercent = (100 * grr) / tv;
  const ndc = Math.floor((1.41 * pv) / grr);
  const verdict = verdictFor(gageRRPercent, ndc);

  const warnings = [];
  if (n < 10) warnings.push(`Estudio con ${n} piezas: AIAG recomienda 10 piezas que cubran el rango del proceso.`);
  if (av === 0 && avSquared < 0) warnings.push('La reproducibilidad calculada fue negativa y se tomó como 0 (efecto del operador indistinguible de la repetibilidad).');

  return {
    ok: true,
    warnings,
    result: {
      method: 'AIAG average & range',
      parts: n,
      appraisers: k,
      trials: r,
      repeatability: round(ev, 6),
      reproducibility: round(av, 6),
      grr: round(grr, 6),
      partVariation: round(pv, 6),
      totalVariation: round(tv, 6),
      gageRRPercent: round(gageRRPercent, 2),
      repeatabilityPercent: round((100 * ev) / tv, 2),
      reproducibilityPercent: round((100 * av) / tv, 2),
      partVariationPercent: round((100 * pv) / tv, 2),
      contributionPercent: round((100 * grr ** 2) / tv ** 2, 2),
      ndc,
      verdict
    }
  };
}

export default { analyzeGageRR, verdictFor, LIMITS };
