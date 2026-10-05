// test/helpers/fake-core.js
// -----------------------------------------------------------------------------
// A stand-in for the ORCA core's /api/v1/events API, faithful where it matters:
//
//   · validates every POST with the EXACT envelope schema of the core
//     (src/services/validationService.js — copied below, additionalProperties
//     false and all). If our tool's events pass here, the real core accepts them.
//   · idempotent ingest by event_id (`ON CONFLICT DO NOTHING` -> 200 duplicate).
//   · subscriptions return FLAT rows, like `SELECT * FROM industrial_events`,
//     filtered by what the consumer declares in tools.json.
//   · keyset cursor on `seq`, `/events/latest` with `max_seq`.
//   · `x-api-key` required; scopes enforced (read vs write).
// -----------------------------------------------------------------------------
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

// Verbatim from the core: src/services/validationService.js
export const CORE_EVENT_SCHEMA = {
  type: 'object',
  required: ['event_id', 'timestamp', 'platform_version', 'module', 'asset', 'event'],
  properties: {
    event_id: { type: 'string', minLength: 1 },
    timestamp: { type: 'string', format: 'date-time' },
    platform_version: { type: 'string', minLength: 1 },
    module: {
      type: 'object',
      required: ['id', 'version'],
      properties: { id: { type: 'string' }, version: { type: 'string' } },
      additionalProperties: false
    },
    asset: {
      type: 'object',
      required: ['asset_id'],
      properties: {
        asset_id: { type: 'string' },
        asset_type: { type: 'string', nullable: true },
        plant_id: { type: 'string', nullable: true },
        area_id: { type: 'string', nullable: true },
        line_id: { type: 'string', nullable: true },
        location: { type: 'string', nullable: true }
      },
      additionalProperties: false
    },
    event: {
      type: 'object',
      required: ['type'],
      properties: {
        type: { type: 'string' },
        category: { type: 'string', nullable: true },
        severity: { type: 'string', nullable: true }
      },
      additionalProperties: false
    },
    data: { type: 'object' },
    metadata: { type: 'object' },
    correlation_id: { type: 'string', nullable: true },
    causation_id: { type: 'string', nullable: true }
  },
  additionalProperties: false
};

// The core compiles with removeAdditional:true, which would silently strip
// extra keys. Here we compile WITHOUT it, so an extra key FAILS the test
// instead of being hidden — stricter than production, on purpose.
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
export const validateCoreEvent = ajv.compile(CORE_EVENT_SCHEMA);

function toRow (envelope, seq) {
  return {
    id: randomUUID(),
    seq,
    event_id: envelope.event_id,
    timestamp: envelope.timestamp,
    platform_version: envelope.platform_version,
    module_id: envelope.module?.id,
    module_version: envelope.module?.version,
    asset_id: envelope.asset?.asset_id,
    asset_type: envelope.asset?.asset_type ?? null,
    plant_id: envelope.asset?.plant_id ?? null,
    area_id: envelope.asset?.area_id ?? null,
    line_id: envelope.asset?.line_id ?? null,
    location: envelope.asset?.location ?? null,
    event_type: envelope.event?.type,
    category: envelope.event?.category ?? null,
    severity: envelope.event?.severity ?? null,
    data: envelope.data || {},
    metadata: envelope.metadata || {},
    correlation_id: envelope.correlation_id || envelope.event_id,
    causation_id: envelope.causation_id ?? null,
    received_at: new Date().toISOString()
  };
}

/**
 * @param {object} opts
 * @param {Record<string,string[]>} opts.consumes  toolId -> event types (tools.json)
 * @param {string} opts.key   accepted x-api-key (scopes events:read + events:write)
 * @param {string} [opts.readOnlyKey]  a key with events:read only
 */
export async function startFakeCore ({ consumes, key = 'core-test-key', readOnlyKey = 'core-read-only' }) {
  const rows = [];
  const posted = []; // every POST body, valid or not
  const rejected = []; // { body, errors }
  let seq = 0;
  let failNext = 0; // simulate outages: next N requests answer 503
  let failPosts = 0; // simulate an outage that hits only publishing

  function append (envelope) {
    const existing = rows.find((r) => r.event_id === envelope.event_id);
    if (existing) return { row: existing, duplicate: true };
    seq += 1;
    const row = toRow(envelope, seq);
    rows.push(row);
    return { row, duplicate: false };
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    if (failNext > 0) {
      failNext -= 1;
      return send(503, { error: 'temporarily unavailable' }, { 'retry-after': '0' });
    }

    const presented = req.headers['x-api-key'];
    if (!presented) return send(401, { error: 'API key required' });
    if (presented !== key && presented !== readOnlyKey) return send(401, { error: 'Invalid API key' });

    const p = url.pathname.replace(/^\/api\/v1/, '');
    const sinceSeq = url.searchParams.has('since_seq') ? Number(url.searchParams.get('since_seq')) : null;
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 1000);
    const types = (url.searchParams.get('type') || '').split(',').filter(Boolean);

    if (req.method === 'GET' && p === '/events/latest') {
      const matching = rows.filter((r) => !types.length || types.includes(r.event_type));
      const max = matching.length ? Math.max(...matching.map((r) => r.seq)) : null;
      return send(200, { count: matching.length ? 1 : 0, max_seq: max, events: [] });
    }

    const sub = p.match(/^\/events\/subscriptions\/([^/]+)$/);
    if (req.method === 'GET' && sub) {
      const wanted = consumes[sub[1]];
      if (!wanted) return send(404, { error: `Unknown tool '${sub[1]}'` });
      const events = rows
        .filter((r) => wanted.includes(r.event_type) && (sinceSeq == null || r.seq > sinceSeq))
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
      const next = events.length ? events[events.length - 1].seq : sinceSeq;
      return send(200, { consumer: sub[1], consumes: wanted, count: events.length, next_seq: next, events });
    }

    if (req.method === 'GET' && p === '/events') {
      if (sinceSeq == null) return send(400, { error: 'Provide either since_seq (keyset) or both start and end' });
      const events = rows
        .filter((r) => (!types.length || types.includes(r.event_type)) && r.seq > sinceSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
      return send(200, { count: events.length, next_seq: events.length ? events[events.length - 1].seq : sinceSeq, events });
    }

    if (req.method === 'POST' && p === '/events') {
      if (presented !== key) return send(403, { error: 'Insufficient scope' });
      if (failPosts > 0) {
        failPosts -= 1;
        req.resume();
        return send(503, { error: 'temporarily unavailable' }, { 'retry-after': '0' });
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { return send(400, { error: 'invalid json' }); }
        posted.push(parsed);
        if (!validateCoreEvent(parsed)) {
          rejected.push({ body: parsed, errors: validateCoreEvent.errors });
          return send(400, { error: 'Invalid event format', details: validateCoreEvent.errors });
        }
        const { row, duplicate } = append(parsed);
        if (duplicate) return send(200, { status: 'duplicate', event_id: row.event_id, seq: row.seq, triggered: 0, chain: [] });
        return send(201, { status: 'accepted', event_id: row.event_id, seq: row.seq, triggered: 0, chain: [] });
      });
      return undefined;
    }

    return send(404, { error: 'not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    key,
    readOnlyKey,
    rows,
    posted,
    rejected,
    /** Seed an event as if another tool had published it. Returns the flat row. */
    seed (envelope) {
      if (!validateCoreEvent(envelope)) throw new Error('seed is not a valid core event: ' + JSON.stringify(validateCoreEvent.errors));
      return append(envelope).row;
    },
    published (type) {
      return rows.filter((r) => r.event_type === type && r.module_id !== 'test-producer');
    },
    failNextRequests (n) { failNext = n; },
    failNextPublishes (n) { failPosts = n; },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

let counter = 0;
/** A valid core event from a pretend producer. */
export function producedEvent ({ type, data, asset = { asset_id: 'LINE-2-ST-4', plant_id: 'plant_01' }, moduleId = 'test-producer', correlationId }) {
  counter += 1;
  const eventId = randomUUID();
  return {
    event_id: eventId,
    timestamp: new Date(Date.now() + counter).toISOString(),
    platform_version: '1.0',
    module: { id: moduleId, version: '1.0.0' },
    asset,
    event: { type, category: 'quality', severity: 'low' },
    data,
    metadata: { shift: 'A' },
    correlation_id: correlationId || eventId,
    causation_id: null
  };
}
