import { Plus, RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button, EmptyState, ErrorState, Loading, Metric, Mono, Panel, StatusChip, Table, formatTime, type Column } from '../components/primitives';
import { PublishChip, SourceBadge } from '../components/StudyMeta';
import { AttentionPanel, PriorityBadge } from '../components/Priority';
import { useResource } from '../lib/useResource';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { fmt, verdictChip, type MsaStudy } from '../lib/domain';
import type { CriteriaResponse } from '../lib/criteria';
import type { Summary } from '../lib/types';

const pendingColumns: Column<MsaStudy>[] = [
  { key: 'priority', header: 'Prioridad', render: (s) => <PriorityBadge priority={s.priority} /> },
  { key: 'when', header: 'Registrado', render: (s) => <Mono className="text-muted">{formatTime(s.createdAt)}</Mono> },
  { key: 'gauge', header: 'Equipo', render: (s) => <Mono>{s.gaugeId ?? '—'}</Mono> },
  { key: 'type', header: 'Tipo', render: (s) => <span className="text-muted">{s.input?.device?.type ?? '—'}</span> },
  { key: 'event', header: 'Evento de registro', render: (s) => <Mono className="text-muted">{s.inputEventId?.slice(0, 8) ?? '—'}</Mono> },
  { key: 'wait', header: 'Espera', render: (s) => <Mono className="text-muted">{waiting(s.createdAt)}</Mono> },
  { key: 'state', header: 'Estado', render: () => <StatusChip status="esperando captura" tone="info" /> },
];

const studyColumns: Column<MsaStudy>[] = [
  { key: 'priority', header: 'Prioridad', render: (s) => <PriorityBadge priority={s.priority} /> },
  { key: 'when', header: 'Fecha', render: (s) => <Mono className="text-muted">{formatTime(s.updatedAt)}</Mono> },
  { key: 'source', header: 'Origen', render: (s) => <SourceBadge source={s.source} /> },
  { key: 'gauge', header: 'Equipo', render: (s) => <Mono>{s.gaugeId ?? '—'}</Mono> },
  { key: 'grr', header: '%GRR', render: (s) => <Mono>{fmt(s.result?.gageRRPercent, 1)}</Mono>, className: 'text-right' },
  { key: 'ndc', header: 'ndc', render: (s) => <Mono>{s.result?.ndc ?? '—'}</Mono>, className: 'text-right' },
  {
    key: 'verdict',
    header: 'Veredicto',
    render: (s) => {
      const v = verdictChip(s);
      return <StatusChip status={v.label} tone={v.tone} />;
    },
  },
  { key: 'publish', header: 'Publicación', render: (s) => <PublishChip publish={s.publish} /> },
];

function waiting(createdAt: string): string {
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000);
  return days <= 0 ? 'hoy' : `${days} ${days === 1 ? 'día' : 'días'}`;
}

export function StudiesPage() {
  const { data, error, loading, reload } = useResource(
    () => api.get<{ studies: MsaStudy[] }>('/api/studies?limit=200&sort=priority'),
    [],
    15_000,
  );
  const summary = useResource(() => api.get<Summary>('/api/summary'), [], 15_000);
  const criteria = useResource(() => api.get<CriteriaResponse>('/api/settings'), [], 60_000);
  const c = criteria.data?.settings as { grrAcceptable?: number; grrMarginal?: number; minNdc?: number } | undefined;
  const all = data?.studies ?? [];
  const pending = all.filter((s) => s.status === 'pending');
  const done = all.filter((s) => s.status !== 'pending');
  const count = (v: string) => done.filter((s) => s.result?.verdict === v).length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="7.1.5.2 · trazabilidad de las mediciones"
        title="Estudios del sistema de medición"
        description="Cada equipo registrado en la plataforma abre un estudio Gage R&R. Se captura aquí y el resultado vuelve a la plataforma como MSA_VALIDATED."
        actions={
          <div className="flex gap-2">
            <Button onClick={() => void reload()} loading={loading && Boolean(data)}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Actualizar
            </Button>
            <Button variant="primary" onClick={() => navigate('/capturar')}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Estudio sin registro
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Metric label="Requieren atención" value={summary.data?.needsAttention ?? 0} tone={summary.data?.needsAttention ? 'danger' : 'ok'} hint="prioridad crítica o alta" />
        <Metric label="Esperando captura" value={pending.length} tone={pending.length ? 'warn' : 'default'} hint="equipos registrados sin estudio" />
        <Metric label="Aceptables" value={count('acceptable')} tone={count('acceptable') ? 'ok' : 'default'} hint={c ? `%GRR < ${c.grrAcceptable} y ndc ≥ ${c.minNdc}` : 'criterio vigente'} />
        <Metric label="Marginales" value={count('marginal')} tone={count('marginal') ? 'warn' : 'default'} hint={c ? `%GRR ${c.grrAcceptable}–${c.grrMarginal}` : 'criterio vigente'} />
        <Metric label="Inaceptables" value={count('unacceptable')} tone={count('unacceptable') ? 'danger' : 'default'} hint={c ? `%GRR > ${c.grrMarginal}` : 'criterio vigente'} />
      </div>

      <AttentionPanel summary={summary.data} hrefFor={(item) => (item.status === 'pending' ? `/capturar/${item.id}` : `/estudios/${item.id}`)} />

      {loading && !data ? (
        <Loading label="Cargando estudios" />
      ) : error && !data ? (
        <ErrorState title="No se pudieron cargar los estudios" detail={error.message} />
      ) : (
        <>
          <Panel title="Equipos esperando estudio" subtitle="Llegaron por NEW_DEVICE_REGISTERED. Clic para capturar las lecturas.">
            <Table
              columns={pendingColumns}
              rows={pending}
              getRowKey={(s) => s.id}
              onRowClick={(s) => navigate(`/capturar/${s.id}`)}
              empty={<EmptyState title="Ningún equipo pendiente" detail="Cuando manage_device_registry registre un equipo, aparecerá aquí para su estudio." />}
            />
          </Panel>

          <Panel title="Estudios realizados" subtitle="Clic en una fila para ver el desglose y la traza">
            <Table
              columns={studyColumns}
              rows={done}
              getRowKey={(s) => s.id}
              onRowClick={(s) => navigate(`/estudios/${s.id}`)}
              empty={<EmptyState title="Todavía no hay estudios realizados" detail="Capture uno desde un equipo pendiente o con «Estudio sin registro»." />}
            />
          </Panel>
        </>
      )}
    </div>
  );
}
