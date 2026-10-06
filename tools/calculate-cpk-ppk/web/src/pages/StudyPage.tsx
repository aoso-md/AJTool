import { useState, type ReactNode } from 'react';
import { ArrowLeft, Send } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button, ErrorState, Loading, Metric, Mono, Panel, StatusChip } from '../components/primitives';
import { PublicationPanel, TraceabilityPanel, Warnings, actorLabel } from '../components/StudyMeta';
import { PriorityBadge } from '../components/Priority';
import { useResource } from '../lib/useResource';
import { api } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { fmt, metricTone, verdictChip, type CpkStudy } from '../lib/domain';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[12rem_1fr] gap-3 border-b border-border/60 px-4 py-2 text-2xs last:border-0">
      <dt className="text-faint">{label}</dt>
      <dd className="min-w-0 text-text">{children}</dd>
    </div>
  );
}

const ESCALATABLE = new Set(['awaiting_decision', 'failed', 'shadow', 'retrying']);

export function StudyPage({ id }: { id: string }) {
  const { data, error, loading, reload } = useResource(() => api.get<{ study: CpkStudy }>(`/api/studies/${id}`), [id]);
  const status = useResource(api.status, []);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading && !data) return <Loading label="Cargando estudio" />;
  if (error && !data) return <ErrorState title="No se pudo cargar el estudio" detail={error.message} />;
  if (!data) return null;

  const s = data.study;
  const r = s.result;
  const v = verdictChip(s);
  const canEscalate = Boolean(r?.belowTarget) && ESCALATABLE.has(s.publish.state);

  async function escalate() {
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/api/studies/${s.id}/publish`, {});
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`estudio · ${s.source === 'platform' ? 'desde la plataforma' : 'captura manual'}`}
        title={[s.partId, s.characteristicId].filter(Boolean).join(' · ') || 'Estudio sin identificar'}
        description={r ? `${r.sampleSize} mediciones · USL ${r.usl} · LSL ${r.lsl} · Cpk mínimo ${r.minimumCpk}` : s.reason ?? undefined}
        actions={
          <div className="flex items-center gap-2">
            <PriorityBadge priority={s.priority} />
            <StatusChip status={v.label} tone={v.tone} />
            <Button onClick={() => navigate('/')}>
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Estudios
            </Button>
          </div>
        }
      />

      {s.priority && s.priority.level !== 'low' && (
        <p className="text-2xs text-muted">
          <span className="text-faint">Por qué es prioritario: </span>
          {s.priority.reason}
        </p>
      )}

      {s.status !== 'completed' && s.reason && (
        <ErrorState title={s.status === 'skipped' ? 'Estudio omitido — no se calculó' : 'El estudio falló'} detail={s.reason} />
      )}

      {r && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="Cpk" value={fmt(r.cpk, 3)} tone={metricTone(r.status)} hint="corto plazo · σ dentro" />
            <Metric label="Ppk" value={fmt(r.ppk, 3)} hint="largo plazo · σ global" />
            <Metric label="Cp" value={fmt(r.cp, 3)} hint="potencial, centrado ideal" />
            <Metric label="Pp" value={fmt(r.pp, 3)} hint="potencial de largo plazo" />
          </div>
          <Warnings items={s.warnings} />
        </>
      )}

      {canEscalate && (
        <Panel
          title="Escalar a revisión de especificaciones"
          subtitle="Publica CAPABILITY_BELOW_TARGET; la plataforma lo enruta a manage_product_specs (regla rule-qual-005)"
          actions={
            <Button variant="primary" onClick={() => void escalate()} loading={busy}>
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              Escalar
            </Button>
          }
        >
          <div className="space-y-2 px-4 py-3 text-2xs text-muted">
            <p>
              Se firmará a nombre de <Mono className="text-text">{actorLabel(status.data?.caller)}</Mono>
              {status.data?.publish.mode === 'shadow' && ' — la instancia está en modo sombra: el evento se registra pero NO se envía.'}
            </p>
            {actionError && <p className="font-mono text-danger">{actionError}</p>}
          </div>
        </Panel>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        {r && (
          <Panel title="Detalle estadístico">
            <dl>
              <Row label="Media"><Mono>{fmt(r.mean, 5)}</Mono></Row>
              <Row label="σ dentro (MR̄ / 1.128)"><Mono>{fmt(r.sigmaWithin, 5)}</Mono></Row>
              <Row label="σ global (n − 1)"><Mono>{fmt(r.sigmaOverall, 5)}</Mono></Row>
              <Row label="Nivel sigma (3 · Cpk)"><Mono>{fmt(r.sigmaLevel, 2)}</Mono></Row>
              <Row label="PPM esperado fuera de spec"><Mono>{fmt(r.ppmDefects, 1)}</Mono></Row>
              <Row label="Fuera de spec en la muestra"><Mono>{r.observedOutOfSpec}</Mono></Row>
              <Row label="Objetivo"><Mono>{r.target ?? '—'}</Mono></Row>
            </dl>
          </Panel>
        )}
        <Panel
          title="Criterios aplicados"
          subtitle="Con los que se juzgó este estudio; no cambian aunque los criterios se modifiquen después"
          actions={<Link to="/criterios">Ver criterios vigentes</Link>}
        >
          <dl>
            <Row label="Cpk mínimo"><Mono>{r?.minimumCpk ?? '—'}</Mono></Row>
            <Row label="Origen del mínimo">
              <span className="text-muted">
                {s.criteria?.minimumCpkSource === 'event'
                  ? 'valor indicado en el evento o en el formulario'
                  : s.criteria?.minimumCpkSource === 'characteristic'
                    ? 'excepción de esta característica'
                    : s.criteria?.minimumCpkSource === 'default'
                      ? 'valor general vigente'
                      : 'registro anterior a los criterios configurables'}
              </span>
            </Row>
            <Row label="Límite de «marginal»"><Mono>{r?.marginalFloor ?? (s.criteria?.marginalFloor as number | undefined) ?? 1}</Mono></Row>
            <Row label="Versión de criterios"><Mono>{s.criteria?.version != null ? `v${s.criteria.version}` : '—'}</Mono></Row>
          </dl>
        </Panel>
        <Panel title="Especificación usada">
          <dl>
            <Row label="USL"><Mono>{s.spec?.usl ?? '—'}</Mono></Row>
            <Row label="LSL"><Mono>{s.spec?.lsl ?? '—'}</Mono></Row>
            <Row label="Versión"><Mono>{s.spec?.version ?? '—'}</Mono></Row>
            <Row label="Fuente">
              <Mono>
                {s.spec?.source === 'spec_cache'
                  ? 'PRODUCT_SPEC_UPDATED (plataforma)'
                  : s.spec?.source === 'event'
                    ? 'incluida en el evento de mediciones'
                    : s.spec?.source === 'manual'
                      ? 'capturada a mano'
                      : '—'}
              </Mono>
            </Row>
            {s.spec?.sourceEventId && <Row label="Evento de la spec"><Mono>{s.spec.sourceEventId}</Mono></Row>}
          </dl>
        </Panel>
      </div>

      <TraceabilityPanel study={s} />
      <PublicationPanel study={s} />
    </div>
  );
}
