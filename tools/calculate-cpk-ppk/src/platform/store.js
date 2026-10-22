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

import { validateRuntime } from './postgres-contract.js';
import { StartupDatabaseError } from './startup-error.js';

const MEMORY_STUDY_LIMIT = 500;

function createMemoryStore () {
  const studies = new Map();
  const cursors = new Map();
  const specs = new Map();
  const settings = new Map();
  const settingsHistory = new Map();

  const specKey = (partId, characteristicId) => `${partId || ''}::${characteristicId}`;

  return {
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
      return cursors.has(name) ? cursors.get(name) : null;
    },
    async setCursor (name, seq) {
      cursors.set(name, Number(seq));
    },
    async upsertSpec (spec) {
      const key = specKey(spec.partId, spec.characteristicId);
      const current = specs.get(key);
      if (current && Number(current.sourceSeq ?? -1) > Number(spec.sourceSeq ?? -1)) return;
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
        if (!best || Number(s.sourceSeq ?? -1) > Number(best.sourceSeq ?? -1)) best = s;
      }
      return best ? { ...best } : null;
    }
  };
}

export class PersistenceUnavailableError extends Error {
  constructor (cause) {
    super('PostgreSQL obligatorio no disponible; escritura no confirmada.', { cause });
    this.code = 'persistence_unavailable';
    this.kind = 'retryable';
    this.status = 503;
  }
}

/* Railway's private network (*.railway.internal) rejects TLS; its public proxy
   requires TLS with a self-signed certificate; local Postgres needs neither. */
function sslFor (connectionString) {
  if (/\.railway\.internal/i.test(connectionString)) return false;
  if (/@(localhost|127\.0\.0\.1|postgres|db)(:|\/)/i.test(connectionString)) return false;
  return { rejectUnauthorized: false };
}

function rowToSpec (r) {
  return {
    partId: r.part_id || null,
    characteristicId: r.characteristic_id,
    usl: Number(r.usl),
    lsl: Number(r.lsl),
    version: r.version,
    sourceEventId: r.source_event_id,
    sourceSeq: r.source_seq == null ? null : Number(r.source_seq),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
  };
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
      const pg = await import('pg');
      const Pool = pg.default?.Pool || pg.Pool;
      pool = new Pool({
        connectionString: databaseUrl,
        ssl: sslFor(databaseUrl),
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
      if (rows) return rows[0] ? Number(rows[0].seq) : null;
      return memory.getCursor(name);
    },

    async setCursor (name, seq) {
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

    /**
     * Optimistic concurrency: the write only lands if `expectedVersion` is still
     * the current one. Two engineers editing criteria at once cannot silently
     * overwrite each other — the second gets { conflict: true } and the current
     * values to look at.
     */
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
          client.release(clientFailure);
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

    async close () {
      closed = true;
      state.healthy = false;
      if (validationFlight) await validationFlight.catch(() => {});
      if (pool) await pool.end().catch(() => {});
    }
  };
}

export default { createStore };
