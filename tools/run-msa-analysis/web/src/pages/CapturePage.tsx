import { useMemo, useState, type ClipboardEvent, type FormEvent } from 'react';
import { Calculator } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button, ErrorState, Field, Input, Loading, Mono, Panel, Select } from '../components/primitives';
import { actorLabel } from '../components/StudyMeta';
import { useResource } from '../lib/useResource';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import type { MsaStudy, Observation } from '../lib/domain';

const key = (part: number, op: string, trial: number) => `${part}|${op}|${trial}`;

/**
 * Gage R&R capture: parts × (appraiser · trial). The layout is the AIAG study
 * sheet, and it's also how the data sits in a spreadsheet — so a block copied
 * from Excel can be pasted into any cell and fills the grid from there.
 */
export function CapturePage({ pendingId }: { pendingId?: string }) {
  const pending = useResource(
    () => (pendingId ? api.get<{ study: MsaStudy }>(`/api/studies/${pendingId}`) : Promise.resolve(null)),
    [pendingId],
  );
  const status = useResource(api.status, []);

  const [gaugeId, setGaugeId] = useState('');
  const [parts, setParts] = useState(10);
  const [operatorsRaw, setOperatorsRaw] = useState('A, B, C');
  const [trials, setTrials] = useState(3);
  const [values, setValues] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [commandKey] = useState(()=>crypto.randomUUID());
  const [errors, setErrors] = useState<string[]>([]);

  const operatorEntries = useMemo(() => operatorsRaw.split(',').map((s) => s.trim()).filter(Boolean), [operatorsRaw]);
  const operators = useMemo(() => [...new Set(operatorEntries)], [operatorEntries]);
  const columns = useMemo(() => operators.slice(0, 3).flatMap((op) => Array.from({ length: trials }, (_, i) => ({ op, trial: i + 1 }))), [operators, trials]);
  const partIndexes = useMemo(() => Array.from({ length: parts }, (_, i) => i + 1), [parts]);

  const filled = partIndexes.reduce(
    (n, p) => n + columns.filter((c) => (values[key(p, c.op, c.trial)] ?? '').trim() !== '' && Number.isFinite(Number(values[key(p, c.op, c.trial)]))).length,
    0,
  );
  const total = parts * columns.length;
  const designOk = operatorEntries.length === operators.length && operators.length >= 2 && operators.length <= 3 && trials >= 2 && trials <= 3 && parts >= 2 && parts <= 10;

  if (pendingId && pending.loading && !pending.data) return <Loading label="Cargando el equipo registrado" />;
  if (pendingId && pending.error) return <ErrorState title="No se pudo cargar el estudio pendiente" detail={pending.error.message} />;
  const study = pending.data?.study ?? null;
  if (study && study.status !== 'pending') {
    return <ErrorState title="Este estudio ya fue capturado" detail={`Estado: ${study.status}. Ábralo desde la lista de estudios.`} />;
  }
  const effectiveGauge = study?.gaugeId ?? gaugeId.trim();

  function setCell(p: number, op: string, trial: number, v: string) {
    setValues((prev) => ({ ...prev, [key(p, op, trial)]: v }));
  }

  function paste(event: ClipboardEvent<HTMLInputElement>, p: number, colIndex: number) {
    const text = event.clipboardData.getData('text');
    if (!/[\t\n]/.test(text)) return; // a single value: let the input handle it
    event.preventDefault();
    const rows = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n');
    if (p+rows.length-1>parts || rows.some(row=>colIndex+row.split('\t').length>columns.length)) {
      setErrors(['El bloque excede la matriz. Ajuste piezas/operadores/ensayos o pegue un bloque menor. No se modificó ninguna celda.']);return;
    }
    if (rows.some(row=>row.split('\t').some(cell=>!cell.trim() || !Number.isFinite(Number(cell))))) {
      setErrors(['El bloque contiene celdas vacías o valores no numéricos. Corrija el origen y vuelva a pegar. No se modificó ninguna celda.']);return;
    }
    setErrors([]);
    setValues((prev) => {
      const next = { ...prev };
      rows.forEach((row, r) => {
        row.split('\t').forEach((cell, c) => {
          const part = p + r;
          const col = columns[colIndex + c];
          if (part <= parts && col) next[key(part, col.op, col.trial)] = cell.trim();
        });
      });
      return next;
    });
  }

  function moveCell(event: React.KeyboardEvent<HTMLInputElement>, row: number, col: number) {
    let nextRow=row;let nextCol=col;
    if (event.key==='Enter') nextRow+=event.shiftKey?-1:1;
    else if (event.key==='ArrowDown') nextRow++;
    else if (event.key==='ArrowUp') nextRow--;
    else if (event.key==='ArrowLeft' && event.currentTarget.selectionStart===0) nextCol--;
    else if (event.key==='ArrowRight' && event.currentTarget.selectionEnd===event.currentTarget.value.length) nextCol++;
    else return;
    const next=document.querySelector<HTMLInputElement>(`input[data-row="${nextRow}"][data-col="${nextCol}"]`);
    if (next) {event.preventDefault();next.focus();next.select();}
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setErrors([]);
    if (!designOk || !effectiveGauge) {
      setErrors(['Identifique el equipo y use 2 o 3 operadores distintos, 2–3 ensayos y 2–10 piezas.']);
      document.getElementById('msa-operators')?.focus();
      return;
    }
    const observations: Observation[] = [];
    for (const p of partIndexes) {
      for (const c of columns) {
        const raw = (values[key(p, c.op, c.trial)] ?? '').trim();
        observations.push({ partId: `P${p}`, operatorId: c.op, trial: c.trial, value: raw === '' ? NaN : Number(raw) });
      }
    }
    if (observations.some(o=>!Number.isFinite(o.value))) {
      setErrors(['Complete todas las celdas con números finitos antes de guardar.']);
      document.querySelector<HTMLInputElement>('input[data-invalid="true"]')?.focus();return;
    }
    setBusy(true);
    try {
      const body = { studyType: 'gage_rr', observations, notes: notes.trim() || undefined };
      const result = study
        ? await api.post<{ study: MsaStudy }>(`/api/studies/${study.id}/capture`, body, commandKey)
        : await api.post<{ study: MsaStudy }>('/api/studies', { ...body, gaugeId: effectiveGauge }, commandKey);
      navigate(`/estudios/${result.study.id}`);
    } catch (e) {
      const body = (e as { body?: { errors?: string[] } }).body;
      setErrors(body?.errors?.length ? body.errors : [e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form noValidate className="space-y-5" onSubmit={submit}>
      <PageHeader
        eyebrow={study ? '7.1.5.2 · equipo registrado en la plataforma' : '7.1.5.2 · estudio sin registro'}
        title={study ? `Estudio Gage R&R · ${study.gaugeId}` : 'Estudio Gage R&R'}
        description={
          study
            ? 'Al guardar se calcula y se registra la intención de envío MSA_VALIDATED. En modo sombra no se transmite al Core.'
            : 'Para un equipo que no llegó por la plataforma (por ejemplo, un re-estudio periódico). Se guarda; publicarlo es un paso aparte.'
        }
        actions={
          <Button type="submit" variant="primary" loading={busy} disabled={!designOk || filled !== total || !effectiveGauge}>
            <Calculator className="h-3.5 w-3.5" aria-hidden="true" />
            {study ? 'Calcular y registrar envío' : 'Calcular y guardar'}
          </Button>
        }
      />

      {errors.length > 0 && <ErrorState title="El estudio no se pudo calcular" detail={errors.join(' · ')} />}

      <Panel title="Diseño del estudio" subtitle="Método AIAG de promedios y rangos: 2–3 operadores, 2–3 ensayos, 2–10 piezas">
        <div className="grid gap-4 px-4 py-3 md:grid-cols-4">
          <Field label="Equipo de medición" required hint={study ? 'del evento NEW_DEVICE_REGISTERED' : 'gaugeId'}>
            <Input value={effectiveGauge} onChange={(e) => setGaugeId(e.target.value)} readOnly={Boolean(study)} placeholder="GAUGE-07" className="font-mono" />
          </Field>
          <Field label="Piezas" hint="AIAG recomienda 10">
            <Select value={parts} onChange={(e) => setParts(Number(e.target.value))}>
              {Array.from({ length: 9 }, (_, i) => i + 2).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </Select>
          </Field>
          <Field label="Operadores" hint="2 o 3, separados por coma" error={operatorEntries.length !== operators.length ? 'Cada operador debe tener un identificador distinto.' : operators.length < 2 || operators.length > 3 ? 'Se requieren 2 o 3 operadores' : undefined}>
            <Input id="msa-operators" value={operatorsRaw} onChange={(e) => setOperatorsRaw(e.target.value)} className="font-mono" />
          </Field>
          <Field label="Ensayos por pieza">
            <Select value={trials} onChange={(e) => setTrials(Number(e.target.value))}>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </Select>
          </Field>
        </div>
      </Panel>

      {!designOk && <ErrorState title="Revise el diseño del estudio" detail="Se requieren 2 o 3 operadores distintos. Ningún operador adicional se incluirá en el cálculo; corrija la lista antes de capturar." />}

      <Panel
        title="Lecturas"
        subtitle="Puede pegar un bloque copiado de Excel en cualquier celda: se reparte a partir de ahí"
        actions={<Mono className={`text-2xs ${filled === total ? 'text-ok' : 'text-muted'}`}>{filled}/{total} capturadas</Mono>}
      >
        <p id="matrix-help" className="px-4 py-2 text-2xs text-muted">Tab: siguiente celda · Enter/↑/↓: cambiar de pieza · Punto decimal. El bloque pegado se valida completo antes de aplicarse.</p>
        <div className="max-w-full overflow-x-auto">
          <table className="w-full border-collapse text-2xs">
            <thead>
              <tr className="border-b border-border bg-surface2">
                <th className="px-4 py-2 text-left font-medium uppercase tracking-wide text-muted">Pieza</th>
                {columns.map((c) => (
                  <th key={`${c.op}${c.trial}`} className="px-2 py-2 text-left font-medium uppercase tracking-wide text-muted">
                    <Mono>{c.op}·{c.trial}</Mono>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {partIndexes.map((p) => (
                <tr key={p} className="border-b border-border/60 last:border-0">
                  <td className="px-4 py-1.5"><Mono className="text-muted">P{p}</Mono></td>
                  {columns.map((c, ci) => (
                    <td key={`${c.op}${c.trial}`} className="px-2 py-1.5">
                      <Input
                        inputMode="decimal"
                        data-row={p} data-col={ci}
                        data-invalid={!Number.isFinite(Number(values[key(p,c.op,c.trial)])) || !(values[key(p,c.op,c.trial)] ?? '').trim()}
                        aria-invalid={Boolean((values[key(p,c.op,c.trial)] ?? '').trim()) && !Number.isFinite(Number(values[key(p,c.op,c.trial)])) || (errors.length>0 && !(values[key(p,c.op,c.trial)] ?? '').trim()) || undefined}
                        aria-describedby="matrix-help"
                        onKeyDown={(e)=>moveCell(e,p,ci)}
                        aria-label={`Pieza ${p}, operador ${c.op}, ensayo ${c.trial}`}
                        value={values[key(p, c.op, c.trial)] ?? ''}
                        onChange={(e) => setCell(p, c.op, c.trial, e.target.value)}
                        onPaste={(e) => paste(e, p, ci)}
                        className="min-w-16 font-mono"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-3 border-t border-border px-4 py-3">
          <Field label="Notas" hint="Condiciones del estudio: temperatura, fixture, piezas usadas">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <p className="text-2xs text-muted">
            Quedará registrado a nombre de <Mono className="text-muted">{actorLabel(status.data?.caller)}</Mono>
            {study && status.data?.publish.mode === 'shadow' && ' — la instancia está en modo sombra: el resultado se registra pero NO se envía.'}
          </p>
        </div>
      </Panel>
    </form>
  );
}
