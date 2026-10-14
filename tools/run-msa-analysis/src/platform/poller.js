// src/platform/poller.js
// -----------------------------------------------------------------------------
// How a FEDERATED tool receives work on the ORCA platform.
//
// Nobody calls a federated tool. Once the core's deployments.json declares this
// tool's `subdomain`, the bus stops running the core's fallback handler and
// marks the edge "delegated". From then on the events wait in the log, and THIS
// loop has to go and get them:
//
//   GET /api/v1/events/subscriptions/<toolId>?since_seq=<cursor>
//
// Platform rules this file implements (core README §5.3, pasos/09 checklist):
//
//   1. COLD START AT THE TIP, never at since_seq=0. With no saved cursor, ask
//      `/events/latest` for the newest seq of the types we consume and start
//      there. Starting at 0 replays a backlog that was already handled.
//   2. Advance the cursor after EACH event, durably. A crash mid-batch resumes
//      at the first unprocessed event, not at the start of the batch.
//   3. Respect `Retry-After` on 429, back off on 5xx and network errors.
//   4. A publish that can't reach the core does NOT advance the cursor: the
//      event is retried next tick. Combined with deterministic event ids
//      (ies.js), a retry can never become a second event.
//
// IMPORTANT, for whoever registers the subdomain: the moment the core starts
// delegating, if this loop is not running with a valid key, nothing processes
// these events and the ISO chain goes quiet downstream. Check GET /api/status
// shows `state: "idle"` with a recent `lastSuccessAt` BEFORE registering.
// -----------------------------------------------------------------------------
import { fromCore } from './ies.js';

const PAGE = 100;
const MAX_PAGES_PER_TICK = 20;
const MAX_BACKOFF_MS = 60_000;

export function createPoller ({
  toolId,
  consumes,
  core,
  store,
  processEvent,
  beforeTick,
  intervalMs = 5_000,
  enabled = true,
  log = console
}) {
  const cursorName = `subscription:${toolId}`;
  const status = {
    enabled: Boolean(enabled && core.configured),
    reason: !core.configured
      ? 'ISOTOOLS_API_URL / ISOTOOLS_API_KEY no configuradas: la tool funciona desde su interfaz, pero no recibe nada de la plataforma.'
      : !enabled ? 'Suscripción apagada a propósito (POLL_ENABLED=false).' : null,
    state: 'stopped',
    consumes,
    cursor: null,
    coldStart: null,
    lastPollAt: null,
    lastSuccessAt: null,
    lastError: null,
    processedTotal: 0,
    lastBatch: 0,
    nextPollAt: null,
    intervalMs
  };

  let timer = null;
  let stopped = false;
  let delay = intervalMs;
  let running = null;

  async function tick () {
    status.lastPollAt = new Date().toISOString();
    if (beforeTick) await beforeTick();

    let cursor = await store.getCursor(cursorName);
    if (cursor == null) {
      const max = await core.latestMaxSeq(consumes);
      cursor = max ?? 0;
      await store.setCursor(cursorName, cursor);
      status.coldStart = { at: new Date().toISOString(), seq: cursor };
      log.info?.(max == null
        ? '[poll] cold start: no saved cursor and no events of these types yet — starting from the beginning'
        : `[poll] cold start: no saved cursor — starting at the tip (seq=${cursor}); the backlog is not replayed`);
    }

    let processed = 0;
    for (let page = 0; page < MAX_PAGES_PER_TICK; page += 1) {
      const { events } = await core.subscription(toolId, cursor, PAGE);
      const ordered = events
        .map(fromCore)
        .filter((e) => e.seq != null && e.seq > cursor)
        .sort((a, b) => a.seq - b.seq);

      for (const event of ordered) {
        try {
          await processEvent(event);
        } catch (error) {
          // Platform unreachable or auth problem: stop HERE, keep the cursor on
          // the last event that finished. It will be retried next tick.
          if (error?.kind === 'retryable' || error?.kind === 'auth') throw error;
          // Anything else is a defect in our own processing. processEvent is
          // expected to have recorded the failure as a study; blocking the whole
          // subscription forever on one bad event would be worse.
          log.error?.(`[poll] event ${event.eventId} (seq ${event.seq}) failed and was skipped: ${error?.message || error}`);
        }
        cursor = event.seq;
        await store.setCursor(cursorName, cursor);
        processed += 1;
      }

      if (events.length < PAGE) break;
    }

    status.cursor = cursor;
    status.lastSuccessAt = new Date().toISOString();
    status.lastError = null;
    status.lastBatch = processed;
    status.processedTotal += processed;
    if (processed) log.info?.(`[poll] processed ${processed} event(s), cursor=${cursor}`);
  }

  async function loop () {
    if (stopped) return;
    status.state = 'polling';
    try {
      running = tick();
      await running;
      delay = intervalMs;
      status.state = 'idle';
    } catch (error) {
      const kind = error?.kind || 'retryable';
      status.lastError = { message: error?.message || String(error), kind, at: new Date().toISOString() };
      if (kind === 'auth') {
        status.state = 'error';
        delay = MAX_BACKOFF_MS;
      } else {
        status.state = 'backoff';
        delay = error?.retryAfterMs ?? Math.min(delay * 2, MAX_BACKOFF_MS);
      }
      log.warn?.(`[poll] ${status.state}: ${status.lastError.message} — next try in ${Math.round(delay / 1000)} s`);
    } finally {
      running = null;
    }
    if (stopped) return;
    status.nextPollAt = new Date(Date.now() + delay).toISOString();
    timer = setTimeout(loop, delay);
    timer.unref?.();
  }

  return {
    start () {
      if (!status.enabled) {
        status.state = 'disabled';
        log.warn?.(`[poll] disabled: ${status.reason}`);
        return;
      }
      stopped = false;
      loop();
    },
    async stop () {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (running) await running.catch(() => {});
      status.state = 'stopped';
    },
    status: () => ({ ...status }),
    tick
  };
}

/**
 * Publishing, with a safe rollout switch.
 *
 *   CORE_PUBLISH=shadow (default)  compute, store, and record the exact
 *                                  envelope that WOULD be sent — send nothing.
 *   CORE_PUBLISH=live              send it.
 *
 * Why shadow is the default: until the core's deployments.json declares this
 * tool's subdomain, the core still runs its own fallback handler for the same
 * events. A live federated tool during that window means two results for one
 * measurement. Shadow lets the tool run, be checked against real traffic, and be
 * shown — and flips to live in the same change that registers the subdomain.
 */
export function createPublisher ({ core, mode = 'shadow', log = console }) {
  const live = mode === 'live';
  return {
    mode: live ? 'live' : 'shadow',
    async publish (envelope) {
      const at = new Date().toISOString();
      if (!live) return { state: 'shadow', eventId: envelope.event_id, at, event: envelope };
      if (!core.configured) {
        return { state: 'failed', eventId: envelope.event_id, at, event: envelope, error: 'core no configurado' };
      }
      try {
        const result = await core.publish(envelope);
        log.info?.(`[publish] ${envelope.event.type} ${result.outcome} ${result.eventId}`);
        return { state: result.outcome, eventId: result.eventId, seq: result.seq, at, event: envelope };
      } catch (error) {
        // Retryable: let the caller decide (the poller keeps its cursor and
        // retries; a human action reports it). Invalid: recorded, not retried —
        // the same envelope would be rejected the same way.
        if (error?.kind === 'retryable') throw error;
        return { state: 'failed', eventId: envelope.event_id, at, event: envelope, error: error?.message || String(error), status: error?.status ?? null };
      }
    }
  };
}

export default { createPoller, createPublisher };
