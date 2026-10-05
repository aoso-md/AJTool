// src/platform/ies.js
// -----------------------------------------------------------------------------
// Industrial Event Standard (IES) — the envelope the ORCA core accepts and
// stores. Source of truth: `src/data/agents/event-standard.json` and
// `src/services/validationService.js` in the core repo.
//
// Two shapes reach this tool, and they are NOT the same:
//
//   1. FLAT ROWS. `GET /events/subscriptions/:toolId` returns database rows
//      (`SELECT * FROM industrial_events`): `event_type`, `asset_id`,
//      `module_id`, `seq`, ... at the top level.
//   2. NESTED ENVELOPES. What producers POST: `event.type`, `asset.asset_id`,
//      `module.id`, ...
//
// `fromCore` reads either one into a single internal shape, so the rest of the
// tool never has to know which door an event came through.
//
// `buildChild` is the mirror of `buildChildEvent` in the core's eventBus.js.
// Same fields, same inheritance rules (asset, metadata, platform_version,
// correlation_id; causation_id = parent event_id). A federated tool that
// publishes anything else breaks the causal chain the ISO evidence log shows.
//
// The core validates with `additionalProperties: false` at the envelope level,
// in `module`, in `asset` and in `event`. Any extra key there is a 400.
// -----------------------------------------------------------------------------
import { createHash } from 'node:crypto';

// Fixed namespace for this repo's deterministic event ids. Never change it:
// changing it turns every previously published id into a new one, and a
// replay would then publish duplicates instead of being discarded.
const EVENT_ID_NAMESPACE = 'b3a1f6d2-6c4e-5a8b-9f17-2d4c8e0a7b51';

const ASSET_KEYS = ['asset_id', 'asset_type', 'plant_id', 'area_id', 'line_id', 'location'];

/** RFC 4122 version-5 UUID (SHA-1, name-based). Same input -> same id, always. */
export function uuidv5 (name, namespace = EVENT_ID_NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(String(name), 'utf8').digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Deterministic id for an event this tool publishes.
 *
 * The core ingests with `ON CONFLICT (event_id) DO NOTHING` and answers a
 * repeat with `status: "duplicate"`. Deriving our id from what caused it means a
 * re-processed input (restart, cursor reset, retry after a network error) is
 * discarded by the platform instead of producing a second nonconformity review.
 * The core README recommends exactly this for idempotent consumers.
 */
export function deterministicEventId (toolId, seed, eventType) {
  return uuidv5(`${toolId}|${eventType}|${seed}`);
}

function asObject (value) {
  if (value == null) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
}

/** Keep only the keys the core's `asset` schema allows, and drop empty ones. */
export function cleanAsset (asset) {
  const out = {};
  for (const key of ASSET_KEYS) {
    const value = asset?.[key];
    if (value !== undefined && value !== null && value !== '') out[key] = String(value);
  }
  return out;
}

/** Read a flat row OR a nested envelope into one internal shape. */
export function fromCore (raw) {
  const r = raw || {};
  const nested = r.event && typeof r.event === 'object';

  const asset = nested
    ? cleanAsset(r.asset)
    : cleanAsset({
      asset_id: r.asset_id,
      asset_type: r.asset_type,
      plant_id: r.plant_id,
      area_id: r.area_id,
      line_id: r.line_id,
      location: r.location
    });

  const seq = r.seq == null ? null : Number(r.seq);

  return {
    eventId: r.event_id ?? null,
    seq: Number.isFinite(seq) ? seq : null,
    type: nested ? r.event.type : r.event_type,
    category: nested ? r.event.category ?? null : r.category ?? null,
    severity: nested ? r.event.severity ?? null : r.severity ?? null,
    timestamp: r.timestamp ?? null,
    platformVersion: r.platform_version || '1.0',
    module: nested
      ? { id: r.module?.id ?? null, version: r.module?.version ?? null }
      : { id: r.module_id ?? null, version: r.module_version ?? null },
    asset,
    data: asObject(r.data),
    metadata: asObject(r.metadata),
    correlationId: r.correlation_id || r.event_id || null,
    causationId: r.causation_id ?? null
  };
}

function envelope ({ eventId, platformVersion, toolId, toolVersion, asset, type, category, severity, data, metadata, correlationId, causationId }) {
  const cleaned = cleanAsset(asset);
  if (!cleaned.asset_id) {
    throw new Error('IES: asset.asset_id is required by the core and could not be resolved');
  }
  const event = { type };
  if (category) event.category = category;
  if (severity) event.severity = severity;

  return {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform_version: platformVersion || '1.0',
    module: { id: toolId, version: toolVersion },
    asset: cleaned,
    event,
    data: data || {},
    metadata: metadata || {},
    correlation_id: correlationId || eventId,
    causation_id: causationId ?? null
  };
}

/**
 * Event produced IN RESPONSE to a platform event. Inherits asset, metadata,
 * platform_version and correlation; causation points at the parent.
 */
export function buildChild ({ parent, toolId, toolVersion, type, category, severity, data, metadata }) {
  const eventId = deterministicEventId(toolId, parent.eventId, type);
  return envelope({
    eventId,
    platformVersion: parent.platformVersion,
    toolId,
    toolVersion,
    asset: parent.asset,
    type,
    category,
    severity,
    data,
    metadata: { ...parent.metadata, ...(metadata || {}) },
    correlationId: parent.correlationId || parent.eventId,
    causationId: parent.eventId
  });
}

/**
 * Event that STARTS a chain: a study captured by a person, with no platform
 * event behind it. `seed` must be stable for that study so a second click on
 * "publish" is a duplicate, not a second event.
 */
export function buildRoot ({ seed, toolId, toolVersion, asset, type, category, severity, data, metadata }) {
  const eventId = deterministicEventId(toolId, `root:${seed}`, type);
  return envelope({
    eventId,
    platformVersion: '1.0',
    toolId,
    toolVersion,
    asset,
    type,
    category,
    severity,
    data,
    metadata,
    correlationId: eventId,
    causationId: null
  });
}

export default { uuidv5, deterministicEventId, cleanAsset, fromCore, buildChild, buildRoot };
