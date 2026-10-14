// src/domain/priority.js
// -----------------------------------------------------------------------------
// What should a quality engineer look at first? A pure function of a study, so
// the same study always lands in the same place and the ranking can be tested.
// Computed on read, never stored: changing the rules re-ranks history for free.
//
//   critical  >= 90   a process that cannot meet the specification
//   high      >= 60   marginal, or something stuck (publish failing, error)
//   medium    >= 30   needs a person, but nothing is on fire (missing spec)
//   low       <  30   capable and done
// -----------------------------------------------------------------------------

export const LEVELS = ['critical', 'high', 'medium', 'low'];

export function levelOf (score) {
  if (score >= 90) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** @returns {{ score:number, level:string, reason:string }} */
export function priorityOf (study) {
  const publish = study.publish?.state;
  if (study.status === 'error') {
    return { score: 80, level: 'high', reason: 'El cálculo terminó en error: revisar los datos de entrada.' };
  }
  if (publish === 'retrying' || publish === 'failed') {
    return { score: 85, level: 'high', reason: 'La publicación al core no se completó; el resultado no llegó a la cadena.' };
  }
  if (study.status === 'skipped') {
    return { score: 40, level: 'medium', reason: 'Omitido: falta la especificación (USL/LSL) o los datos no son válidos.' };
  }
  const r = study.result;
  if (study.status !== 'completed' || !r) {
    return { score: 20, level: 'low', reason: 'Sin resultado.' };
  }
  const floor = study.criteria?.marginalFloor ?? 1.0;
  if (r.status === 'not_capable') {
    const score = 90 + clamp((floor - r.cpk) * 10, 0, 9);
    const decision = publish === 'awaiting_decision' ? ' Falta decidir si se escala a especificaciones.' : '';
    return { score: Math.round(score * 10) / 10, level: levelOf(score), reason: `Cpk ${r.cpk} por debajo de ${floor}: el proceso no es capaz.${decision}` };
  }
  if (r.status === 'marginal') {
    const min = r.minimumCpk ?? 1.33;
    const score = 60 + clamp(((min - r.cpk) / Math.max(min - floor, 0.01)) * 25, 0, 25);
    const decision = publish === 'awaiting_decision' ? ' Falta decidir si se escala.' : '';
    return { score: Math.round(score * 10) / 10, level: levelOf(score), reason: `Cpk ${r.cpk} entre ${floor} y ${min}: marginal.${decision}` };
  }
  return { score: 10, level: 'low', reason: `Cpk ${r.cpk}: capaz.` };
}

export function byPriority (a, b) {
  return b.priority.score - a.priority.score || String(b.createdAt).localeCompare(String(a.createdAt));
}

/** Counts and the first things to look at, for the header of the studies screen. */
export function summarize (studies) {
  const ranked = studies.map((s) => ({ ...s, priority: priorityOf(s) })).sort(byPriority);
  const byLevel = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const s of ranked) byLevel[s.priority.level] += 1;
  const attention = ranked
    .filter((s) => s.priority.level !== 'low')
    .slice(0, 5)
    .map((s) => ({
      id: s.id,
      label: [s.partId, s.characteristicId].filter(Boolean).join(' · ') || s.id.slice(0, 8),
      level: s.priority.level,
      score: s.priority.score,
      reason: s.priority.reason,
      createdAt: s.createdAt
    }));
  return { total: ranked.length, byLevel, needsAttention: byLevel.critical + byLevel.high, attention };
}

export default { priorityOf, byPriority, summarize, levelOf, LEVELS };
