// src/domain/priority.js
// -----------------------------------------------------------------------------
// What should a quality engineer look at first? A pure function of a study,
// computed on read and never stored, so changing the rules re-ranks history.
//
//   critical  >= 90   the measurement system is not good enough
//   high      >= 60   marginal, a registered gauge waiting too long, or stuck
//   medium    >= 30   a gauge is registered and needs its study
//   low       <  30   acceptable and done
//
// A registered gauge with no MSA is the most common silent failure: it measures
// production parts, nobody has proven it can, and the chain never moves on.
// So a pending study gets MORE urgent the longer it waits.
// -----------------------------------------------------------------------------

export const LEVELS = ['critical', 'high', 'medium', 'low'];

export function levelOf (score) {
  if (score >= 90) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const DAY = 86_400_000;

export function priorityOf (study, now = Date.now()) {
  const publish = study.publish?.state;
  if (study.status === 'error') {
    return { score: 80, level: 'high', reason: 'El cálculo terminó en error: revisar las lecturas.' };
  }
  if (publish === 'retrying' || publish === 'failed') {
    return { score: 85, level: 'high', reason: 'La publicación al core no se completó; el resultado no llegó a la cadena.' };
  }
  if (study.status === 'pending') {
    const days = Math.max(0, Math.floor((now - new Date(study.createdAt).getTime()) / DAY));
    const score = clamp(45 + days * 4, 45, 79);
    const wait = days === 0 ? 'registrado hoy' : `esperando ${days} ${days === 1 ? 'día' : 'días'}`;
    return { score, level: levelOf(score), reason: `Equipo ${wait}: falta capturar el estudio Gage R&R.` };
  }
  const r = study.result;
  if (study.status !== 'completed' || !r) return { score: 20, level: 'low', reason: 'Sin resultado.' };

  const decision = publish === 'awaiting_decision' ? ' Falta decidir si se publica.' : '';
  if (r.verdict === 'unacceptable') {
    const score = 90 + clamp(((r.gageRRPercent - 30) / 70) * 9, 0, 9);
    return { score: Math.round(score * 10) / 10, level: levelOf(score), reason: `%GRR ${r.gageRRPercent}%: el sistema de medición no es aceptable.${decision}` };
  }
  if (r.verdict === 'marginal') {
    const score = 60 + clamp(((r.gageRRPercent - 10) / 20) * 25, 0, 25);
    return { score: Math.round(score * 10) / 10, level: levelOf(score), reason: `%GRR ${r.gageRRPercent}% · ndc ${r.ndc}: marginal.${decision}` };
  }
  return { score: 10, level: 'low', reason: `%GRR ${r.gageRRPercent}%: aceptable.` };
}

export function byPriority (a, b) {
  return b.priority.score - a.priority.score || String(b.createdAt).localeCompare(String(a.createdAt));
}

export function summarize (studies, now = Date.now()) {
  const ranked = studies.map((s) => ({ ...s, priority: priorityOf(s, now) })).sort(byPriority);
  const byLevel = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const s of ranked) byLevel[s.priority.level] += 1;
  const pending = ranked.filter((s) => s.status === 'pending');
  const oldest = pending.length ? Math.max(...pending.map((s) => Math.floor((now - new Date(s.createdAt).getTime()) / DAY))) : 0;
  const attention = ranked
    .filter((s) => s.priority.level !== 'low')
    .slice(0, 5)
    .map((s) => ({
      id: s.id,
      label: s.gaugeId || s.id.slice(0, 8),
      status: s.status,
      level: s.priority.level,
      score: s.priority.score,
      reason: s.priority.reason,
      createdAt: s.createdAt
    }));
  return {
    total: ranked.length,
    byLevel,
    needsAttention: byLevel.critical + byLevel.high,
    pending: pending.length,
    oldestPendingDays: oldest,
    attention
  };
}

export default { priorityOf, byPriority, summarize, levelOf, LEVELS };
