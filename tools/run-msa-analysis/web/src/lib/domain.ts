import type { StudyBase } from './types';
import type { Tone } from '../components/primitives';

export interface Observation {
  partId: string;
  operatorId: string;
  trial: number | string;
  value: number;
}

export interface GageResult {
  method: string;
  parts: number;
  appraisers: number;
  trials: number;
  repeatability: number;
  reproducibility: number;
  grr: number;
  partVariation: number;
  totalVariation: number;
  gageRRPercent: number;
  repeatabilityPercent: number;
  reproducibilityPercent: number;
  partVariationPercent: number;
  contributionPercent: number;
  ndc: number;
  verdict: 'acceptable' | 'marginal' | 'unacceptable';
}

export interface MsaStudy extends StudyBase {
  gaugeId: string | null;
  studyType: string;
  result: GageResult | null;
  input?: { observations?: Observation[]; device?: { id?: string; type?: string; nextCalibration?: string } | null };
}

/** Domain verdict -> platform tone. ui/README.md §3: each colour means one thing. */
export function verdictChip(study: MsaStudy): { label: string; tone: Tone } {
  if (study.status === 'pending') return { label: 'esperando captura', tone: 'info' };
  if (study.status === 'skipped') return { label: 'omitido', tone: 'neutral' };
  if (study.status === 'error') return { label: 'error', tone: 'danger' };
  switch (study.result?.verdict) {
    case 'acceptable':
      return { label: 'aceptable', tone: 'ok' };
    case 'marginal':
      return { label: 'marginal', tone: 'warn' };
    case 'unacceptable':
      return { label: 'inaceptable', tone: 'danger' };
    default:
      return { label: '—', tone: 'neutral' };
  }
}

export function metricTone(verdict: GageResult['verdict'] | undefined): 'ok' | 'warn' | 'danger' | 'default' {
  if (verdict === 'acceptable') return 'ok';
  if (verdict === 'marginal') return 'warn';
  if (verdict === 'unacceptable') return 'danger';
  return 'default';
}

export const fmt = (value: number | null | undefined, digits = 3) =>
  value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
