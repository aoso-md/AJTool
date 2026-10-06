import { CriteriaEditor } from '../components/CriteriaEditor';
import { useResource } from '../lib/useResource';
import { api } from '../lib/api';
import type { Spec } from '../lib/domain';

const STATUS: Record<string, string> = { capable: 'capaz', marginal: 'marginal', not_capable: 'no capaz' };

export function CriteriaPage() {
  const specs = useResource(() => api.get<{ specs: Spec[] }>('/api/specs'), []);
  const knownIds = [...new Set((specs.data?.specs ?? []).map((s) => s.characteristicId))].sort();

  return (
    <CriteriaEditor
      eyebrow="9.1.3 · criterios de aceptación"
      title="Criterios de capacidad"
      description="Dónde está la línea entre un proceso capaz, marginal y no capaz. Los valores de referencia son los habituales; la planta puede ajustarlos con confirmación."
      reference="Referencia habitual (AIAG PPAP): Cpk ≥ 1.33 capaz · entre 1.00 y 1.33 marginal · menor que 1.00 no capaz"
      fieldKeys={['minimumCpk', 'marginalFloor', 'recommendedSampleSize']}
      fieldHints={{
        minimumCpk: 'Un estudio con Cpk igual o mayor es «capaz». Por debajo queda «bajo objetivo» y puede escalarse a especificaciones.',
        marginalFloor: 'Entre este valor y el Cpk mínimo el estudio es «marginal». Por debajo, «no capaz».',
        recommendedSampleSize: 'Con menos mediciones el estudio se calcula igual, pero con una advertencia sobre su confiabilidad.',
      }}
      overrides={{
        title: 'Excepciones por característica',
        subtitle: 'Un Cpk mínimo distinto para características concretas, por ejemplo 1.67 en las críticas. Tiene prioridad sobre el valor general.',
        idLabel: 'Característica (ej. DIAM-01)',
        valueLabel: 'Cpk mínimo',
        knownIds,
      }}
      describeImpact={(impact) => {
        const lines = [`De ${impact.evaluated} estudios completados, ${impact.changed} se clasificarían distinto con los valores nuevos.`];
        const below = Number(impact.newlyBelowTarget ?? 0);
        const clear = Number(impact.noLongerBelowTarget ?? 0);
        if (below) lines.push(`${below} pasarían a «bajo objetivo».`);
        if (clear) lines.push(`${clear} dejarían de estar «bajo objetivo».`);
        return lines;
      }}
      statusLabel={(status) => STATUS[status] ?? status}
    />
  );
}
