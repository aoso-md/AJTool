import { useState, type ReactNode } from 'react';
import { ArrowLeft, ClipboardEdit, Send } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button, ErrorState, Loading, Metric, Mono, Panel, StatusChip } from '../components/primitives';
import { MetaRow, PublicationPanel, TraceabilityPanel, Warnings, actorLabel } from '../components/StudyMeta';
import { useResource } from '../lib/useResource';
import { api } from '../lib/api';
import { PriorityBadge } from '../components/Priority';
import { Link, navigate } from '../lib/router';
import { AIAG, fmt, metricTone, verdictChip, type MsaStudy } from '../lib/domain';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[13rem_1fr] gap-3 border-b border-border/60 px-4 py-2 text-2xs last:border-0">
      <dt className="text-faint">{label}</dt>
      <dd className="min-w-0 text-text">{children}</dd>
    </div>
  );
}

const PUBLISHABLE = new Set(['awaiting_decision', 'failed', 'retrying', 'shadow']);

/** The captured readings, read-only: part of the retained evidence of the study. */
function Readings({ study }: { study: MsaStudy }) {
  const obs = study.input?.observations ?? [];
  if (!obs.length) return null;
  const parts = [...new Set(obs.map((o) => String(o.partId)))];
  const cols = [...new Set(obs.map((o) => `${o.operatorId}·${o.trial}`))];
  const at = new Map(obs.map((o) => [`${o.partId}|${o.operatorId}·${o.trial}`, o.value]));
  return (
    <Panel title="Lecturas capturadas" subtitle={`${obs.length} lecturas · conservadas como evidencia del estudio`}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-2xs">
          <thead>
            <tr className="border-b border-border bg-surface2">
              <th className="px-4 py-2 text-left font-medium uppercase tracking-wide text-faint">Pieza</th>
              {cols.map((c) => (
                <th key={c} className="px-3 py-2 text-right font-medium uppercase tracking-wide text-faint"><Mono>{c}</Mono></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => (
              <tr key={p} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-1.5"><Mono className="text-muted">{p}</Mono></td>
                {cols.map((c) => (
                  <td key={c} className="px-3 py-1.5 text-right"><Mono>{at.get(`${p}|${c}`) ?? '—'}</Mono></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function StudyPage({ id }: { id: string }) {
  const { data, error, loading, reload } = useResource(() => api.get<{ study: MsaStudy }>(`/api/studies/${id}`), [id]);
  const status = useResource(api.status, []);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading && !data) return <Loading label="Cargando estudio" />;
  if (error && !data) return <ErrorState title="No se pudo cargar el estudio" detail={error.message} />;
  if (!data) return null;

  const s = data.study;
  const r = s.result;
  const v = verdictChip(s);
  const canPublish = s.status === 'completed' && PUBLISHABLE.has(s.publish.state);
  const crit = r?.criteria ?? AIAG;
  const legacy = !r?.criteria;

  async function publish() {
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
        eyebrow={`estudio gage r&r · ${s.source === 'platform' ? 'equipo registrado en la plataforma' : 'sin registro'}`}
        title={`Equipo ${s.gaugeId ?? '—'}`}
        description={r ? `${r.parts} piezas · ${r.appraisers} operadores · ${r.trials} ensayos · ${r.method}` : s.reason ?? undefined}
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

      {s.status === 'pending' && (
        <Panel
          title="Falta capturar el estudio"
          subtitle="El equipo se registró en la plataforma; el resultado regresará como MSA_VALIDATED"
          actions={
            <Button variant="primary" onClick={() => navigate(`/capturar/${s.id}`)}>
              <ClipboardEdit className="h-3.5 w-3.5" aria-hidden="true" />
              Capturar estudio
            </Button>
          }
        >
          <p className="px-4 py-3 text-2xs text-muted">{s.reason}</p>
        </Panel>
      )}

      {r && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="%GRR" value={fmt(r.gageRRPercent, 2)} tone={metricTone(r.verdict)} hint="de la variación total del estudio" />
            <Metric label="ndc" value={r.ndc} tone={r.ndc >= crit.minNdc ? 'default' : 'warn'} hint={`categorías distintas · se requiere ≥ ${crit.minNdc}`} />
            <Metric label="Repetibilidad (EV)" value={fmt(r.repeatability, 4)} hint={`${fmt(r.repeatabilityPercent, 1)} % · el equipo`} />
            <Metric label="Reproducibilidad (AV)" value={fmt(r.reproducibility, 4)} hint={`${fmt(r.reproducibilityPercent, 1)} % · los operadores`} />
          </div>
          <Warnings items={s.warnings} />
        </>
      )}

      {canPublish && (
        <Panel
          title="Publicar el resultado"
          subtitle="Envía MSA_VALIDATED con el veredicto; la plataforma decide el siguiente paso (rule-pkg-005)"
          actions={
            <Button variant="primary" onClick={() => void publish()} loading={busy}>
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              Publicar
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

      {r && (
        <div className="grid gap-5 md:grid-cols-2">
          <Panel title="Desglose de la variación">
            <dl>
              <Row label="GRR"><Mono>{fmt(r.grr, 5)}</Mono></Row>
              <Row label="Variación de piezas (PV)"><Mono>{fmt(r.partVariation, 5)} · {fmt(r.partVariationPercent, 1)} %</Mono></Row>
              <Row label="Variación total (TV)"><Mono>{fmt(r.totalVariation, 5)}</Mono></Row>
              <Row label="% contribución (varianza)"><Mono>{fmt(r.contributionPercent, 2)} %</Mono></Row>
            </dl>
          </Panel>
          <Panel
            title="Criterio de aceptación aplicado"
            subtitle={legacy ? 'AIAG MSA, 4.ª edición (estudio anterior a los criterios configurables)' : `Versión de criterios v${s.criteria?.version ?? 0} · no cambia aunque se modifiquen después`}
            actions={<Link to="/criterios">Ver criterios vigentes</Link>}
          >
            <dl>
              <Row label="Aceptable"><Mono>%GRR &lt; {crit.grrAcceptable} y ndc ≥ {crit.minNdc}</Mono></Row>
              <Row label="Marginal"><Mono>%GRR {crit.grrAcceptable}–{crit.grrMarginal}, o ndc &lt; {crit.minNdc}</Mono></Row>
              <Row label="Inaceptable"><Mono>%GRR &gt; {crit.grrMarginal}</Mono></Row>
              <Row label="Este estudio"><StatusChip status={v.label} tone={v.tone} /></Row>
            </dl>
          </Panel>
        </div>
      )}

      <Readings study={s} />
      <TraceabilityPanel study={s} extra={<MetaRow label="Equipo"><Mono>{s.gaugeId ?? '—'}</Mono></MetaRow>} />
      <PublicationPanel study={s} />
    </div>
  );
}
