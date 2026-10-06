import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button, EmptyState, ErrorState, Loading, Metric, Mono, Panel, StatusChip, Table, formatTime, type Column } from '../components/primitives';
import { PublishChip, SourceBadge } from '../components/StudyMeta';
import { AttentionPanel, PriorityBadge } from '../components/Priority';
import { useResource } from '../lib/useResource';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { fmt, verdictChip, type CpkStudy } from '../lib/domain';
import type { Summary } from '../lib/types';

const columns: Column<CpkStudy>[] = [
  { key: 'priority', header: 'Prioridad', render: (s) => <PriorityBadge priority={s.priority} /> },
  { key: 'when', header: 'Fecha', render: (s) => <Mono className="text-muted">{formatTime(s.createdAt)}</Mono> },
  { key: 'source', header: 'Origen', render: (s) => <SourceBadge source={s.source} /> },
  {
    key: 'what',
    header: 'Pieza · característica',
    render: (s) => <Mono>{[s.partId, s.characteristicId].filter(Boolean).join(' · ') || '—'}</Mono>,
  },
  { key: 'n', header: 'n', render: (s) => <Mono>{s.result?.sampleSize ?? '—'}</Mono>, className: 'text-right' },
  { key: 'cpk', header: 'Cpk', render: (s) => <Mono>{fmt(s.result?.cpk, 2)}</Mono>, className: 'text-right' },
  { key: 'min', header: 'Mínimo', render: (s) => <Mono className="text-muted">{fmt(s.result?.minimumCpk, 2)}</Mono>, className: 'text-right' },
  { key: 'ppk', header: 'Ppk', render: (s) => <Mono>{fmt(s.result?.ppk, 2)}</Mono>, className: 'text-right' },
  {
    key: 'verdict',
    header: 'Resultado',
    render: (s) => {
      const v = verdictChip(s);
      return <StatusChip status={v.label} tone={v.tone} />;
    },
  },
  { key: 'publish', header: 'Publicación', render: (s) => <PublishChip publish={s.publish} /> },
];

type Order = 'priority' | 'recent';

export function StudiesPage() {
  const [order, setOrder] = useState<Order>('priority');
  const [onlyUrgent, setOnlyUrgent] = useState(false);
  const { data, error, loading, reload } = useResource(
    () => api.get<{ studies: CpkStudy[] }>('/api/studies?limit=100&sort=priority'),
    [],
    15_000,
  );
  const summary = useResource(() => api.get<Summary>('/api/summary'), [], 15_000);

  const studies = data?.studies ?? [];
  const completed = studies.filter((s) => s.status === 'completed');
  const below = completed.filter((s) => s.result?.belowTarget).length;
  const capable = completed.filter((s) => s.result?.status === 'capable').length;
  const skipped = studies.filter((s) => s.status === 'skipped' || s.status === 'error').length;
  const urgent = summary.data?.needsAttention ?? 0;

  const shown = studies
    .filter((s) => !onlyUrgent || s.priority?.level === 'critical' || s.priority?.level === 'high')
    .sort((a, b) =>
      order === 'priority'
        ? (b.priority?.score ?? 0) - (a.priority?.score ?? 0) || b.createdAt.localeCompare(a.createdAt)
        : b.createdAt.localeCompare(a.createdAt),
    );

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="9.1.3 · análisis y evaluación"
        title="Estudios de capacidad de proceso"
        description="Cada cálculo de Cp, Cpk, Pp y Ppk: los que llegan de la plataforma por MEASUREMENTS_CAPTURED y los que captura un ingeniero."
        actions={
          <div className="flex gap-2">
            <Button onClick={() => { void reload(); void summary.reload(); }} loading={loading && Boolean(data)}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Actualizar
            </Button>
            <Button variant="primary" onClick={() => navigate('/nuevo')}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Nuevo estudio
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Metric label="Requieren atención" value={urgent} tone={urgent ? 'danger' : 'ok'} hint="prioridad crítica o alta" />
        <Metric label="Estudios" value={studies.length} hint="últimos 100" />
        <Metric label="Bajo objetivo" value={below} tone={below ? 'danger' : 'default'} hint="Cpk menor al mínimo vigente" />
        <Metric label="Capaces" value={capable} tone={capable ? 'ok' : 'default'} hint="Cpk igual o mayor al mínimo" />
        <Metric label="Omitidos" value={skipped} tone={skipped ? 'warn' : 'default'} hint="sin especificación o datos inválidos" />
      </div>

      <AttentionPanel summary={summary.data} hrefFor={(item) => `/estudios/${item.id}`} />

      <Panel
        title="Estudios"
        subtitle="Clic en una fila para ver el detalle y la traza"
        actions={
          <div className="flex items-center gap-2">
            <Button variant={onlyUrgent ? 'primary' : 'ghost'} onClick={() => setOnlyUrgent((v) => !v)} aria-pressed={onlyUrgent}>
              Solo urgentes
            </Button>
            <Button onClick={() => setOrder((o) => (o === 'priority' ? 'recent' : 'priority'))}>
              Orden: {order === 'priority' ? 'prioridad' : 'más recientes'}
            </Button>
          </div>
        }
      >
        {loading && !data ? (
          <Loading label="Cargando estudios" />
        ) : error && !data ? (
          <div className="p-4">
            <ErrorState title="No se pudieron cargar los estudios" detail={error.message} />
          </div>
        ) : (
          <Table
            columns={columns}
            rows={shown}
            getRowKey={(s) => s.id}
            onRowClick={(s) => navigate(`/estudios/${s.id}`)}
            empty={
              <EmptyState
                title={onlyUrgent ? 'Ningún estudio urgente' : 'Todavía no hay estudios'}
                detail={
                  onlyUrgent
                    ? 'Quite el filtro «Solo urgentes» para ver todos.'
                    : 'Aparecen aquí en cuanto llega un MEASUREMENTS_CAPTURED de la plataforma, o cuando alguien captura uno en «Nuevo estudio».'
                }
              />
            }
          />
        )}
      </Panel>
    </div>
  );
}
