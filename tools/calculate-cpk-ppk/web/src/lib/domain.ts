import type { StudyBase } from './types';
import type { Tone } from '../components/primitives';

export interface CapabilityResult {
  sampleSize: number;
  mean: number;
  sigmaWithin: number;
  sigmaOverall: number;
  usl: number;
  lsl: number;
  target: number | null;
  cp: number;
  cpk: number;
  pp: number;
  ppk: number;
  sigmaLevel: number;
  ppmDefects: number;
  observedOutOfSpec: number;
  minimumCpk: number;
  status: 'capable' | 'marginal' | 'not_capable';
  belowTarget: boolean;
}

export interface Spec {
  partId: string | null;
  characteristicId: string;
  usl: number;
  lsl: number;
  version: string | null;
  sourceEventId?: string | null;
  sourceSeq?: number | null;
  updatedAt?: string;
}

export interface CpkStudy extends StudyBase {
  partId: string | null;
  characteristicId: string | null;
  result: CapabilityResult | null;
  spec: (Partial<Spec> & { source?: string }) | null;
  input?: { measurements?: number[] } & Record<string, unknown>;
}

/** Domain verdict -> platform tone. ui/README.md §3: each colour means one thing. */
export function verdictChip(study: CpkStudy): { label: string; tone: Tone } {
  if (study.status === 'skipped') return { label: 'omitido', tone: 'neutral' };
  if (study.status === 'error') return { label: 'error', tone: 'danger' };
  switch (study.result?.status) {
    case 'capable':
      return { label: 'capaz', tone: 'ok' };
    case 'marginal':
      return { label: 'marginal', tone: 'warn' };
    case 'not_capable':
      return { label: 'no capaz', tone: 'danger' };
    default:
      return { label: '—', tone: 'neutral' };
  }
}

export function metricTone(status: CapabilityResult['status'] | undefined): 'ok' | 'warn' | 'danger' | 'default' {
  if (status === 'capable') return 'ok';
  if (status === 'marginal') return 'warn';
  if (status === 'not_capable') return 'danger';
  return 'default';
}

export const fmt = (value: number | null | undefined, digits = 3) =>
  value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);

/**
 * Measurements pasted from anywhere: one per line (an Excel column), or
 * separated by spaces, tabs, semicolons or commas. Decimal POINT only — a comma
 * is always a separator, which is what an Excel column copy produces.
 */
export function parseMeasurements(text: string): { values: number[]; invalid: string[] } {
  const tokens = text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
  const values: number[] = [];
  const invalid: string[] = [];
  for (const t of tokens) {
    const n = Number(t);
    if (Number.isFinite(n)) values.push(n);
    else invalid.push(t);
  }
  return { values, invalid };
}
