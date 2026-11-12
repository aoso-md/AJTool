import {Panel} from './primitives';

/** Observations and limits only: this does not assert normality or statistical control. */
export function CapabilityPlots({values,lsl,usl}:{values:number[];lsl:number;usl:number}) {
  if(values.length<2 || !values.every(Number.isFinite)) return null;
  const low=Math.min(lsl,...values);const high=Math.max(usl,...values);const width=high-low;
  if(!(width>0) || !Number.isFinite(width)) return null;
  const bins=Array.from({length:Math.min(12,Math.max(4,Math.ceil(Math.sqrt(values.length))))},()=>0);
  for(const value of values) bins[Math.min(bins.length-1,Math.floor((value-low)/width*bins.length))]!++;
  const peak=Math.max(...bins,1);const x=(v:number)=>48+(v-low)/width*624;
  const sampled=values.filter((_,i)=>i%Math.max(1,Math.ceil(values.length/1000))===0);
  const y=(v:number)=>190-(v-low)/width*160;
  return <div className="grid min-w-0 gap-5 md:grid-cols-2">
    <Panel title="Distribución observada" subtitle={`${values.length} mediciones · frecuencia por intervalo; no presupone normalidad`}>
      <svg className="block w-full" viewBox="0 0 720 250" role="img" aria-label="Histograma de mediciones con límites inferior y superior de especificación">
        <line x1="48" y1="190" x2="672" y2="190" stroke="var(--color-muted)" />
        {bins.map((count,i)=><rect key={i} x={48+i*624/bins.length+1} y={190-count/peak*140} width={624/bins.length-2} height={count/peak*140} fill="var(--color-info)"><title>{`${(low+i*width/bins.length).toPrecision(5)} a ${(low+(i+1)*width/bins.length).toPrecision(5)}: ${count}`}</title></rect>)}
        {[lsl,usl].map((limit,i)=><g key={i}><line x1={x(limit)} x2={x(limit)} y1="30" y2="190" stroke="var(--color-warn)" strokeDasharray="5 3"/><text x={x(limit)} y="22" textAnchor="middle" fill="var(--color-warn)" fontSize="13">{i?'USL':'LSL'} {limit}</text></g>)}
        <text x="48" y="214" fill="var(--color-muted)" fontSize="13">{low.toPrecision(5)}</text><text x="672" y="214" textAnchor="end" fill="var(--color-muted)" fontSize="13">{high.toPrecision(5)}</text>
        <text x="48" y="239" fill="var(--color-muted)" fontSize="13">Frecuencia máxima: {peak} · barras en escala lineal</text>
      </svg>
    </Panel>
    <Panel title="Secuencia de mediciones" subtitle="Orden de captura; no es una prueba de estabilidad ni normalidad">
      <svg className="block w-full" viewBox="0 0 720 250" role="img" aria-label="Serie de mediciones en orden de captura con límites de especificación">
        {[lsl,usl].map((limit,i)=><g key={i}><line x1="48" x2="672" y1={y(limit)} y2={y(limit)} stroke="var(--color-warn)" strokeDasharray="5 3"/><text x="48" y={y(limit)-5} fill="var(--color-warn)" fontSize="13">{i?'USL':'LSL'} {limit}</text></g>)}
        <polyline points={sampled.map((v,i)=>`${48+i/(sampled.length-1)*624},${y(v)}`).join(' ')} fill="none" stroke="var(--color-info)" strokeWidth="2"/>
        <text x="48" y="214" fill="var(--color-muted)" fontSize="13">Primera medición</text><text x="672" y="214" textAnchor="end" fill="var(--color-muted)" fontSize="13">Última{sampled.length<values.length?' muestra representada':''}</text>
        <text x="48" y="239" fill="var(--color-muted)" fontSize="13">{sampled.length} de {values.length} puntos representados · límites de especificación</text>
      </svg>
    </Panel>
  </div>;
}
