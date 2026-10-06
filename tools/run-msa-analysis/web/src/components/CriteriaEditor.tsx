/**
 * Editor of a tool's acceptance criteria, shared by both tools.
 *
 * Changing what counts as "capable" or "acceptable" changes what a plant ships,
 * so saving is deliberately a two-step action, enforced by the server:
 *
 *   1. «Revisar cambios» asks the server for a PREVIEW: the exact before/after,
 *      the values that depart from the usual reference, and what the change would
 *      have meant for studies already on file. Nothing is written.
 *   2. The dialog asks for the reason and an explicit acknowledgement. Only then
 *      is the change applied — and it is recorded with who, when and why.
 *
 * Existing studies are never re-judged: each keeps the criteria it was evaluated
 * with. The screen says so, because the first question is always "does this
 * change the history?".
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { History, Plus, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { PageHeader } from './PageHeader';
import { Dialog } from './Dialog';
import { Badge, Button, ErrorState, Field, Input, Loading, Metric, Mono, Panel, Textarea, formatTime } from './primitives';
import { actorLabel } from './StudyMeta';
import { ApiError, api } from '../lib/api';
import { useResource } from '../lib/useResource';
import type { CriteriaChange, CriteriaResponse, CriteriaValues, FieldBound, Impact, PreviewResponse } from '../lib/criteria';

const MIN_REASON = 8;

interface Draft {
  fields: Record<string, string>;
  overrides: { id: string; value: string }[];
}

export interface CriteriaEditorProps {
  eyebrow: string;
  title: string;
  description: string;
  /** Scalar fields to show, in order. Labels, limits and units come from the server. */
  fieldKeys: string[];
  /** Per-field one-line explanation (what moving it does). */
  fieldHints: Record<string, string>;
  /** Per-characteristic exceptions (Cpk). Omit for tools that have none. */
  overrides?: { title: string; subtitle: string; idLabel: string; valueLabel: string; knownIds?: string[] };
  /** Turns the server's impact counters into sentences. */
  describeImpact: (impact: Impact) => string[];
  /** Spanish label for a status value in the impact examples. */
  statusLabel: (status: string) => string;
  /** Text shown above the form: what the reference values are. */
  reference: ReactNode;
}

const toDraft = (values: CriteriaValues, fieldKeys: string[]): Draft => ({
  fields: Object.fromEntries(fieldKeys.map((k) => [k, String(values[k] ?? '')])),
  overrides: Object.entries((values.overrides as Record<string, number> | undefined) ?? {}).map(([id, value]) => ({ id, value: String(value) })),
});

function toValues(draft: Draft, fieldKeys: string[], withOverrides: boolean): { values: CriteriaValues; errors: Record<string, string> } {
  const values: CriteriaValues = {};
  const errors: Record<string, string> = {};
  for (const key of fieldKeys) {
    const raw = draft.fields[key]?.trim();
    const n = Number(raw);
    if (!raw || !Number.isFinite(n)) errors[key] = 'Debe ser un número.';
    else values[key] = n;
  }
  if (withOverrides) {
    const map: Record<string, number> = {};
    draft.overrides.forEach((row, index) => {
      const id = row.id.trim();
      const n = Number(row.value);
      if (!id && !row.value.trim()) return; // an untouched blank row is not an error
      if (!id) errors[`override-${index}`] = 'Falta el identificador de la característica.';
      else if (!row.value.trim() || !Number.isFinite(n)) errors[`override-${index}`] = 'Falta el Cpk mínimo.';
      else if (id in map) errors[`override-${index}`] = `«${id}» está repetida.`;
      else map[id] = n;
    });
    values.overrides = map;
  }
  return { values, errors };
}

const same = (a: CriteriaValues, b: CriteriaValues) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

function show(value: number | null | undefined): string {
  return value == null ? '— sin excepción —' : String(value);
}

export function CriteriaEditor(props: CriteriaEditorProps) {
  const { fieldKeys, fieldHints, overrides, describeImpact, statusLabel } = props;
  const { data, error, loading, reload } = useResource(() => api.get<CriteriaResponse>('/api/settings'), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  // Load the draft from the server on first arrival and whenever the version
  // moves (someone else applied a change); never while the person is typing.
  useEffect(() => {
    if (data && (draft === null || baseVersion !== data.version)) {
      setDraft(toDraft(data.settings, fieldKeys));
      setBaseVersion(data.version);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const knownIds = overrides?.knownIds;
  const checked = useMemo(
    () => (draft ? toValues(draft, fieldKeys, Boolean(overrides)) : null),
    [draft, fieldKeys, overrides],
  );

  if (loading && !data) return <Loading label="Cargando criterios" />;
  if (error && !data) return <ErrorState title="No se pudieron cargar los criterios" detail={error.message} />;
  if (!data || !draft || !checked) return <Loading label="Cargando criterios" />;

  const current = data;
  const bounds = current.bounds;
  const dirty = !same(checked.values, current.settings);
  const fieldErrors: Record<string, string> = { ...checked.errors };
  for (const key of fieldKeys) {
    const b: FieldBound | undefined = bounds[key];
    const n = checked.values[key];
    if (b && typeof n === 'number' && !fieldErrors[key]) {
      if (n < b.min || n > b.max) fieldErrors[key] = `Entre ${b.min} y ${b.max}.`;
      else if (b.integer && !Number.isInteger(n)) fieldErrors[key] = 'Debe ser un entero.';
    }
  }
  const valid = Object.keys(fieldErrors).length === 0;
  const readOnly = !current.canEdit;

  function setField(key: string, value: string) {
    setDraft((d) => (d ? { ...d, fields: { ...d.fields, [key]: value } } : d));
    setNotice(null);
  }
  function setOverride(index: number, patch: Partial<{ id: string; value: string }>) {
    setDraft((d) => (d ? { ...d, overrides: d.overrides.map((r, i) => (i === index ? { ...r, ...patch } : r)) } : d));
    setNotice(null);
  }

  async function review() {
    setPreviewing(true);
    setProblem(null);
    try {
      const result = await api.post<PreviewResponse>('/api/settings/preview', { settings: checked!.values });
      if (result.noChange) {
        setNotice('Los valores son iguales a los vigentes: no hay nada que cambiar.');
        return;
      }
      setReason('');
      setAcknowledged(false);
      setPreview(result);
    } catch (e) {
      setProblem(e instanceof ApiError && e.status === 403 ? 'Su rol no permite cambiar los criterios (se requiere un rol de calidad).' : e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function apply() {
    if (!preview) return;
    setApplying(true);
    setProblem(null);
    try {
      const result = await api.request<{ applied?: boolean; version: number }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings: preview.settings, expectedVersion: preview.version, confirm: true, reason }),
      });
      setPreview(null);
      setNotice(`Criterios actualizados · versión ${result.version}. Se aplican a los estudios nuevos; los existentes conservan los suyos.`);
      setDraft(null);
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setPreview(null);
        setDraft(null);
        setProblem('Otra persona cambió los criterios mientras usted los revisaba. Se recargaron los valores vigentes: revise y vuelva a intentarlo.');
        await reload();
      } else {
        setProblem(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setApplying(false);
    }
  }

  const reasonOk = reason.trim().length >= MIN_REASON;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={props.eyebrow}
        title={props.title}
        description={props.description}
        actions={
          <Button
            onClick={() => {
              setDraft(toDraft(current.defaults, fieldKeys));
              setNotice(null);
            }}
            disabled={readOnly}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Valores de referencia
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Versión vigente" value={current.version === 0 ? 'base' : `v${current.version}`} hint={current.isDefault ? 'valores de referencia, sin cambios' : 'personalizada por la planta'} />
        <Metric label="Última modificación" value={current.updatedAt ? formatTime(current.updatedAt).slice(0, 10) : '—'} hint={current.updatedBy ? actorLabel(current.updatedBy) : 'nunca modificada'} />
        <Metric label="Cambios sin aplicar" value={dirty ? 'sí' : 'no'} tone={dirty ? 'warn' : 'default'} hint={dirty ? 'revise antes de aplicar' : 'el formulario coincide con lo vigente'} />
        <Metric label="Persistencia" value={current.persistence.tier} tone={current.persistence.durable ? 'ok' : 'warn'} hint={current.persistence.durable ? 'el historial sobrevive reinicios' : 'sin base de datos: se pierde al reiniciar'} />
      </div>

      <div className="flex items-start gap-3 rounded-md border border-info/40 bg-info/5 px-4 py-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
        <div className="space-y-1 text-2xs text-muted">
          <p className="text-text">Los cambios solo afectan a los estudios nuevos.</p>
          <p>Cada estudio conserva los criterios con los que se evaluó, y el evento que se publica a la plataforma los lleva dentro. Cambiar un valor nunca reclasifica el historial.</p>
        </div>
      </div>

      {notice && <div className="rounded-md border border-ok/40 bg-ok/5 px-4 py-3 text-2xs text-ok">{notice}</div>}
      {problem && !preview && <ErrorState title="No se pudo completar la acción" detail={problem} />}
      {readOnly && (
        <div className="rounded-md border border-warn/40 bg-warn/5 px-4 py-3 text-2xs text-warn">
          Solo lectura: cambiar los criterios requiere un rol de calidad (QualityEngineer, QualityManager, TechnicalAuthority o QualityDirector).
        </div>
      )}

      <Panel title="Criterios vigentes" subtitle={props.reference}>
        <div className="grid gap-5 px-4 py-4 md:grid-cols-2">
          {fieldKeys.map((key) => {
            const b = bounds[key];
            return (
              <Field
                key={key}
                label={`${b?.label ?? key}${b?.unit && !(b.label ?? '').includes(b.unit) ? ` (${b.unit})` : ''}`}
                hint={`${fieldHints[key] ?? ''}${b?.reference != null ? ` (referencia: ${b.reference})` : ''}`.trim()}
                error={fieldErrors[key]}
              >
                <Input
                  inputMode="decimal"
                  value={draft.fields[key]}
                  disabled={readOnly}
                  aria-label={b?.label ?? key}
                  aria-invalid={Boolean(fieldErrors[key])}
                  onChange={(e) => setField(key, e.target.value)}
                  className="font-mono"
                />
              </Field>
            );
          })}
        </div>
      </Panel>

      {overrides && (
        <Panel
          title={overrides.title}
          subtitle={overrides.subtitle}
          actions={
            <Button disabled={readOnly} onClick={() => setDraft((d) => (d ? { ...d, overrides: [...d.overrides, { id: '', value: '' }] } : d))}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Agregar excepción
            </Button>
          }
        >
          {draft.overrides.length === 0 ? (
            <p className="px-4 py-5 text-2xs text-faint">Sin excepciones: todas las características usan el Cpk mínimo general.</p>
          ) : (
            <ul>
              {draft.overrides.map((row, index) => (
                <li key={index} className="border-b border-border/60 px-4 py-2.5 last:border-0">
                  <div className="grid grid-cols-[1fr_9rem_auto] items-center gap-2">
                    <Input
                      list="known-characteristics"
                      placeholder={overrides.idLabel}
                      aria-label={overrides.idLabel}
                      value={row.id}
                      disabled={readOnly}
                      onChange={(e) => setOverride(index, { id: e.target.value })}
                      className="font-mono"
                    />
                    <Input
                      inputMode="decimal"
                      placeholder={overrides.valueLabel}
                      aria-label={overrides.valueLabel}
                      value={row.value}
                      disabled={readOnly}
                      onChange={(e) => setOverride(index, { value: e.target.value })}
                      className="font-mono"
                    />
                    <Button
                      variant="ghost"
                      disabled={readOnly}
                      aria-label="Quitar excepción"
                      onClick={() => setDraft((d) => (d ? { ...d, overrides: d.overrides.filter((_, i) => i !== index) } : d))}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                  {fieldErrors[`override-${index}`] && <p className="mt-1 text-2xs text-danger">{fieldErrors[`override-${index}`]}</p>}
                </li>
              ))}
            </ul>
          )}
          {knownIds && (
            <datalist id="known-characteristics">
              {knownIds.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          )}
        </Panel>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {dirty && (
          <Button
            onClick={() => {
              setDraft(toDraft(current.settings, fieldKeys));
              setNotice(null);
            }}
          >
            Descartar cambios
          </Button>
        )}
        <Button variant="primary" disabled={readOnly || !dirty || !valid} loading={previewing} onClick={() => void review()}>
          Revisar cambios…
        </Button>
      </div>

      <Panel title="Historial de cambios" subtitle="Quién cambió qué, cuándo y por qué — se conserva como información documentada">
        {current.history.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-5 text-2xs text-faint">
            <History className="h-3.5 w-3.5" aria-hidden="true" />
            Todavía no se han cambiado los criterios.
          </div>
        ) : (
          <ul>
            {current.history.map((h) => (
              <li key={h.version} className="space-y-1 border-b border-border/60 px-4 py-3 text-2xs last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="info">v{h.version}</Badge>
                  <Mono className="text-muted">{formatTime(h.at)}</Mono>
                  <span className="text-faint">·</span>
                  <Mono className="text-text">{actorLabel(h.actor)}</Mono>
                </div>
                <p className="text-text">{h.reason ?? 'sin motivo registrado'}</p>
                <p className="font-mono text-faint">{summarizeDiff(h.before, h.after)}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {preview && (
        <Dialog
          title="Confirmar cambio de criterios"
          subtitle="Revise el efecto antes de aplicarlo. Quedará registrado a su nombre."
          busy={applying}
          onClose={() => setPreview(null)}
          footer={
            <>
              <Button onClick={() => setPreview(null)} disabled={applying}>
                Cancelar
              </Button>
              <Button variant="primary" onClick={() => void apply()} loading={applying} disabled={!reasonOk || !acknowledged}>
                Aplicar cambio
              </Button>
            </>
          }
        >
          <section>
            <h3 className="mb-2 text-2xs font-medium uppercase tracking-wide text-faint">Qué cambia</h3>
            <div className="overflow-hidden rounded border border-border">
              <table className="w-full text-2xs">
                <thead>
                  <tr className="border-b border-border bg-surface2 text-left text-faint">
                    <th className="px-3 py-1.5 font-medium">Criterio</th>
                    <th className="px-3 py-1.5 font-medium">Antes</th>
                    <th className="px-3 py-1.5 font-medium">Después</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((c: CriteriaChange) => (
                    <tr key={c.field} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-1.5 text-text">{c.label}</td>
                      <td className="px-3 py-1.5"><Mono className="text-muted">{show(c.from)}</Mono></td>
                      <td className="px-3 py-1.5"><Mono className="text-text">{show(c.to)}</Mono></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {preview.deviations.length > 0 && (
            <section className="space-y-1.5 rounded-md border border-warn/40 bg-warn/5 px-3 py-3">
              <h3 className="text-2xs font-medium uppercase tracking-wide text-warn">Se aparta de la referencia</h3>
              {preview.deviations.map((d) => (
                <p key={d} className="text-2xs text-warn">{d}</p>
              ))}
            </section>
          )}

          {preview.impact && (
            <section>
              <h3 className="mb-2 text-2xs font-medium uppercase tracking-wide text-faint">Qué habría significado para los estudios ya registrados</h3>
              <div className="space-y-1 rounded-md border border-border bg-bg px-3 py-3 text-2xs text-muted">
                {describeImpact(preview.impact).map((line) => (
                  <p key={line}>{line}</p>
                ))}
                {preview.impact.examples.length > 0 && (
                  <ul className="mt-2 space-y-0.5 border-t border-border pt-2">
                    {preview.impact.examples.map((ex) => (
                      <li key={ex.id} className="font-mono text-faint">
                        {ex.label}: {statusLabel(ex.from)} → <span className="text-text">{statusLabel(ex.to)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="pt-1 text-faint">Es solo informativo: ninguno de esos estudios se modifica.</p>
              </div>
            </section>
          )}

          <Field label="Motivo del cambio" required hint={`Mínimo ${MIN_REASON} caracteres. Queda en el historial junto a su nombre.`}>
            <Textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ej.: el cliente exige Cpk ≥ 1.67 en características críticas (PO 4411)"
              className="font-sans"
            />
          </Field>

          <label className="flex items-start gap-2 text-2xs text-muted">
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-info)]" />
            <span>Entiendo que esto cambia cómo se clasifican los estudios nuevos, que el historial no se modifica, y que el cambio queda registrado a mi nombre.</span>
          </label>

          {problem && <ErrorState title="No se aplicó el cambio" detail={problem} />}
        </Dialog>
      )}
    </div>
  );
}

function summarizeDiff(before: Record<string, unknown> | null, after: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(after)) {
    if (key === 'overrides') {
      const a = (before?.overrides ?? {}) as Record<string, number>;
      const b = value as Record<string, number>;
      for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[id] !== b[id]) parts.push(`${id}: ${a[id] ?? '—'} → ${b[id] ?? '—'}`);
      }
    } else if (before?.[key] !== value) {
      parts.push(`${key}: ${String(before?.[key] ?? '—')} → ${String(value)}`);
    }
  }
  return parts.join(' · ') || 'sin diferencias';
}
