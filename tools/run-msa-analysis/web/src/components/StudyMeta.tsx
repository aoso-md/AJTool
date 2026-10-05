/**
 * Domain pieces shared by both screens of a study: publication state, origin,
 * who signed, the exact event sent (or that would be sent). Built ONLY from
 * primitives.tsx — no new colours, no new surfaces.
 */
import type { ReactNode } from 'react';
import { Badge, Mono, Panel, StatusChip, formatTime, type Tone } from './primitives';
import type { Actor, PublishInfo, StudyBase } from '../lib/types';

const PUBLISH: Record<string, { label: string; tone: Tone }> = {
  not_required: { label: 'no requiere publicación', tone: 'neutral' },
  awaiting_decision: { label: 'pendiente de decisión', tone: 'warn' },
  awaiting_capture: { label: 'esperando captura', tone: 'info' },
  shadow: { label: 'modo sombra · no enviado', tone: 'info' },
  published: { label: 'publicado', tone: 'ok' },
  duplicate: { label: 'publicado (repetido descartado)', tone: 'ok' },
  failed: { label: 'rechazado por el core', tone: 'danger' },
  retrying: { label: 'reintentando envío', tone: 'warn' },
};

export function PublishChip({ publish }: { publish: PublishInfo | undefined }) {
  const p = PUBLISH[publish?.state ?? 'not_required'] ?? { label: publish?.state ?? '—', tone: 'neutral' as Tone };
  return <StatusChip status={p.label} tone={p.tone} />;
}

export function SourceBadge({ source }: { source: StudyBase['source'] }) {
  return <Badge tone={source === 'platform' ? 'info' : 'neutral'}>{source === 'platform' ? 'plataforma' : 'manual'}</Badge>;
}

export function actorLabel(actor: Actor | null | undefined): string {
  if (!actor) return '—';
  if (actor.kind === 'service') return `servicio · ${actor.ref ?? 'plataforma'}`;
  if (actor.kind === 'open') return `${actor.name ?? actor.ref} (sin SSO)`;
  return actor.role ? `${actor.name ?? actor.ref} · ${actor.role}` : actor.name ?? actor.ref ?? '—';
}

/** One label/value line, same grid as the panels below. Exported so extra rows align. */
export function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3 border-b border-border/60 px-4 py-2 text-2xs last:border-0">
      <dt className="text-faint">{label}</dt>
      <dd className="min-w-0 break-words text-text">{children}</dd>
    </div>
  );
}

/** ISO 9001:2015 7.5.3.2 — what retained information this study carries. */
export function TraceabilityPanel({ study, extra }: { study: StudyBase; extra?: ReactNode }) {
  return (
    <Panel title="Trazabilidad" subtitle="Información documentada que se conserva de este estudio">
      <dl>
        <MetaRow label="Estudio"><Mono>{study.id}</Mono></MetaRow>
        <MetaRow label="Origen"><SourceBadge source={study.source} /></MetaRow>
        <MetaRow label="Realizado por"><Mono>{actorLabel(study.actor)}</Mono></MetaRow>
        {study.publishedBy && <MetaRow label="Publicado por"><Mono>{actorLabel(study.publishedBy)}</Mono></MetaRow>}
        <MetaRow label="Creado"><Mono>{formatTime(study.createdAt)}</Mono></MetaRow>
        <MetaRow label="Actualizado"><Mono>{formatTime(study.updatedAt)}</Mono></MetaRow>
        {study.inputEventId && <MetaRow label="Evento de entrada"><Mono>{study.inputEventId}</Mono></MetaRow>}
        {study.inputSeq != null && <MetaRow label="seq"><Mono>{study.inputSeq}</Mono></MetaRow>}
        {study.correlationId && <MetaRow label="Correlación"><Mono>{study.correlationId}</Mono></MetaRow>}
        {extra}
        {study.notes && <MetaRow label="Notas">{study.notes}</MetaRow>}
      </dl>
    </Panel>
  );
}

/** The exact envelope sent to the core — or that WOULD be sent, in shadow mode. */
export function PublicationPanel({ study, actions }: { study: StudyBase; actions?: ReactNode }) {
  const p = study.publish;
  return (
    <Panel title="Publicación a la plataforma" subtitle="Evento en formato Industrial Event Standard" actions={actions}>
      <dl>
        <MetaRow label="Estado"><PublishChip publish={p} /></MetaRow>
        {p.eventId && <MetaRow label="event_id"><Mono>{p.eventId}</Mono></MetaRow>}
        {p.seq != null && <MetaRow label="seq en el core"><Mono>{p.seq}</Mono></MetaRow>}
        {p.at && <MetaRow label="Fecha"><Mono>{formatTime(p.at)}</Mono></MetaRow>}
        {p.error && <MetaRow label="Detalle"><span className="font-mono text-danger">{p.error}</span></MetaRow>}
      </dl>
      {p.event != null && (
        <pre className="max-h-80 overflow-auto border-t border-border bg-bg px-4 py-3 font-mono text-2xs leading-relaxed text-muted">
          {JSON.stringify(p.event, null, 2)}
        </pre>
      )}
    </Panel>
  );
}

export function Warnings({ items }: { items: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="space-y-1 rounded-md border border-warn/40 bg-warn/5 px-4 py-3">
      {items.map((w) => (
        <p key={w} className="text-2xs text-warn">{w}</p>
      ))}
    </div>
  );
}
