/** Shapes of /api/settings — the editable acceptance criteria of a tool. */
import type { Actor } from './types';

export interface FieldBound {
  min: number;
  max: number;
  step: number;
  label: string;
  unit?: string;
  reference?: number;
  integer?: boolean;
}

export interface CriteriaChange {
  field: string;
  label: string;
  from: number | null;
  to: number | null;
}

export interface CriteriaHistoryEntry {
  version: number;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  reason: string | null;
  actor: Actor | null;
  at: string;
}

export type CriteriaValues = Record<string, number | Record<string, number>>;

export interface CriteriaResponse {
  settings: CriteriaValues;
  defaults: CriteriaValues;
  bounds: Record<string, FieldBound>;
  version: number;
  updatedAt: string | null;
  updatedBy: Actor | null;
  reason: string | null;
  isDefault: boolean;
  canEdit: boolean;
  appliesTo: 'new_studies';
  history: CriteriaHistoryEntry[];
  persistence: { tier: 'memory' | 'postgres'; durable: boolean; detail: string };
}

export interface ImpactExample {
  id: string;
  label: string;
  from: string;
  to: string;
  [extra: string]: unknown;
}

export interface Impact {
  evaluated: number;
  changed: number;
  examples: ImpactExample[];
  [counter: string]: unknown;
}

export interface PreviewResponse {
  settings: CriteriaValues;
  version: number;
  changes: CriteriaChange[];
  noChange: boolean;
  deviations: string[];
  impact: Impact | null;
}
