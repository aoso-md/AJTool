import { useMemo, useState, type FormEvent } from 'react';
import { Calculator } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button, ErrorState, Field, Input, Mono, Panel, Textarea } from '../components/primitives';
import { useResource } from '../lib/useResource';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { actorLabel } from '../components/StudyMeta';
import { parseMeasurements, type CpkStudy, type Spec } from '../lib/domain';
import type { CriteriaResponse } from '../lib/criteria';

const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

export function NewStudyPage() {
  const specs = useResource(() => api.get<{ specs: Spec[] }>('/api/specs'), []);
  const status = useResource(api.status, []);

  const [partId, setPartId] = useState('');
  const [characteristicId, setCharacteristicId] = useState('');
  const [usl, setUsl] = useState('');
  const [lsl, setLsl] = useState('');
  const [target, setTarget] = useState('');
  const [minimumCpk, setMinimumCpk] = useState(''); // empty = the criteria in force
  const [raw, setRaw] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const criteria = useResource(() => api.get<CriteriaResponse>('/api/settings'), []);
  const parsed = useMemo(() => parseMeasurements(raw), [raw]);
  const known = useMemo(
    () => (specs.data?.specs ?? []).find((s) => s.characteristicId === characteristicId.trim() && (!s.partId || !partId || s.partId === partId.trim())),
    [specs.data, characteristicId, partId],
  );

  // Limits from the platform's approved spec, unless the engineer types others.
  function applyKnownSpec() {
    if (!known) return;
    setUsl(String(known.usl));
    setLsl(String(known.lsl));
  }

  // What the criteria in force say for this characteristic — shown, not sent,
  // unless the engineer types a value to override it for this one study.
  const criteriaNow = criteria.data?.settings;
  const overrideFor = (criteriaNow?.overrides as Record<string, number> | undefined)?.[characteristicId.trim()];
  const effective = criteriaNow
    ? { value: overrideFor ?? (criteriaNow.minimumCpk as number), fromCharacteristic: overrideFor != null }
    : null;
  const minimumHint = effective
    ? `Vacío = criterio vigente: ${effective.value}${effective.fromCharacteristic ? ' (excepción de esta característica)' : ''}. Escriba un valor solo para este estudio; se cambia en general en «Criterios».`
    : 'Vacío = el criterio vigente (pestaña «Criterios»).';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (parsed.invalid.length) {
      setError(`Valores no numéricos en las mediciones: ${parsed.invalid.slice(0, 5).join(', ')}`);
      return;
    }
    setBusy(true);
    try {
      const { study } = await api.post<{ study: CpkStudy }>('/api/studies', {
        partId: partId.trim() || undefined,
        characteristicId: characteristicId.trim() || undefined,
        usl: num(usl),
        lsl: num(lsl),
        target: num(target),
        minimumCpk: num(minimumCpk),
        measurements: parsed.values,
        notes: notes.trim() || undefined,
      });
      navigate(`/estudios/${study.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <PageHeader
        eyebrow="9.1.3 · captura"
        title="Nuevo estudio de capacidad"
        description="Mediciones individuales en orden de producción. El estudio se guarda; escalarlo a especificaciones es una decisión aparte y firmada."
        actions={
          <Button type="submit" variant="primary" loading={busy} disabled={parsed.values.length < 2}>
            <Calculator className="h-3.5 w-3.5" aria-hidden="true" />
            Calcular y guardar
          </Button>
        }
      />

      {error && <ErrorState title="No se pudo calcular el estudio" detail={error} />}

      <Panel title="Pieza y especificación" subtitle="Los límites aprobados llegan de manage_product_specs (PRODUCT_SPEC_UPDATED)">
        <div className="grid gap-4 px-4 py-3 md:grid-cols-2">
          <Field label="Pieza" hint="partId — como aparece en la plataforma">
            <Input value={partId} onChange={(e) => setPartId(e.target.value)} placeholder="PART-001" className="font-mono" />
          </Field>
          <Field label="Característica" hint={known ? `Especificación conocida: v${known.version ?? '—'}` : 'characteristicId'}>
            <Input
              value={characteristicId}
              onChange={(e) => setCharacteristicId(e.target.value)}
              onBlur={() => { if (!usl && !lsl) applyKnownSpec(); }}
              list="known-characteristics"
              placeholder="CHAR-DIAM-01"
              className="font-mono"
            />
            <datalist id="known-characteristics">
              {(specs.data?.specs ?? []).map((s) => (
                <option key={`${s.partId}::${s.characteristicId}`} value={s.characteristicId}>
                  {s.partId ? `${s.partId} · ` : ''}USL {s.usl} · LSL {s.lsl}
                </option>
              ))}
            </datalist>
          </Field>
          <Field label="USL — límite superior" required>
            <Input inputMode="decimal" value={usl} onChange={(e) => setUsl(e.target.value)} placeholder="10.05" className="font-mono" />
          </Field>
          <Field label="LSL — límite inferior" required>
            <Input inputMode="decimal" value={lsl} onChange={(e) => setLsl(e.target.value)} placeholder="9.95" className="font-mono" />
          </Field>
          <Field label="Cpk mínimo" hint={minimumHint}>
            <Input
              inputMode="decimal"
              value={minimumCpk}
              onChange={(e) => setMinimumCpk(e.target.value)}
              placeholder={String(effective?.value ?? '')}
              className="font-mono"
            />
          </Field>
          <Field label="Valor objetivo" hint="Opcional, informativo">
            <Input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} className="font-mono" />
          </Field>
        </div>
        {known && (usl !== String(known.usl) || lsl !== String(known.lsl)) && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-2xs text-muted">
            <span>
              La plataforma tiene para esta característica USL <Mono className="text-text">{known.usl}</Mono> y LSL{' '}
              <Mono className="text-text">{known.lsl}</Mono> (v{known.version ?? '—'}).
            </span>
            <Button type="button" onClick={applyKnownSpec}>Usar especificación aprobada</Button>
          </div>
        )}
      </Panel>

      <Panel
        title="Mediciones"
        subtitle="Una por renglón (columna de Excel) o separadas por espacio, coma o punto y coma. Punto decimal."
        actions={<Mono className="text-2xs text-muted">{parsed.values.length} válidas{parsed.invalid.length ? ` · ${parsed.invalid.length} inválidas` : ''}</Mono>}
      >
        <div className="space-y-4 px-4 py-3">
          <Textarea rows={8} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder={'10.01\n9.98\n10.03\n…'} />
          <Field label="Notas" hint="Contexto del estudio: lote, turno, condición del proceso">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <p className="text-2xs text-faint">
            Quedará registrado a nombre de <Mono className="text-muted">{actorLabel(status.data?.caller)}</Mono>.
          </p>
        </div>
      </Panel>
    </form>
  );
}
