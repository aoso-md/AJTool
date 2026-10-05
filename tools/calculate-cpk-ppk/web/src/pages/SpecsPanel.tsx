import { EmptyState, ErrorState, Loading, Mono, Panel, Table, formatTime, type Column } from '../components/primitives';
import { useResource } from '../lib/useResource';
import { api } from '../lib/api';
import type { Spec } from '../lib/domain';

const columns: Column<Spec>[] = [
  { key: 'char', header: 'Característica', render: (s) => <Mono>{s.characteristicId}</Mono> },
  { key: 'part', header: 'Pieza', render: (s) => <Mono className="text-muted">{s.partId || 'cualquiera'}</Mono> },
  { key: 'lsl', header: 'LSL', render: (s) => <Mono>{s.lsl}</Mono>, className: 'text-right' },
  { key: 'usl', header: 'USL', render: (s) => <Mono>{s.usl}</Mono>, className: 'text-right' },
  { key: 'v', header: 'Versión', render: (s) => <Mono>{s.version ?? '—'}</Mono> },
  { key: 'seq', header: 'seq', render: (s) => <Mono className="text-muted">{s.sourceSeq ?? '—'}</Mono>, className: 'text-right' },
  { key: 'at', header: 'Actualizada', render: (s) => <Mono className="text-muted">{formatTime(s.updatedAt)}</Mono> },
];

/**
 * The spec limits this tool knows. MEASUREMENTS_CAPTURED doesn't carry USL/LSL;
 * they come from PRODUCT_SPEC_UPDATED (manage_product_specs). A characteristic
 * missing here means its measurements are SKIPPED, not computed against guesses.
 */
export function SpecsPanel() {
  const { data, error, loading } = useResource(() => api.get<{ specs: Spec[] }>('/api/specs'), [], 30_000);
  return (
    <Panel title="Especificaciones conocidas" subtitle="Leídas de PRODUCT_SPEC_UPDATED en cada consulta al core">
      {loading && !data ? (
        <Loading label="Cargando especificaciones" />
      ) : error && !data ? (
        <div className="p-4">
          <ErrorState title="No se pudieron leer las especificaciones" detail={error.message} />
        </div>
      ) : (
        <Table
          columns={columns}
          rows={data?.specs ?? []}
          getRowKey={(s) => `${s.partId ?? ''}::${s.characteristicId}`}
          empty={
            <EmptyState
              title="Ninguna especificación recibida todavía"
              detail="Sin USL/LSL publicados por manage_product_specs, las mediciones de la plataforma quedan como «omitidas»."
            />
          }
        />
      )}
    </Panel>
  );
}
