import { databaseTransport } from './postgres-transport.js';
import { retryTransaction, digest } from './reliability.js';
// src/platform/store.js
// -----------------------------------------------------------------------------
// Persistence: studies (what people and the platform asked this tool to
// compute), the poll cursor, and the spec cache.
//
// With DATABASE_URL configured, PostgreSQL is authoritative: operations fail
// explicitly on outage and memory is updated only after a confirmed write.
// Memory-only mode is available solely without a configured/required database.
//
// Why the CURSOR must be durable: the platform checklist forbids starting a
// poll at `since_seq=0` (it replays the whole backlog). With the cursor in
// memory only, every restart would cold-start at the tip and silently skip
// whatever arrived while the container was down. With it in Postgres, the
// tool resumes exactly where it stopped.
//
// DESIGN RULE: an idle `pg` client that dies emits 'error' on the pool. With no
// listener Node throws, the process exits, and the service reads as offline
// although the code is fine. The listener below is not optional.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { validateRuntime } from './postgres-contract.js';
import { StartupDatabaseError } from './startup-error.js';

const MEMORY_STUDY_LIMIT = 500;

// PostgreSQL sequences must never pass through an imprecise JS Number.
function sequenceText (value) {
  if ((typeof value === 'number' && !Number.isSafeInteger(value))
    || !['number', 'string', 'bigint'].includes(typeof value)
    || !/^\d+$/.test(String(value))) {
    throw Object.assign(new Error('Invalid sequence: use a nonnegative decimal string or safe integer'), { code: 'invalid_sequence' });
  }
  const sequence = BigInt(value);
  if (sequence > 9223372036854775807n) {
    throw Object.assign(new Error('Invalid sequence: exceeds PostgreSQL BIGINT'), { code: 'invalid_sequence' });
  }
  return sequence.toString();
}

function exactInteger (value) {
  const text = sequenceText(value);
  return BigInt(text) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(text) : text;
}


function sha256Hex (text) {
  return createHash('sha256').update(typeof text === 'string' ? text : JSON.stringify(text), 'utf8').digest('hex');
}

function createMemoryStore () {
  const studies = new Map();
  const cursors = new Map();
  const specs = new Map();
  const settings = new Map();
  const settingsHistory = new Map();
  const identities = new Map();
  const inbox = new Map();
  const outbox = new Map();
  const manualCommands = new Map();

  const specKey = (partId, characteristicId) => `${partId || ''}::${characteristicId}`;

  const store = {
    async saveStudy (study) {
      studies.set(study.id, structuredClone(study));
      if (studies.size > MEMORY_STUDY_LIMIT) {
        const oldest = [...studies.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        studies.delete(oldest.id);
      }
    },
    async getStudy (id) {
      const s = studies.get(id);
      return s ? structuredClone(s) : null;
    },
    async findStudyByInputEvent (tool, eventId) {
      for (const s of studies.values()) {
        if (s.tool === tool && s.inputEventId === eventId) return structuredClone(s);
      }
      return null;
    },
    async listStudies (tool, limit) {
      return [...studies.values()]
        .filter((s) => s.tool === tool)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map((s) => structuredClone(s));
    },
    async getCursor (name) {
      return cursors.has(name) ? exactInteger(cursors.get(name)) : null;
    },
    async getCursorState (name) {
      if (!cursors.has(name)) return null;
      return {
        name,
        seq: String(cursors.get(name)),
        generation: 1,
        updatedAt: new Date().toISOString()
      };
    },
    async setCursor (name, seq) {
      cursors.set(name, String(seq));
    },
    async upsertSpec (spec) {
      const key = specKey(spec.partId, spec.characteristicId);
      const current = specs.get(key);
      if (current && BigInt(current.sourceSeq ?? -1) > BigInt(spec.sourceSeq ?? -1)) return;
      specs.set(key, { ...spec, updatedAt: spec.updatedAt || new Date().toISOString() });
    },
    async listSpecs () {
      return [...specs.values()].sort((a, b) => a.characteristicId.localeCompare(b.characteristicId));
    },
    async getSettings (key) {
      return settings.has(key) ? structuredClone(settings.get(key)) : null;
    },
    async saveSettings (record) {
      settings.set(record.key, structuredClone(record));
      const list = settingsHistory.get(record.key) || [];
      list.unshift({ key: record.key, version: record.version, before: record.before, after: record.doc, reason: record.reason, actor: record.updatedBy, at: record.updatedAt });
      settingsHistory.set(record.key, list.slice(0, 200));
    },
    async listSettingsHistory (key, limit) {
      return structuredClone((settingsHistory.get(key) || []).slice(0, limit));
    },
    async findSpec (partId, characteristicId, { allowGlobal = true } = {}) {
      if (partId && specs.has(specKey(partId, characteristicId))) return { ...specs.get(specKey(partId, characteristicId)) };
      if (!allowGlobal) return null;
      // Only the global record may be used after an exact-piece miss.
      let best = null;
      for (const s of specs.values()) {
        if (s.characteristicId !== characteristicId || (s.partId || '') !== '') continue;
        if (!best || BigInt(s.sourceSeq ?? -1) > BigInt(best.sourceSeq ?? -1)) best = s;
      }
      return best ? { ...best } : null;
    },

    async setRuntimeIdentity ({ tool, environment = 'production', publishMode = 'shadow', schemaVersion = '003', instanceId = null }) {
      identities.set(tool, {
        tool,
        environment,
        publishMode,
        schemaVersion,
        instanceId,
        updatedAt: new Date().toISOString()
      });
    },

    async getRuntimeIdentity (tool) {
      const id = identities.get(tool);
      return id ? structuredClone(id) : null;
    },

    async getInboxRecord (tool, eventId) {
      const rec = inbox.get(`${tool}:${eventId}`);
      return rec ? structuredClone(rec) : null;
    },

    async getOutboxRecord (tool, eventId) {
      const rec = outbox.get(`${tool}:${eventId}`);
      return rec ? structuredClone(rec) : null;
    },

    async listPendingOutbox (tool, { destinationId, limit = 50 } = {}) {
      return [...outbox.values()]
        .filter((o) => o.tool === tool && o.mode === 'live' && (o.state === 'pending' || o.state === 'retry_wait') && (!destinationId || o.destinationId === destinationId))
        .slice(0, limit)
        .map((o) => structuredClone(o));
    },

    async getManualCommand (tool, commandId) {
      const cmd = manualCommands.get(`${tool}:${commandId}`);
      return cmd ? structuredClone(cmd) : null;
    },

    async processEventTransaction ({ tool, consumer, event, cursor, handler }) {
      const inboxKey = `${tool}:${event.eventId}`;
      const existing = inbox.get(inboxKey);
      if (existing) {
        if (existing.inputHash === event.inputHash) {
          if (cursor?.name && cursor.targetSeq != null) {
            cursors.set(cursor.name, String(cursor.targetSeq));
          }
          return {
            ok: true,
            status: 'replay',
            outcome: existing.outcome,
            studyId: existing.studyId,
            errorDetail: existing.errorDetail
          };
        }
        return {
          ok: false,
          status: 'conflict',
          reason: 'input_hash_mismatch',
          eventId: event.eventId,
          existingHash: existing.inputHash,
          incomingHash: event.inputHash
        };
      }

      const identity = identities.get(tool);
      const dbPublishMode = identity?.publishMode || 'shadow';
      let txRejection = null;
      let txIgnored = null;
      const stagedOutbox = [];

      const tx = {
        tool,
        dbPublishMode,
        async saveStudy (study) {
          await store.saveStudy(study);
        },
        async getStudy (id) {
          return await store.getStudy(id);
        },
        async findSpec (partId, characteristicId, opts) {
          return await store.findSpec(partId, characteristicId, opts);
        },
        async upsertSpec (spec) {
          await store.upsertSpec(spec);
        },
        async getSettings (key) {
          return await store.getSettings(key);
        },
        reject ({ code, reason }) {
          txRejection = { code, reason };
        },
        ignore ({ reason }) {
          txIgnored = { reason };
        },
        async stageOutbox ({ eventId, studyId, publicationKey, destinationId, envelopeText, envelopeHash, mode }) {
          const targetMode = mode || dbPublishMode;
          if (dbPublishMode === 'shadow' && targetMode === 'live') {
            throw new Error('Cannot stage live outbox event on a database declared as shadow');
          }
          const state = targetMode === 'shadow' ? 'shadow_recorded' : 'pending';
          const text = typeof envelopeText === 'string' ? envelopeText : JSON.stringify(envelopeText);
          const hash = envelopeHash || sha256Hex(text);
          const rec = {
            outboxId: outbox.size + 1,
            tool,
            eventId,
            studyId: studyId || null,
            publicationKey,
            mode: targetMode,
            destinationId,
            envelopeText: text,
            envelopeHash: hash,
            state,
            attempts: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          outbox.set(`${tool}:${eventId}`, rec);
          stagedOutbox.push(rec);
          return rec.outboxId;
        }
      };

      let handlerResult = null;
      if (handler) {
        handlerResult = await handler(tx);
      }

      let outcome = 'processed';
      let studyId = handlerResult?.studyId || null;
      let errorDetail = null;

      if (txRejection) {
        outcome = 'rejected';
        errorDetail = txRejection.reason;
      } else if (txIgnored) {
        outcome = 'ignored';
        errorDetail = txIgnored.reason;
      }

      const inboxRec = {
        tool,
        eventId: event.eventId,
        consumer,
        sourceSeq: event.sourceSeq != null ? String(event.sourceSeq) : null,
        rawInput: event.rawInput,
        canonicalInput: event.canonicalInput,
        inputHash: event.inputHash,
        outcome,
        studyId,
        errorDetail,
        receivedAt: new Date().toISOString(),
        processedAt: new Date().toISOString()
      };
      inbox.set(inboxKey, inboxRec);

      if (cursor?.name && cursor.targetSeq != null) {
        cursors.set(cursor.name, String(cursor.targetSeq));
      }

      return {
        ok: true,
        status: 'committed',
        outcome,
        studyId,
        stagedOutbox,
        result: handlerResult
      };
    },

    async recordManualCommandTransaction ({ tool, commandId, commandType, commandHash, studyId = null, handler }) {
      const cmdKey = `${tool}:${commandId}`;
      const existing = manualCommands.get(cmdKey);
      if (existing) {
        if (existing.commandHash === commandHash) {
          return {
            ok: true,
            status: 'replay',
            result: existing.result,
            outboxId: existing.outboxId
          };
        }
        return {
          ok: false,
          status: 'conflict',
          reason: 'command_hash_mismatch'
        };
      }

      const identity = identities.get(tool);
      const dbPublishMode = identity?.publishMode || 'shadow';
      let createdOutboxId = null;

      const tx = {
        tool,
        dbPublishMode,
        async getStudyForUpdate (id) {
          return await store.getStudy(id);
        },
        async saveStudy (study) {
          await store.saveStudy(study);
        },
        async getSettings (key) {
          return await store.getSettings(key);
        },
        async stageOutbox ({ eventId, studyId: outboxStudyId, publicationKey, destinationId, envelopeText, envelopeHash, mode }) {
          const targetMode = mode || dbPublishMode;
          if (dbPublishMode === 'shadow' && targetMode === 'live') {
            throw new Error('Cannot stage live outbox event on a database declared as shadow');
          }
          const state = targetMode === 'shadow' ? 'shadow_recorded' : 'pending';
          const text = typeof envelopeText === 'string' ? envelopeText : JSON.stringify(envelopeText);
          const hash = envelopeHash || sha256Hex(text);
          const rec = {
            outboxId: outbox.size + 1,
            tool,
            eventId,
            studyId: outboxStudyId || studyId || null,
            publicationKey,
            mode: targetMode,
            destinationId,
            envelopeText: text,
            envelopeHash: hash,
            state,
            attempts: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          outbox.set(`${tool}:${eventId}`, rec);
          createdOutboxId = rec.outboxId;
          return rec.outboxId;
        }
      };

      const handlerResult = await handler(tx);
      const finalResult = handlerResult?.result !== undefined ? handlerResult.result : handlerResult;
      const rec = {
        tool,
        commandId,
        commandType,
        studyId,
        commandHash,
        outboxId: createdOutboxId,
        status: 'completed',
        result: finalResult,
        createdAt: new Date().toISOString()
      };
      manualCommands.set(cmdKey, rec);

      return {
        ok: true,
        status: 'committed',
        result: finalResult,
        outboxId: createdOutboxId
      };
    }
  };

  return store;
}

export class PersistenceUnavailableError extends Error {
  constructor (cause) {
    super('PostgreSQL obligatorio no disponible; escritura no confirmada.', { cause });
    this.code = 'persistence_unavailable';
    this.kind = 'retryable';
    this.status = 503;
  }
}


function rowToSpec (r) {
  return {
    partId: r.part_id || null,
    characteristicId: r.characteristic_id,
    usl: Number(r.usl),
    lsl: Number(r.lsl),
    version: r.version,
    sourceEventId: r.source_event_id,
    sourceSeq: r.source_seq == null ? null : exactInteger(r.source_seq),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
  };
}

async function findSpecInClient (client, partId, characteristicId, { allowGlobal = true } = {}) {
  const rows = (await client.query(
    `SELECT * FROM public.spec_cache
      WHERE characteristic_id = $2 AND ((part_id = $1 AND $1 <> '') OR (part_id = '' AND $3))
      ORDER BY (part_id = $1) DESC, source_seq DESC NULLS LAST
      LIMIT 1`,
    [partId || '', characteristicId, Boolean(allowGlobal)]
  )).rows;
  return rows[0] ? rowToSpec(rows[0]) : null;
}

export async function createStore ({ databaseUrl, databaseRequired = Boolean(databaseUrl), recoveryBackoffMs = 250, failFast = false, log = console } = {}) {
  const memory = createMemoryStore();
  const state = { configured: Boolean(databaseUrl), required: Boolean(databaseRequired || databaseUrl), healthy: false, lastError: null };
  let pool = null;
  let startupFailure;
  let validationFlight = null;
  let nextRetryAt = 0;
  let closed = false;
  const retryDelay = Math.min(10_000, Math.max(0, Number(recoveryBackoffMs) || 0));

  function markUnavailable (error) {
    state.healthy = false;
    state.lastError = error?.message || 'PostgreSQL unavailable';
    nextRetryAt = Date.now() + retryDelay;
  }

  // One validation/recovery flight per store; concurrent callers share its result.
  // Validation runs before operations too, so it observes effective ACL changes.
  async function ensureAvailable (force = false) {
    if (closed || !pool) throw new PersistenceUnavailableError();
    if (validationFlight) return validationFlight;
    if (!force && !state.healthy && Date.now() < nextRetryAt) throw new PersistenceUnavailableError();
    validationFlight = (async () => {
      try {
        await validateRuntime(pool);
        if (closed) throw new Error('Store is closed');
        state.healthy = true;
        state.lastError = null;
        nextRetryAt = 0;
      } catch (error) {
        markUnavailable(error);
        throw new PersistenceUnavailableError(error);
      }
    })();
    try { await validationFlight; } finally { validationFlight = null; }
  }

  if (state.configured) {
    try {
      const pgModule = await import('pg');
      const Pool = pgModule.default?.Pool || pgModule.Pool;
      pool = new Pool({
        ...databaseTransport(databaseUrl),
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 2_000,
        statement_timeout: 5_000,
        query_timeout: 6_000,
        lock_timeout: 2_000,
        options: '-c search_path=pg_catalog,public'
      });
      pool.on('error', (error) => {
        markUnavailable(error);
        log.error?.(`[store] idle client error — service stays up, persistence unavailable: ${error.message}`);
      });
      await ensureAvailable(true);
      state.healthy = true;
      log.info?.('[store] postgres ready — studies, cursor and specs are durable');
    } catch (error) {
      state.healthy = false;
      state.lastError = error.message;
      startupFailure = error;
      log.error?.(`[store] postgres unavailable: ${error.message}`);
    }
  } else {
    log.info?.(state.required
      ? '[store] DATABASE_URL missing; persistence required, operations rejected'
      : '[store] DATABASE_URL not set; memory only (lost on restart)');
  }

  // Startup is a one-time gate. Runtime failures retain recovery/backoff.
  if (failFast && state.required && !state.healthy) {
    if (pool) await pool.end();
    throw new StartupDatabaseError(startupFailure, state.configured);
  }

  // Required PostgreSQL never silently falls back to volatile state.
  async function pg (fn) {
    if (!state.required) return null;
    await ensureAvailable();
    try {
      const result = await fn(pool);
      return result === undefined ? true : result;
    } catch (error) {
      if (error?.isApplicationError) {
        throw error;
      }
      // Connection/permission/schema failures require revalidation. Logical SQL
      // conflicts and transaction retry errors must not poison the whole store.
      if (!error.code || /^(08|28|53|57|58)/.test(error.code)
        || ['42501','42P01','42703','42883','ECONNREFUSED','ECONNRESET','EPIPE'].includes(error.code)) {
        markUnavailable(error);
        throw new PersistenceUnavailableError(error);
      }
      error.kind = 'retryable'; // poller must not skip an unpersisted event
      throw error;
    }
  }

  return {
    transactional: state.required,
    async withPollerLock (name, run) {
      if (!state.required) return run();
      return this.executeTransaction(async (client) => {
        const { rows: [lock] } = await client.query(
          "SELECT pg_try_advisory_xact_lock(hashtext('ajtool-poller'), hashtext($1)) AS acquired", [name]
        );
        if (!lock.acquired) {
          throw Object.assign(new Error('Subscription already active'), { code: 'subscription_busy', isApplicationError: true });
        }
        return run(client);
      });
    },

    async initializeReplay (tool, environment = 'production') {
      if (!state.required) throw new Error('Replay requires PostgreSQL');
      const name = `subscription:${tool}`;
      return this.withPollerLock(name, async (client) => {
        // Use the same lane lock as event transactions, including older builds.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cursor:${name}`]);
        const refuse = (message) => { throw Object.assign(new Error(message), { isApplicationError: true }); };
        const { rows: [cursor] } = await client.query(
          'SELECT seq::text, generation::text FROM public.consumer_cursors WHERE name=$1 FOR UPDATE', [name]
        );
        if (cursor && (cursor.seq !== '0' || cursor.generation !== '1')) refuse('Existing cursor has progressed');
        const { rows: [prior] } = await client.query(
          'SELECT EXISTS (SELECT 1 FROM public.event_inbox WHERE tool=$1 AND consumer=$2) AS present', [tool,name]
        );
        if (prior.present) refuse('Subscription inbox already contains receipts');
        await client.query(
          "INSERT INTO public.runtime_identity(tool,environment,publish_mode,schema_version) VALUES ($1,$2,'shadow','003') ON CONFLICT(tool) DO NOTHING",
          [tool, environment]
        );
        const { rows: [identity] } = await client.query(
          'SELECT environment,publish_mode,schema_version FROM public.runtime_identity WHERE tool=$1 FOR SHARE', [tool]
        );
        if (identity.publish_mode !== 'shadow' || identity.environment !== environment || identity.schema_version !== '003') {
          refuse('Replay requires a matching shadow runtime identity');
        }
        if (!cursor) await client.query('INSERT INTO public.consumer_cursors(name,seq) VALUES ($1,0)', [name]);
        return { tool, cursor: name, sequence: '0', generation: '1', inserted: !cursor };
      });
    },

    async initializeCursor (name, seq) {
      seq = sequenceText(seq);
      if (!state.required) {
        if (await memory.getCursor(name) == null) await memory.setCursor(name, seq);
        return memory.getCursorState(name);
      }
      await pg((p) => p.query('INSERT INTO public.consumer_cursors(name,seq) VALUES ($1,$2) ON CONFLICT(name) DO NOTHING', [name,seq]));
      return this.getCursorState(name);
    },
    tier () {
      if (state.required && !state.healthy) {
        return { tier: 'unavailable', durable: false, detail: 'PostgreSQL obligatorio no disponible; operaciones rechazadas.' };
      }
      if (!state.configured) {
        return { tier: 'memory', durable: false, detail: 'DATABASE_URL no configurada: los últimos 500 estudios viven en memoria y se pierden al reiniciar.' };
      }

      return { tier: 'postgres', durable: true, detail: 'Estudios, cursor de suscripción y especificaciones sobreviven reinicios y redespliegues.' };
    },

    async ping () {
      if (!state.required) return !closed;
      try { await ensureAvailable(true); return true; } catch { return false; }
    },

    async saveStudy (study) {
      await pg((p) => p.query(
        `INSERT INTO public.studies (id, tool, status, input_event_id, created_at, updated_at, doc)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE
           SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, doc = EXCLUDED.doc`,
        [study.id, study.tool, study.status, study.inputEventId || null, study.createdAt, study.updatedAt, JSON.stringify(study)]
      ));
      await memory.saveStudy(study);
    },

    async getStudy (id) {
      const rows = await pg(async (p) => (await p.query('SELECT doc FROM public.studies WHERE id = $1', [id])).rows);
      if (rows) return rows[0]?.doc || null;
      return memory.getStudy(id);
    },

    async findStudyByInputEvent (tool, eventId) {
      const rows = await pg(async (p) => (await p.query(
        'SELECT doc FROM public.studies WHERE tool = $1 AND input_event_id = $2 LIMIT 1', [tool, eventId]
      )).rows);
      if (rows) return rows[0]?.doc || null;
      return memory.findStudyByInputEvent(tool, eventId);
    },

    async listStudies (tool, limit = 50) {
      const rows = await pg(async (p) => (await p.query(
        'SELECT doc FROM public.studies WHERE tool = $1 ORDER BY created_at DESC LIMIT $2', [tool, limit]
      )).rows);
      if (rows) return rows.map((r) => r.doc);
      return memory.listStudies(tool, limit);
    },

    async getCursor (name) {
      const rows = await pg(async (p) => (await p.query('SELECT seq FROM public.consumer_cursors WHERE name = $1', [name])).rows);
      if (rows) return rows[0] ? exactInteger(rows[0].seq) : null;
      return memory.getCursor(name);
    },

    async getCursorState (name) {
      const rows = await pg(async (p) => (await p.query(
        'SELECT name, seq::text AS seq, generation, updated_at FROM public.consumer_cursors WHERE name = $1',
        [name]
      )).rows);
      if (rows) {
        const r = rows[0];
        if (!r) return null;
        return {
          name: r.name,
          seq: r.seq,
          generation: exactInteger(r.generation),
          updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
        };
      }
      return memory.getCursorState(name);
    },

    async setCursor (name, seq) {
      seq = sequenceText(seq);
      await pg((p) => p.query(
        `INSERT INTO public.consumer_cursors (name, seq, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (name) DO UPDATE SET seq = EXCLUDED.seq, updated_at = now()`,
        [name, seq]
      ));
      await memory.setCursor(name, seq);
    },

    async upsertSpec (spec) {
      await pg((p) => p.query(
        `INSERT INTO public.spec_cache (part_id, characteristic_id, usl, lsl, version, source_event_id, source_seq, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (part_id, characteristic_id) DO UPDATE
           SET usl = EXCLUDED.usl, lsl = EXCLUDED.lsl, version = EXCLUDED.version,
               source_event_id = EXCLUDED.source_event_id, source_seq = EXCLUDED.source_seq, updated_at = now()
           WHERE spec_cache.source_seq IS NULL OR EXCLUDED.source_seq >= spec_cache.source_seq`,
        [spec.partId || '', spec.characteristicId, spec.usl, spec.lsl, spec.version ?? null, spec.sourceEventId ?? null, spec.sourceSeq ?? null]
      ));
      await memory.upsertSpec(spec);
    },

    async listSpecs () {
      const rows = await pg(async (p) => (await p.query(
        'SELECT * FROM public.spec_cache ORDER BY characteristic_id, part_id'
      )).rows);
      if (rows) return rows.map(rowToSpec);
      return memory.listSpecs();
    },

    async findSpec (partId, characteristicId, { allowGlobal = true } = {}) {
      const rows = await pg(async (p) => (await p.query(
        `SELECT * FROM public.spec_cache
          WHERE characteristic_id = $2 AND ((part_id = $1 AND $1 <> '') OR (part_id = '' AND $3))
          ORDER BY (part_id = $1) DESC, source_seq DESC NULLS LAST
          LIMIT 1`,
        [partId || '', characteristicId, Boolean(allowGlobal)]
      )).rows);
      if (rows) {
        if (rows[0]) return rowToSpec(rows[0]);
        return null;
      }
      return memory.findSpec(partId, characteristicId, { allowGlobal });
    },

    // ── Acceptance criteria ───────────────────────────────────────────────────
    async getSettings (key) {
      const rows = await pg(async (p) => (await p.query('SELECT * FROM public.settings WHERE key = $1', [key])).rows);
      if (rows) {
        const r = rows[0];
        if (!r) return null;
        return {
          key: r.key,
          doc: r.doc,
          version: Number(r.version),
          updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
          updatedBy: r.updated_by,
          reason: r.reason
        };
      }
      return memory.getSettings(key);
    },

    async saveSettings ({ key, doc, expectedVersion, actor, reason, before }) {
      const current = await this.getSettings(key);
      const currentVersion = current?.version ?? 0;
      if (Number(expectedVersion) !== currentVersion) return { ok: false, conflict: true, current };

      const record = {
        key,
        doc,
        version: currentVersion + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: actor ?? null,
        reason: reason ?? null,
        before: before ?? current?.doc ?? null
      };

      const written = await pg(async (p) => {
        const client = await p.connect();
        let clientFailure = null;
        const onError = (error) => { clientFailure = error; };
        client.on('error', onError);
        try {
          await client.query('BEGIN');
          const upsert = await client.query(
            `INSERT INTO public.settings (key, doc, version, updated_at, updated_by, reason)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (key) DO UPDATE
               SET doc = EXCLUDED.doc, version = EXCLUDED.version, updated_at = EXCLUDED.updated_at,
                   updated_by = EXCLUDED.updated_by, reason = EXCLUDED.reason
             WHERE settings.version = $7`,
            [key, JSON.stringify(doc), record.version, record.updatedAt, JSON.stringify(actor ?? null), record.reason, currentVersion]
          );
          if (upsert.rowCount === 0) {
            await client.query('ROLLBACK');
            return { conflict: true };
          }
          await client.query(
            `INSERT INTO public.settings_history (key, version, before, after, reason, actor, at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [key, record.version, JSON.stringify(record.before), JSON.stringify(doc), record.reason, JSON.stringify(actor ?? null), record.updatedAt]
          );
          await client.query('COMMIT');
          return { conflict: false };
        } catch (error) {
          clientFailure = error;
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.removeListener('error', onError);
          client.release(clientFailure?.isApplicationError ? undefined : clientFailure);
        }
      });

      if (written && written.conflict) return { ok: false, conflict: true, current: await this.getSettings(key) };
      await memory.saveSettings(record);
      return { ok: true, record, durable: Boolean(written) };
    },

    async listSettingsHistory (key, limit = 20) {
      const rows = await pg(async (p) => (await p.query(
        'SELECT * FROM public.settings_history WHERE key = $1 ORDER BY id DESC LIMIT $2', [key, limit]
      )).rows);
      if (rows) {
        return rows.map((r) => ({
          key: r.key,
          version: Number(r.version),
          before: r.before,
          after: r.after,
          reason: r.reason,
          actor: r.actor,
          at: r.at instanceof Date ? r.at.toISOString() : r.at
        }));
      }
      return memory.listSettingsHistory(key, limit);
    },

    // ── Transactional Inbox / Outbox API (Stage 2) ────────────────────────────
    async setRuntimeIdentity ({ tool, environment = 'production', publishMode = 'shadow', schemaVersion = '003', instanceId = null }) {
      await pg((p) => p.query(`
        INSERT INTO public.runtime_identity (tool, environment, publish_mode, schema_version, instance_id, updated_at)
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (tool) DO UPDATE
          SET environment = EXCLUDED.environment,
              publish_mode = EXCLUDED.publish_mode,
              schema_version = EXCLUDED.schema_version,
              instance_id = EXCLUDED.instance_id,
              updated_at = now()
      `, [tool, environment, publishMode, schemaVersion, instanceId]));
      await memory.setRuntimeIdentity({ tool, environment, publishMode, schemaVersion, instanceId });
    },

    async ensureRuntimeIdentity ({ tool, environment = 'production', publishMode = 'shadow' }) {
      if (!state.required) return;
      await pg(async (p) => {
        await p.query(`INSERT INTO public.runtime_identity(tool,environment,publish_mode,schema_version)
          VALUES ($1,$2,$3,'003') ON CONFLICT(tool) DO NOTHING`, [tool,environment,publishMode]);
        const r = (await p.query('SELECT * FROM public.runtime_identity WHERE tool=$1',[tool])).rows[0];
        if (r.publish_mode !== publishMode || r.environment !== environment || r.schema_version !== '003') {
          throw Object.assign(new Error('Runtime identity mismatch: explicit reviewed transition required'), { code: 'runtime_identity_mismatch', isApplicationError: true });
        }
      });
    },

    async getRuntimeIdentity (tool) {
      const rows = await pg(async (p) => (await p.query(
        'SELECT tool, environment, publish_mode, schema_version, instance_id, updated_at FROM public.runtime_identity WHERE tool = $1',
        [tool]
      )).rows);
      if (rows) {
        const r = rows[0];
        if (!r) return null;
        return {
          tool: r.tool,
          environment: r.environment,
          publishMode: r.publish_mode,
          schemaVersion: r.schema_version,
          instanceId: r.instance_id,
          updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
        };
      }
      return memory.getRuntimeIdentity(tool);
    },

    async getInboxRecord (tool, eventId) {
      const rows = await pg(async (p) => (await p.query(
        'SELECT * FROM public.event_inbox WHERE tool = $1 AND event_id = $2',
        [tool, eventId]
      )).rows);
      if (rows) {
        const r = rows[0];
        if (!r) return null;
        return {
          tool: r.tool,
          eventId: r.event_id,
          consumer: r.consumer,
          sourceSeq: r.source_seq != null ? String(r.source_seq) : null,
          rawInput: r.raw_input,
          canonicalInput: r.canonical_input,
          inputHash: r.input_hash,
          outcome: r.outcome,
          studyId: r.study_id,
          errorDetail: r.error_detail,
          receivedAt: r.received_at instanceof Date ? r.received_at.toISOString() : r.received_at,
          processedAt: r.processed_at instanceof Date ? r.processed_at.toISOString() : r.processed_at
        };
      }
      return memory.getInboxRecord(tool, eventId);
    },

    async getOutboxRecord (tool, eventId) {
      const rows = await pg(async (p) => (await p.query(
        'SELECT * FROM public.event_outbox WHERE tool = $1 AND event_id = $2',
        [tool, eventId]
      )).rows);
      if (rows) {
        const r = rows[0];
        if (!r) return null;
        return {
          outboxId: exactInteger(r.outbox_id),
          tool: r.tool,
          eventId: r.event_id,
          studyId: r.study_id,
          publicationKey: r.publication_key,
          mode: r.mode,
          destinationId: r.destination_id,
          envelopeText: r.envelope_text,
          envelopeHash: r.envelope_hash,
          state: r.state,
          nextAttemptAt: r.next_attempt_at instanceof Date ? r.next_attempt_at.toISOString() : r.next_attempt_at,
          attempts: Number(r.attempts),
          leaseToken: r.lease_token,
          leaseUntil: r.lease_until instanceof Date ? r.lease_until.toISOString() : r.lease_until,
          deliveredAt: r.delivered_at instanceof Date ? r.delivered_at.toISOString() : r.delivered_at,
          lastErrorClass: r.last_error_class,
          lastErrorDetail: r.last_error_detail,
          createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
          updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
        };
      }
      return memory.getOutboxRecord(tool, eventId);
    },

    async listPendingOutbox (tool, { destinationId, limit = 50 } = {}) {
      const rows = await pg(async (p) => {
        const params = [tool, limit];
        let where = "tool = $1 AND mode = 'live' AND state IN ('pending', 'retry_wait')";
        if (destinationId) {
          params.push(destinationId);
          where += ` AND destination_id = $${params.length}`;
        }
        return (await p.query(
          `SELECT * FROM public.event_outbox WHERE ${where} ORDER BY next_attempt_at NULLS FIRST, outbox_id ASC LIMIT $2`,
          params
        )).rows;
      });
      if (rows) {
        return rows.map((r) => ({
          outboxId: exactInteger(r.outbox_id),
          tool: r.tool,
          eventId: r.event_id,
          studyId: r.study_id,
          publicationKey: r.publication_key,
          mode: r.mode,
          destinationId: r.destination_id,
          envelopeText: r.envelope_text,
          envelopeHash: r.envelope_hash,
          state: r.state,
          attempts: Number(r.attempts)
        }));
      }
      return memory.listPendingOutbox(tool, { destinationId, limit });
    },

    async getManualCommand (tool, commandId) {
      const rows = await pg(async (p) => (await p.query(
        'SELECT * FROM public.manual_commands WHERE tool = $1 AND command_id = $2',
        [tool, commandId]
      )).rows);
      if (rows) {
        const r = rows[0];
        if (!r) return null;
        return {
          tool: r.tool,
          commandId: r.command_id,
          commandType: r.command_type,
          studyId: r.study_id,
          commandHash: r.command_hash,
          outboxId: r.outbox_id != null ? exactInteger(r.outbox_id) : null,
          status: r.status,
          result: r.result,
          createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at
        };
      }
      return memory.getManualCommand(tool, commandId);
    },

    async executeTransaction (fn) {
      if (!state.required) {
        return await fn({ isMemory: true });
      }
      return await pg(async (p) => {
        const client = await p.connect();
        let clientFailure = null;
        const onError = (error) => { clientFailure = error; };
        client.on('error', onError);
        try {
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
          const res = await fn(client);
          await client.query('COMMIT');
          return res;
        } catch (error) {
          clientFailure = error;
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.removeListener('error', onError);
          client.release(clientFailure?.isApplicationError ? undefined : clientFailure);
        }
      });
    },

    async processEventTransaction ({ tool, consumer, event, cursor, handler }) {
      if (!state.required) {
        return memory.processEventTransaction({ tool, consumer, event, cursor, handler });
      }

      if (event.canonicalInput?.canonicalVersion===1 && digest(event.canonicalInput)!==event.inputHash) throw Object.assign(new Error('Canonical input hash mismatch'),{code:'invalid_input_hash',kind:'protocol'});
      if (event.sourceSeq != null) sequenceText(event.sourceSeq);
      if (cursor?.targetSeq != null) sequenceText(cursor.targetSeq);
      if (cursor?.expectedSeq != null) sequenceText(cursor.expectedSeq);
      if (cursor?.expectedGeneration != null) sequenceText(cursor.expectedGeneration);

      const txResult = await retryTransaction(() => pg(async (p) => {
        const client = await p.connect();
        let clientFailure = null;
        const onError = (error) => { clientFailure = error; };
        client.on('error', onError);

        try {
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');

          // Lock the lane before the event, including when no cursor row exists.
          // Every worker uses this lock order to avoid cross-event bootstrap races.
          if (cursor?.name) {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cursor:${cursor.name}`]);
          }
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${tool}:${event.eventId}`]);

          // Lock the cursor and fence pages fetched from an obsolete position.
          let cursorRow = null;
          if (cursor?.name) {
            const curRes = await client.query(
              'SELECT seq::text AS seq, generation FROM public.consumer_cursors WHERE name = $1 FOR UPDATE',
              [cursor.name]
            );
            cursorRow = curRes.rows[0] || null;
            if (Object.hasOwn(cursor, 'expectedSeq')
              && (cursorRow?.seq ?? null) !== (cursor.expectedSeq == null ? null : sequenceText(cursor.expectedSeq))) {
              await client.query('ROLLBACK');
              return { ok: false, status: 'stale_cursor', reason: 'cursor_sequence_mismatch' };
            }
            if (cursor.expectedGeneration != null && !cursorRow) {
              await client.query('ROLLBACK');
              return { ok: false, status: 'stale_cursor', reason: 'cursor_generation_missing' };
            }
            if (cursor.expectedGeneration != null && cursorRow) {
              if (BigInt(cursorRow.generation) !== BigInt(cursor.expectedGeneration)) {
                await client.query('ROLLBACK');
                return {
                  ok: false,
                  status: 'stale_cursor',
                  reason: 'cursor_generation_mismatch',
                  currentGeneration: exactInteger(cursorRow.generation),
                  expectedGeneration: exactInteger(cursor.expectedGeneration)
                };
              }
            }
          }

          // 3. Deduplication check in event_inbox
          const inboxRes = await client.query(
            'SELECT input_hash, outcome, study_id, error_detail FROM public.event_inbox WHERE tool = $1 AND event_id = $2',
            [tool, event.eventId]
          );
          if (inboxRes.rows.length > 0) {
            const existing = inboxRes.rows[0];
            if (existing.input_hash === event.inputHash) {
              // Safe replay! Same ID + same canonical content.
              if (cursor?.name && cursor.targetSeq != null) {
                const curSeq = cursorRow?.seq ? BigInt(cursorRow.seq) : -1n;
                const tgtSeq = BigInt(cursor.targetSeq);
                if (tgtSeq > curSeq) {
                  await client.query(`
                    INSERT INTO public.consumer_cursors (name, seq, generation, updated_at)
                    VALUES ($1, $2::bigint, 1, now())
                    ON CONFLICT (name) DO UPDATE
                      SET seq = EXCLUDED.seq, generation = public.consumer_cursors.generation + 1, updated_at = now()
                  `, [cursor.name, cursor.targetSeq.toString()]);
                }
              }
              await client.query('COMMIT');
              return {
                ok: true,
                status: 'replay',
                outcome: existing.outcome,
                studyId: existing.study_id,
                errorDetail: existing.error_detail
              };
            } else {
              // Preserve the original decision; record the conflicting receipt
              // durably without executing the handler or moving the cursor.
              await client.query(`
                INSERT INTO public.event_rejections
                  (tool, event_id, code, reason, raw_input, input_hash, created_at)
                VALUES ($1, $2, 'input_hash_conflict', $3, $4::jsonb, $5, now())
              `, [tool, event.eventId, 'Same event identity received with different canonical content',
                JSON.stringify(event.rawInput), event.inputHash]);
              await client.query('COMMIT');
              return {
                ok: false,
                status: 'conflict',
                reason: 'input_hash_mismatch',
                eventId: event.eventId,
                existingHash: existing.input_hash,
                incomingHash: event.inputHash
              };
            }
          }

          // A different event from an older page must not execute or regress progress.
          if (cursorRow && cursor?.targetSeq != null && BigInt(cursor.targetSeq) <= BigInt(cursorRow.seq)) {
            await client.query('ROLLBACK');
            return { ok: false, status: 'stale_cursor', reason: 'cursor_not_forward' };
          }

          // 4. Query database publish_mode
          const idRes = await client.query(
            'SELECT publish_mode FROM public.runtime_identity WHERE tool = $1',
            [tool]
          );
          const dbPublishMode = idRes.rows[0]?.publish_mode || 'shadow';

          // 5. Construct transactional context
          let txRejection = null;
          let txIgnored = null;
          const stagedStudies = [];
          const stagedOutbox = [];

          const tx = {
            client,
            tool,
            dbPublishMode,
            async saveStudy (study) {
              stagedStudies.push(study);
              await client.query(`
                INSERT INTO public.studies (id, tool, status, input_event_id, created_at, updated_at, doc)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (id) DO UPDATE
                  SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, doc = EXCLUDED.doc
              `, [study.id, study.tool, study.status, study.inputEventId || null, study.createdAt, study.updatedAt, JSON.stringify(study)]);
            },
            async getStudy (id) {
              const res = await client.query('SELECT doc FROM public.studies WHERE id = $1', [id]);
              return res.rows[0]?.doc || null;
            },
            async findSpec (partId, characteristicId, opts = {}) {
              return await findSpecInClient(client, partId, characteristicId, opts);
            },
            async upsertSpec (spec) {
              await client.query(`
                INSERT INTO public.spec_cache (part_id, characteristic_id, usl, lsl, version, source_event_id, source_seq, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, now())
                ON CONFLICT (part_id, characteristic_id) DO UPDATE
                  SET usl = EXCLUDED.usl, lsl = EXCLUDED.lsl, version = EXCLUDED.version,
                      source_event_id = EXCLUDED.source_event_id, source_seq = EXCLUDED.source_seq, updated_at = now()
                  WHERE spec_cache.source_seq IS NULL OR EXCLUDED.source_seq >= spec_cache.source_seq
              `, [spec.partId || '', spec.characteristicId, spec.usl, spec.lsl, spec.version ?? null, spec.sourceEventId ?? null, spec.sourceSeq != null ? spec.sourceSeq.toString() : null]);
            },
            async getSettings (key) {
              const res = await client.query('SELECT * FROM public.settings WHERE key = $1', [key]);
              const r = res.rows[0];
              if (!r) return null;
              return {
                key: r.key,
                doc: r.doc,
                version: Number(r.version),
                updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
                updatedBy: r.updated_by,
                reason: r.reason
              };
            },
            reject ({ code, reason }) {
              txRejection = { code, reason };
            },
            ignore ({ reason }) {
              txIgnored = { reason };
            },
            async stageOutbox ({ eventId, studyId, publicationKey, destinationId, envelopeText, envelopeHash, mode }) {
              const targetMode = mode || dbPublishMode;
              if (dbPublishMode === 'shadow' && targetMode === 'live') {
                const liveErr = new Error('Cannot stage live outbox event on a database declared as shadow');
                liveErr.isApplicationError = true;
                throw liveErr;
              }
              const state = targetMode === 'shadow' ? 'shadow_recorded' : 'pending';
              const text = typeof envelopeText === 'string' ? envelopeText : JSON.stringify(envelopeText);
              const hash = envelopeHash || sha256Hex(text);
              const res = await client.query(`
                INSERT INTO public.event_outbox
                  (tool, event_id, study_id, publication_key, mode, destination_id, envelope_text, envelope_hash, state, attempts, created_at, updated_at)
                VALUES
                  ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, now(), now())
                RETURNING outbox_id
              `, [tool, eventId, studyId || null, publicationKey, targetMode, destinationId, text, hash, state]);
              const outboxId = exactInteger(res.rows[0].outbox_id);
              stagedOutbox.push({ outboxId, eventId, publicationKey, mode: targetMode, state });
              return outboxId;
            }
          };

          // 6. Execute business handler
          let handlerResult = null;
          if (handler) {
            try {
              handlerResult = await handler(tx);
            } catch (handlerError) {
              if (!handlerError?.code || !/^(08|28|53|57|58)/.test(handlerError.code)) {
                handlerError.isApplicationError = true;
              }
              throw handlerError;
            }
          }

          // 7. Determine terminal outcome and record inbox
          let outcome = 'processed';
          let studyId = handlerResult?.studyId || null;
          let errorDetail = null;

          if (txRejection) {
            outcome = 'rejected';
            errorDetail = txRejection.reason;
          } else if (txIgnored) {
            outcome = 'ignored';
            errorDetail = txIgnored.reason;
          }

          const rawInputJson = JSON.stringify(event.rawInput);
          const canonicalInputJson = JSON.stringify(event.canonicalInput);
          const sourceSeqStr = event.sourceSeq != null ? event.sourceSeq.toString() : null;

          await client.query(`
            INSERT INTO public.event_inbox
              (tool, event_id, consumer, source_seq, raw_input, canonical_input, input_hash, outcome, study_id, error_detail, received_at, processed_at)
            VALUES
              ($1, $2, $3, $4::bigint, $5::jsonb, $6::jsonb, $7, $8, $9, $10, now(), now())
          `, [tool, event.eventId, consumer, sourceSeqStr, rawInputJson, canonicalInputJson, event.inputHash, outcome, studyId, errorDetail]);

          if (txRejection) {
            await client.query(`
              INSERT INTO public.event_rejections
                (tool, event_id, code, reason, raw_input, input_hash, created_at)
              VALUES
                ($1, $2, $3, $4, $5::jsonb, $6, now())
            `, [tool, event.eventId, txRejection.code, txRejection.reason, rawInputJson, event.inputHash]);
          }

          // 8. Advance cursor under same transaction
          if (cursor?.name && cursor.targetSeq != null) {
            await client.query(`
              INSERT INTO public.consumer_cursors (name, seq, generation, updated_at)
              VALUES ($1, $2::bigint, 1, now())
              ON CONFLICT (name) DO UPDATE
                SET seq = EXCLUDED.seq, generation = public.consumer_cursors.generation + 1, updated_at = now()
            `, [cursor.name, cursor.targetSeq.toString()]);
          }

          // 9. COMMIT transaction
          await client.query('COMMIT');

          return {
            ok: true,
            status: 'committed',
            outcome,
            studyId,
            stagedStudies,
            stagedOutbox,
            result: handlerResult
          };
        } catch (error) {
          clientFailure = error;
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.removeListener('error', onError);
          client.release(clientFailure?.isApplicationError ? undefined : clientFailure);
        }
      }));

      // 10. Update memory mirrors after confirmed commit
      if (txResult && txResult.ok && txResult.status === 'committed') {
        if (txResult.stagedStudies) {
          for (const s of txResult.stagedStudies) {
            await memory.saveStudy(s);
          }
        }
        if (cursor?.name && cursor.targetSeq != null) {
          await memory.setCursor(cursor.name, cursor.targetSeq);
        }
      } else if (txResult && txResult.ok && txResult.status === 'replay') {
        if (cursor?.name && cursor.targetSeq != null) {
          await memory.setCursor(cursor.name, cursor.targetSeq);
        }
      }

      return txResult;
    },

    async recordManualCommandTransaction ({ tool, commandId, commandType, commandHash, studyId = null, handler }) {
      if (!state.required) {
        return memory.recordManualCommandTransaction({ tool, commandId, commandType, commandHash, studyId, handler });
      }

      const txResult = await retryTransaction(() => pg(async (p) => {
        const client = await p.connect();
        let clientFailure = null;
        const onError = (error) => { clientFailure = error; };
        client.on('error', onError);

        try {
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');

          // Advisory lock per manual command
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cmd:${tool}:${commandId}`]);

          // Check if manual command already exists
          const cmdRes = await client.query(
            'SELECT command_hash, status, result, outbox_id FROM public.manual_commands WHERE tool = $1 AND command_id = $2',
            [tool, commandId]
          );
          if (cmdRes.rows.length > 0) {
            const existing = cmdRes.rows[0];
            if (existing.command_hash === commandHash) {
              await client.query('COMMIT');
              return {
                ok: true,
                status: 'replay',
                result: existing.result,
                outboxId: existing.outbox_id != null ? exactInteger(existing.outbox_id) : null
              };
            }
            await client.query('ROLLBACK');
            return {
              ok: false,
              status: 'conflict',
              reason: 'command_hash_mismatch'
            };
          }

          // Query database publish mode
          const idRes = await client.query(
            'SELECT publish_mode FROM public.runtime_identity WHERE tool = $1',
            [tool]
          );
          const dbPublishMode = idRes.rows[0]?.publish_mode || 'shadow';
          let createdOutboxId = null;
          const stagedStudies = [];

          const tx = {
            client,
            tool,
            dbPublishMode,
            async findSpec (partId, characteristicId, opts = {}) { return findSpecInClient(client, partId, characteristicId, opts); },
            async getStudyForUpdate (id) {
              const res = await client.query('SELECT doc FROM public.studies WHERE id = $1 FOR UPDATE', [id]);
              return res.rows[0]?.doc || null;
            },
            async saveStudy (study) {
              stagedStudies.push(study);
              await client.query(`
                INSERT INTO public.studies (id, tool, status, input_event_id, created_at, updated_at, doc)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (id) DO UPDATE
                  SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, doc = EXCLUDED.doc
              `, [study.id, study.tool, study.status, study.inputEventId || null, study.createdAt, study.updatedAt, JSON.stringify(study)]);
            },
            async getSettings (key) {
              const res = await client.query('SELECT * FROM public.settings WHERE key = $1', [key]);
              const r = res.rows[0];
              if (!r) return null;
              return {
                key: r.key,
                doc: r.doc,
                version: Number(r.version),
                updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
                updatedBy: r.updated_by,
                reason: r.reason
              };
            },
            async stageOutbox ({ eventId, studyId: outboxStudyId, publicationKey, destinationId, envelopeText, envelopeHash, mode }) {
              const targetMode = mode || dbPublishMode;
              if (dbPublishMode === 'shadow' && targetMode === 'live') {
                const liveErr = new Error('Cannot stage live outbox event on a database declared as shadow');
                liveErr.isApplicationError = true;
                throw liveErr;
              }
              const state = targetMode === 'shadow' ? 'shadow_recorded' : 'pending';
              const text = typeof envelopeText === 'string' ? envelopeText : JSON.stringify(envelopeText);
              const hash = envelopeHash || sha256Hex(text);
              const res = await client.query(`
                INSERT INTO public.event_outbox
                  (tool, event_id, study_id, publication_key, mode, destination_id, envelope_text, envelope_hash, state, attempts, created_at, updated_at)
                VALUES
                  ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, now(), now())
                RETURNING outbox_id
              `, [tool, eventId, outboxStudyId || studyId || null, publicationKey, targetMode, destinationId, text, hash, state]);
              createdOutboxId = exactInteger(res.rows[0].outbox_id);
              return createdOutboxId;
            }
          };

          let handlerResult;
          try {
            handlerResult = await handler(tx);
          } catch (handlerError) {
            if (!handlerError?.code || !/^(08|28|53|57|58)/.test(handlerError.code)) {
              handlerError.isApplicationError = true;
            }
            throw handlerError;
          }
          const finalResult = handlerResult?.result !== undefined ? handlerResult.result : handlerResult;

          await client.query(`
            INSERT INTO public.manual_commands
              (tool, command_id, command_type, study_id, command_hash, outbox_id, status, result, created_at)
            VALUES
              ($1, $2, $3, $4, $5, $6, 'completed', $7::jsonb, now())
          `, [tool, commandId, commandType, studyId, commandHash, createdOutboxId, JSON.stringify(finalResult)]);

          await client.query('COMMIT');

          return {
            ok: true,
            status: 'committed',
            result: finalResult,
            outboxId: createdOutboxId,
            stagedStudies
          };
        } catch (error) {
          clientFailure = error;
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.removeListener('error', onError);
          client.release(clientFailure?.isApplicationError ? undefined : clientFailure);
        }
      }));

      if (txResult && txResult.ok && txResult.status === 'committed' && txResult.stagedStudies) {
        for (const s of txResult.stagedStudies) {
          await memory.saveStudy(s);
        }
      }

      return txResult;
    },

    async close () {
      closed = true;
      state.healthy = false;
      if (validationFlight) await validationFlight.catch(() => {});
      if (pool) await pool.end().catch(() => {});
    }
  };
}

export default { createStore };
