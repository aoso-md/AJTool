import {Panel} from './primitives';
export function VariationPlot({ev,av,pv,grr}:{ev:number;av:number;pv:number;grr:number}) {
  const rows=[['Repetibilidad (EV)',ev],['Reproducibilidad (AV)',av],['Pieza a pieza (PV)',pv],['Sistema de medición (GRR)',grr]] as const;
  return <Panel title="Fuentes de variación" subtitle="% de variación del estudio: 100 × desviación de la fuente / desviación total. Las barras no se suman.">
    <div className="space-y-3 px-4 py-4" role="img" aria-label="Comparación de repetibilidad, reproducibilidad, piezas y sistema de medición como porcentaje de variación del estudio">
      {rows.map(([label,value])=><div key={label}><div className="mb-1 flex justify-between gap-3 text-2xs text-muted"><span>{label}</span><span className="font-mono">{value.toFixed(2)} %</span></div><div className="h-2 bg-surface2"><div className="h-2 bg-info" style={{width:`${Math.max(0,Math.min(100,value))}%`}}/></div></div>)}
    </div>
  </Panel>;
}
