import { CriteriaEditor } from '../components/CriteriaEditor';

const VERDICT: Record<string, string> = { acceptable: 'aceptable', marginal: 'marginal', unacceptable: 'inaceptable' };

export function CriteriaPage() {
  return (
    <CriteriaEditor
      eyebrow="7.1.5.2 · criterios de aceptación"
      title="Criterios del sistema de medición"
      description="Dónde está la línea entre un equipo de medición aceptable, marginal e inaceptable. Los valores de referencia son los de AIAG; la planta puede ajustarlos con confirmación."
      reference="Referencia AIAG MSA 4.ª edición: %GRR menor que 10 y ndc ≥ 5 aceptable · 10 a 30 marginal · mayor que 30 inaceptable"
      fieldKeys={['grrAcceptable', 'grrMarginal', 'minNdc']}
      fieldHints={{
        grrAcceptable: 'Un %GRR estrictamente menor que este valor es «aceptable» y la plataforma envía el equipo a control estadístico (rule-pkg-005).',
        grrMarginal: 'Hasta este valor (inclusive) el sistema es «marginal». Por encima, «inaceptable».',
        minNdc: 'Categorías distintas que el sistema debe distinguir. Con menos, un sistema que de otro modo sería aceptable baja a «marginal».',
      }}
      describeImpact={(impact) => {
        const lines = [`De ${impact.evaluated} estudios completados, ${impact.changed} cambiarían de veredicto con los valores nuevos.`];
        const now = Number(impact.nowAcceptable ?? 0);
        const lost = Number(impact.noLongerAcceptable ?? 0);
        if (now) lines.push(`${now} pasarían a «aceptable» y quedarían habilitados para control estadístico.`);
        if (lost) lines.push(`${lost} dejarían de ser «aceptables».`);
        return lines;
      }}
      statusLabel={(status) => VERDICT[status] ?? status}
    />
  );
}
