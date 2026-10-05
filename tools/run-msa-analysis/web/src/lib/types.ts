/** Shapes returned by this tool's /api. Kept in one place for both screens. */

export interface Actor {
  kind: 'user' | 'service' | 'open' | string;
  ref: string | null;
  name: string | null;
  role: string | null;
}

export type PublishState =
  | 'not_required'
  | 'awaiting_decision'
  | 'awaiting_capture'
  | 'shadow'
  | 'published'
  | 'duplicate'
  | 'failed'
  | 'retrying';

export interface PublishInfo {
  state: PublishState;
  eventId?: string;
  seq?: number | null;
  at?: string;
  error?: string;
  status?: number | null;
  event?: unknown;
}

export interface StudyBase {
  id: string;
  tool: string;
  source: 'platform' | 'manual';
  status: 'completed' | 'skipped' | 'pending' | 'error';
  reason: string | null;
  warnings: string[];
  verdict: string | null;
  publish: PublishInfo;
  actor: Actor | null;
  publishedBy?: Actor | null;
  inputEventId: string | null;
  inputSeq?: number | null;
  correlationId?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Tier {
  tier: 'memory' | 'postgres';
  durable: boolean;
  detail: string;
}

export interface PollerStatus {
  enabled: boolean;
  reason: string | null;
  state: 'stopped' | 'disabled' | 'polling' | 'idle' | 'backoff' | 'error';
  consumes: string[];
  cursor: number | null;
  coldStart: { at: string; seq: number } | null;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastError: { message: string; kind: string; at: string } | null;
  processedTotal: number;
  lastBatch: number;
  nextPollAt: string | null;
  intervalMs: number;
}

export interface ToolStatus {
  tool: { id: string; name: string; clause: string; version: string; consumes: string[]; produces: string[] };
  auth: 'sso' | 'open';
  caller: Actor | null;
  persistence: Tier;
  publish: { mode: 'shadow' | 'live' };
  core: { configured: boolean; baseUrl: string | null };
  poller: PollerStatus;
}
