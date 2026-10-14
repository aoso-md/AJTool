/**
 * Urgency of a study, from the server's own ranking (domain/priority.js).
 * Built only from primitives: the colours are the platform's, and each keeps its
 * one meaning — danger = act now, warn = needs a person soon, info = pending
 * work, neutral = nothing to do.
 */
import { Badge, Mono, Panel, type Tone } from './primitives';
import { Link } from '../lib/router';
import type { AttentionItem, Priority, PriorityLevel, Summary } from '../lib/types';

export const PRIORITY: Record<PriorityLevel, { label: string; tone: Tone }> = {
  critical: { label: 'crítica', tone: 'danger' },
  high: { label: 'alta', tone: 'warn' },
  medium: { label: 'media', tone: 'info' },
  low: { label: 'baja', tone: 'neutral' },
};

export function PriorityBadge({ priority }: { priority: Priority | undefined }) {
  if (!priority) return <Badge>—</Badge>;
  const p = PRIORITY[priority.level];
  return <Badge tone={p.tone}>{p.label}</Badge>;
}

/** "Qué atender primero": the top of the ranking, with the reason in plain words. */
export function AttentionPanel({ summary, hrefFor }: { summary: Summary | undefined; hrefFor: (item: AttentionItem) => string }) {
  const items = summary?.attention ?? [];
  return (
    <Panel
      title="Qué atender primero"
      subtitle="Ordenado por urgencia: lo que no cumple, lo que está detenido y lo que lleva más tiempo esperando"
    >
      {items.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-4 text-2xs text-muted">
          <span className="h-2 w-2 shrink-0 rounded-full bg-ok" aria-hidden="true" />
          Nada urgente: ningún estudio está pendiente, detenido ni fuera de criterio.
        </div>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 border-b border-border/60 px-4 py-2.5 last:border-0">
              <span className="w-14 shrink-0 pt-0.5">
                <Badge tone={PRIORITY[item.level].tone}>{PRIORITY[item.level].label}</Badge>
              </span>
              <div className="min-w-0 flex-1">
                <Link to={hrefFor(item)} className="font-mono text-2xs">
                  {item.label}
                </Link>
                <p className="mt-0.5 text-2xs text-muted">{item.reason}</p>
              </div>
              <Mono className="shrink-0 text-2xs text-faint">{item.score.toFixed(0)}</Mono>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
