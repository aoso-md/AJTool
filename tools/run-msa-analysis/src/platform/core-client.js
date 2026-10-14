// src/platform/core-client.js
// -----------------------------------------------------------------------------
// Machine-plane client for the ORCA core (`/api/v1/events`).
//
// Server-to-server only. `ISOTOOLS_API_KEY` never reaches the browser — the
// platform template is explicit that putting it in the SPA is leaking it.
//
// The key needs scopes `events:read` (subscriptions, latest, query) and
// `events:write` (publish). A key without `events:write` reads fine and then
// fails every publish with 403, which is why `CoreError.kind` separates that
// case: it is a configuration problem, not something a retry fixes.
// -----------------------------------------------------------------------------

export class CoreError extends Error {
  /**
   * @param {string} message
   * @param {object} info
   * @param {'auth'|'invalid'|'retryable'} info.kind
   *   auth      401/403: wrong key or missing scope. Retrying won't help.
   *   invalid   400/404/422: the request itself is wrong. Retrying won't help.
   *   retryable network, timeout, 429, 5xx. Try again later.
   */
  constructor (message, { status = null, kind = 'retryable', body = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'CoreError';
    this.status = status;
    this.kind = kind;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Accepts the base URL with or without `/api/v1`. The platform docs use both
 * forms (`env-tool.example` includes it, parts of the README don't), and a
 * missing `/api/v1` produces 404s that look exactly like "the core is down".
 */
export function normalizeBaseUrl (raw) {
  if (!raw || !String(raw).trim()) return null;
  let url = String(raw).trim().replace(/\/+$/, '');
  if (!/\/api\/v1$/.test(url)) url += '/api/v1';
  return url;
}

function parseRetryAfter (header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export function createCoreClient ({ baseUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  const base = normalizeBaseUrl(baseUrl);
  const configured = Boolean(base && apiKey);

  async function request (method, path, { query, body } = {}) {
    if (!configured) {
      throw new CoreError('core no configurado (ISOTOOLS_API_URL / ISOTOOLS_API_KEY)', { kind: 'auth' });
    }
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          'x-api-key': apiKey,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? 'timeout' : error?.message || String(error);
      throw new CoreError(`el core no responde: ${reason}`, { kind: 'retryable' });
    }

    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (response.ok) return { status: response.status, body: parsed };

    const status = response.status;
    const detail = parsed && typeof parsed === 'object' ? parsed.error || JSON.stringify(parsed) : parsed;
    if (status === 401 || status === 403) {
      throw new CoreError(
        status === 401
          ? 'el core rechazó la llave (401). Revise ISOTOOLS_API_KEY.'
          : 'a la llave del core le falta un permiso (403). Necesita events:read y events:write.',
        { status, kind: 'auth', body: parsed }
      );
    }
    if (status === 429 || status >= 500) {
      throw new CoreError(`el core respondió ${status}${detail ? `: ${detail}` : ''}`, {
        status,
        kind: 'retryable',
        body: parsed,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after'))
      });
    }
    throw new CoreError(`el core rechazó la solicitud (${status})${detail ? `: ${detail}` : ''}`, {
      status,
      kind: 'invalid',
      body: parsed
    });
  }

  return {
    configured,
    baseUrl: base,

    /** Highest `seq` among these types, or null if none exist yet. Cold start. */
    async latestMaxSeq (types) {
      const { body } = await request('GET', '/events/latest', { query: { type: types } });
      const max = body?.max_seq;
      return max == null ? null : Number(max);
    },

    /** Only the types this tool declares it consumes in the core's tools.json. */
    async subscription (toolId, sinceSeq, limit = 100) {
      const { body } = await request('GET', `/events/subscriptions/${encodeURIComponent(toolId)}`, {
        query: { since_seq: sinceSeq, limit }
      });
      return { events: body?.events || [], nextSeq: body?.next_seq ?? null };
    },

    /** Keyset query by type, for reference data outside our subscription. */
    async query ({ sinceSeq, types, limit = 500 }) {
      const { body } = await request('GET', '/events', {
        query: { since_seq: sinceSeq, type: types, limit }
      });
      return { events: body?.events || [], nextSeq: body?.next_seq ?? null };
    },

    /** Publish. 201 accepted and 200 duplicate are both success. */
    async publish (event) {
      const { status, body } = await request('POST', '/events', { body: event });
      return {
        outcome: body?.status === 'duplicate' || status === 200 ? 'duplicate' : 'published',
        eventId: body?.event_id || event.event_id,
        seq: body?.seq ?? null
      };
    }
  };
}

export default { createCoreClient, normalizeBaseUrl, CoreError };
