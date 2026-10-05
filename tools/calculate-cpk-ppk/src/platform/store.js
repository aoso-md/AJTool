// src/platform/store.js
// -----------------------------------------------------------------------------
// Persistence: studies (what people and the platform asked this tool to
// compute), the poll cursor, and the spec cache.
//
// Two honest tiers:
//   memory    always on. Lost on restart. What you get with no DATABASE_URL.
//   postgres  when DATABASE_URL is set. Survives restarts and redeploys.
//
// Every write goes to memory first and to Postgres second, and reads prefer
// Postgres while it is healthy. A database outage therefore degrades the tool
// to memory instead of failing requests — and `tier()` says so, so /ready and
// the UI never claim durability that isn't there.
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

const MEMORY_STUDY_LIMIT = 500;

function createMemoryStore () {
  const studies = new Map();
  const cursors = new Map();
  const specs = new Map();

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
    async findSpec (partId, characteristicId) {
      if (partId && specs.has(specKey(partId, characteristicId))) return { ...specs.get(specKey(partId, characteristicId)) };
      // No part-specific spec: the most recent one for this characteristic.
      let best = null;
      for (const s of specs.values()) {
        if (s.characteristicId !== characteristicId) continue;
        if (!best || Number(s.sourceSeq ?? -1) > Number(best.sourceSeq ?? -1)) best = s;
      }
      return best ? { ...best } : null;
    }
  };
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS studies (
    id             TEXT        PRIMARY KEY,
    tool           TEXT        NOT NULL,
    status         TEXT        NOT NULL,
    input_event_id TEXT,
    created_at     TIMESTAMPTZ NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL,
    doc            JSONB       NOT NULL
  );
  CREATE INDEX IF NOT EXISTS studies_tool_created_idx ON studies (tool, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS studies_tool_input_event_uidx
    ON studies (tool, input_event_id) WHERE input_event_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS consumer_cursors (
    name       TEXT        PRIMARY KEY,
    seq        BIGINT      NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS spec_cache (
    part_id           TEXT        NOT NULL DEFAULT '',
    characteristic_id TEXT        NOT NULL,
    usl               DOUBLE PRECISION NOT NULL,
    lsl               DOUBLE PRECISION NOT NULL,
    version           TEXT,
    source_event_id   TEXT,
    source_seq        BIGINT,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (part_id, characteristic_id)
  );
`;

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

export async function createStore ({ databaseUrl, log = console } = {}) {
  const memory = createMemoryStore();
  const state = { configured: Boolean(databaseUrl), healthy: false, lastError: null };
  let pool = null;

  if (state.configured) {
    try {
      const pg = await import('pg');
      const Pool = pg.default?.Pool || pg.Pool;
      pool = new Pool({
        connectionString: databaseUrl,
        ssl: sslFor(databaseUrl),
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000
      });
      pool.on('error', (error) => {
        state.healthy = false;
        state.lastError = error.message;
        log.error?.(`[store] idle client error — service stays up, falling back to memory: ${error.message}`);
      });
      await pool.query(SCHEMA_SQL);
      state.healthy = true;
      log.info?.('[store] postgres ready — studies, cursor and specs are durable');
    } catch (error) {
      state.healthy = false;
      state.lastError = error.message;
      log.error?.(`[store] postgres unavailable, using memory only: ${error.message}`);
    }
  } else {
    log.info?.('[store] DATABASE_URL not set — memory only (lost on restart)');
  }

  // Run against Postgres when it's up; on failure record it and return null so
  // the caller falls back to memory. Never throws.
  async function pg (fn) {
    if (!pool || !state.healthy) return null;
    try {
      const result = await fn(pool);
      return result === undefined ? true : result;
    } catch (error) {
      state.healthy = false;
      state.lastError = error.message;
      log.error?.(`[store] postgres error, serving from memory: ${error.message}`);
      return null;
    }
  }

  // Try to come back after an outage. Cheap; called from ping().
  async function recover () {
    if (!pool || state.healthy) return;
    try {
      await pool.query('SELECT 1');
      state.healthy = true;
      state.lastError = null;
      log.info?.('[store] postgres reachable again');
    } catch (error) {
      state.lastError = error.message;
    }
  }

  return {
    tier () {
      if (!state.configured) {
        return { tier: 'memory', durable: false, detail: 'DATABASE_URL no configurada: los últimos 500 estudios viven en memoria y se pierden al reiniciar.' };
      }
      if (!state.healthy) {
        return { tier: 'memory', durable: false, detail: `DATABASE_URL configurada pero Postgres no responde: ${state.lastError || 'sin detalle'}. Se sirve desde memoria.` };
      }
      return { tier: 'postgres', durable: true, detail: 'Estudios, cursor de suscripción y especificaciones sobreviven reinicios y redespliegues.' };
    },

    async ping () {
      await recover();
      if (!state.configured) return true; // memory is "ready" by definition
      return state.healthy;
    },

    async saveStudy (study) {
      await memory.saveStudy(study);
      await pg((p) => p.query(
        `INSERT INTO studies (id, tool, status, input_event_id, created_at, updated_at, doc)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE
           SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, doc = EXCLUDED.doc`,
        [study.id, study.tool, study.status, study.inputEventId || null, study.createdAt, study.updatedAt, JSON.stringify(study)]
      ));
    },

    async getStudy (id) {
      const rows = await pg(async (p) => (await p.query('SELECT doc FROM studies WHERE id = $1', [id])).rows);
      if (rows) return rows[0]?.doc || null;
      return memory.getStudy(id);
    },

    async findStudyByInputEvent (tool, eventId) {
      const rows = await pg(async (p) => (await p.query(
        'SELECT doc FROM studies WHERE tool = $1 AND input_event_id = $2 LIMIT 1', [tool, eventId]
      )).rows);
      if (rows) return rows[0]?.doc || null;
      return memory.findStudyByInputEvent(tool, eventId);
    },

    async listStudies (tool, limit = 50) {
      const rows = await pg(async (p) => (await p.query(
        'SELECT doc FROM studies WHERE tool = $1 ORDER BY created_at DESC LIMIT $2', [tool, limit]
      )).rows);
      if (rows) return rows.map((r) => r.doc);
      return memory.listStudies(tool, limit);
    },

    async getCursor (name) {
      const rows = await pg(async (p) => (await p.query('SELECT seq FROM consumer_cursors WHERE name = $1', [name])).rows);
      if (rows) return rows[0] ? Number(rows[0].seq) : null;
      return memory.getCursor(name);
    },

    async setCursor (name, seq) {
      await memory.setCursor(name, seq);
      await pg((p) => p.query(
        `INSERT INTO consumer_cursors (name, seq, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (name) DO UPDATE SET seq = EXCLUDED.seq, updated_at = now()`,
        [name, seq]
      ));
    },

    async upsertSpec (spec) {
      await memory.upsertSpec(spec);
      await pg((p) => p.query(
        `INSERT INTO spec_cache (part_id, characteristic_id, usl, lsl, version, source_event_id, source_seq, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (part_id, characteristic_id) DO UPDATE
           SET usl = EXCLUDED.usl, lsl = EXCLUDED.lsl, version = EXCLUDED.version,
               source_event_id = EXCLUDED.source_event_id, source_seq = EXCLUDED.source_seq, updated_at = now()
           WHERE spec_cache.source_seq IS NULL OR EXCLUDED.source_seq >= spec_cache.source_seq`,
        [spec.partId || '', spec.characteristicId, spec.usl, spec.lsl, spec.version ?? null, spec.sourceEventId ?? null, spec.sourceSeq ?? null]
      ));
    },

    async listSpecs () {
      const rows = await pg(async (p) => (await p.query(
        'SELECT * FROM spec_cache ORDER BY characteristic_id, part_id'
      )).rows);
      if (rows) return rows.map(rowToSpec);
      return memory.listSpecs();
    },

    async findSpec (partId, characteristicId) {
      const rows = await pg(async (p) => (await p.query(
        `SELECT * FROM spec_cache
          WHERE characteristic_id = $2 AND (part_id = $1 OR $1 = '')
          ORDER BY (part_id = $1) DESC, source_seq DESC NULLS LAST
          LIMIT 1`,
        [partId || '', characteristicId]
      )).rows);
      if (rows) {
        if (rows[0]) return rowToSpec(rows[0]);
        // Fallback: any part, most recent.
        const any = await pg(async (p) => (await p.query(
          'SELECT * FROM spec_cache WHERE characteristic_id = $1 ORDER BY source_seq DESC NULLS LAST LIMIT 1',
          [characteristicId]
        )).rows);
        return any && any[0] ? rowToSpec(any[0]) : null;
      }
      return memory.findSpec(partId, characteristicId);
    },

    async close () {
      if (pool) await pool.end().catch(() => {});
    }
  };
}

export default { createStore };
