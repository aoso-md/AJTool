// src/tool.js — calculate_cpk_ppk on the ORCA platform
// -----------------------------------------------------------------------------
// Where this tool sits in the ISO chain (core communication-rules.json):
//
//   manage_product_specs ──PRODUCT_SPEC_UPDATED──▶ collect_quality_measurements
//   collect_quality_measurements ──MEASUREMENTS_CAPTURED──▶ calculate_cpk_ppk   (rule-pkg-006)
//   calculate_cpk_ppk ──CAPABILITY_BELOW_TARGET──▶ manage_product_specs          (rule-qual-005,
//                                                   "cpk < 1.33 OR status == 'not_capable'")
//
// The catch: MEASUREMENTS_CAPTURED as the platform actually publishes it
// carries `partId`, `characteristicId` and `measurements` — but NOT the spec
// limits. Those live in PRODUCT_SPEC_UPDATED (`characteristics[].usl/lsl`), which
// this tool does not receive through its subscription. So it keeps a spec
// cache, filled by querying PRODUCT_SPEC_UPDATED on every poll. If a measurement
// arrives for a characteristic with no known spec, the study is recorded as
// SKIPPED with the reason, and nothing is published — computing capability
// against made-up limits would be worse than computing nothing.
//
// Two ways in:
//   platform  the poller hands us MEASUREMENTS_CAPTURED events.
//   manual    a quality engineer enters a study in the UI. Saved, never
//             auto-published: escalation to specs is an explicit, signed action.
// -----------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { analyzeCapability, classify } from './domain/capability.js';
import {
  SETTINGS_KEY, DEFAULTS, BOUNDS, validateCriteria, minimumCpkFor, describeChanges, deviations, impactOn
} from './domain/criteria.js';
import { byPriority, priorityOf, summarize } from './domain/priority.js';
import { createSettingsService } from './platform/settings.js';
import { buildChild, buildRoot, fromCore } from './platform/ies.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const TOOL = Object.freeze({
  id: 'calculate_cpk_ppk',
  name: 'Cálculo de Cpk / Ppk',
  clause: '9.1.3 — análisis y evaluación',
  consumes: ['MEASUREMENTS_CAPTURED'],
  produces: ['CAPABILITY_BELOW_TARGET'],
  // Matches `localPort` in the core's deployments.json entry for this tool.
  localPort: 8108,
  version: pkg.version
});

export const SPEC_EVENT = 'PRODUCT_SPEC_UPDATED';
const SPEC_CURSOR = `specs:${SPEC_EVENT}`;
const DONE_STATES = new Set(['published', 'duplicate', 'shadow', 'not_required', 'failed']);

function num (value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function numbers (value) {
  if (!Array.isArray(value)) return null;
  const out = value.map(num);
  return out.every((v) => v !== undefined) ? out : null;
}

/** Spec limits carried by a PRODUCT_SPEC_UPDATED event (core reference shape). */
export function specsFromEvent (event) {
  const data = event.data || {};
  const partId = data.partId ? String(data.partId) : null;
  const list = Array.isArray(data.characteristics)
    ? data.characteristics
    : data.characteristicId ? [{ id: data.characteristicId, usl: data.usl, lsl: data.lsl, version: data.version }] : [];

  const specs = [];
  for (const c of list) {
    const usl = num(c?.usl);
    const lsl = num(c?.lsl);
    const id = c?.id ?? c?.characteristicId;
    if (!id || usl === undefined || lsl === undefined || lsl >= usl) continue;
    specs.push({
      partId,
      characteristicId: String(id),
      usl,
      lsl,
      version: c.version == null ? null : String(c.version),
      sourceEventId: event.eventId,
      sourceSeq: event.seq
    });
  }
  return specs;
}

export function severityFor (status) {
  if (status === 'not_capable') return 'high';
  if (status === 'marginal') return 'medium';
  return 'low';
}

/** `data` of CAPABILITY_BELOW_TARGET: the contract fields first, then traceability. */
export function belowTargetData (study) {
  const r = study.result;
  return {
    // contract (core tools.json, outputSchema of calculate_cpk_ppk)
    partId: study.partId ?? null,
    characteristicId: study.characteristicId ?? null,
    cp: r.cp,
    cpk: r.cpk,
    pp: r.pp,
    ppk: r.ppk,
    sigmaLevel: r.sigmaLevel,
    ppmDefects: r.ppmDefects,
    status: r.status,
    // traceability — what manage_product_specs needs to review the spec
    minimumCpk: r.minimumCpk,
    minimumCpkSource: study.criteria?.minimumCpkSource ?? null,
    criteriaVersion: study.criteria?.version ?? null,
    usl: r.usl,
    lsl: r.lsl,
    specVersion: study.spec?.version ?? null,
    sampleSize: r.sampleSize,
    mean: r.mean,
    sigmaWithin: r.sigmaWithin,
    sigmaOverall: r.sigmaOverall,
    studyId: study.id
  };
}

function newStudy (fields) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    tool: TOOL.id,
    status: 'completed',
    reason: null,
    warnings: [],
    result: null,
    verdict: null,
    spec: null,
    publish: { state: 'not_required' },
    createdAt: now,
    updatedAt: now,
    ...fields
  };
}

export function createCapabilityTool ({ store, core, publisher, log = console }) {
  // ── Acceptance criteria (editable, with confirmation) ──────────────────────
  const settings = createSettingsService({
    store,
    key: SETTINGS_KEY,
    defaults: DEFAULTS,
    bounds: BOUNDS,
    validate: validateCriteria,
    describeChanges,
    deviations,
    impact: (studies, before, after) => impactOn(studies, before, after, classify),
    recentStudies: () => store.listStudies(TOOL.id, 200)
  });

  /**
   * Run the analysis under the CURRENT criteria and stamp the study with the
   * snapshot it was judged by. `explicit` is a minimum Cpk that came with the
   * event or the form: it beats any configured value.
   */
  async function analyzeUnderCriteria ({ measurements, spec, characteristicId, explicit, target }) {
    const now = await settings.current();
    const min = minimumCpkFor(now.value, characteristicId, explicit);
    const analysis = analyzeCapability({
      measurements,
      usl: spec.usl,
      lsl: spec.lsl,
      minimumCpk: min.value,
      marginalFloor: now.value.marginalFloor,
      recommendedSampleSize: now.value.recommendedSampleSize,
      target
    });
    const criteria = {
      version: now.version,
      minimumCpk: min.value,
      minimumCpkSource: min.source,
      marginalFloor: now.value.marginalFloor,
      recommendedSampleSize: now.value.recommendedSampleSize
    };
    return { analysis, criteria };
  }

  // ── Spec cache ─────────────────────────────────────────────────────────────
  // Reference data, read-only: here starting from seq 0 IS correct (we want
  // every spec ever approved; nothing is published from this, so replaying it
  // cannot duplicate anything).
  async function syncSpecs () {
    if (!core.configured) return;
    let cursor = (await store.getCursor(SPEC_CURSOR)) ?? 0;
    for (let page = 0; page < 50; page += 1) {
      const { events } = await core.query({ sinceSeq: cursor, types: [SPEC_EVENT], limit: 500 });
      for (const raw of events) {
        const event = fromCore(raw);
        for (const spec of specsFromEvent(event)) await store.upsertSpec(spec);
        if (event.seq != null && event.seq > cursor) cursor = event.seq;
      }
      await store.setCursor(SPEC_CURSOR, cursor);
      if (events.length < 500) break;
    }
  }

  async function resolveSpec ({ partId, characteristicId, usl, lsl }) {
    if (usl !== undefined && lsl !== undefined) {
      return { usl, lsl, version: null, source: 'event' };
    }
    if (!characteristicId) return null;
    const cached = await store.findSpec(partId, characteristicId);
    if (!cached) return null;
    return {
      usl: cached.usl,
      lsl: cached.lsl,
      version: cached.version,
      source: 'spec_cache',
      sourceEventId: cached.sourceEventId,
      partId: cached.partId
    };
  }

  async function publishFor (study, envelope) {
    try {
      study.publish = await publisher.publish(envelope);
    } catch (error) {
      study.publish = { state: 'retrying', eventId: envelope.event_id, event: envelope, error: error.message, at: new Date().toISOString() };
      study.updatedAt = new Date().toISOString();
      await store.saveStudy(study);
      throw error;
    }
  }

  // ── Platform path ──────────────────────────────────────────────────────────
  async function processEvent (event) {
    const existing = await store.findStudyByInputEvent(TOOL.id, event.eventId);
    if (existing) {
      if (DONE_STATES.has(existing.publish?.state) || existing.status !== 'completed') return existing;
      if (existing.publish?.state === 'retrying' && existing.publish.event) {
        await publishFor(existing, existing.publish.event);
        existing.updatedAt = new Date().toISOString();
        await store.saveStudy(existing);
      }
      return existing;
    }

    const data = event.data || {};
    const partId = data.partId == null ? null : String(data.partId);
    const characteristicId = data.characteristicId == null ? null : String(data.characteristicId);
    const study = newStudy({
      source: 'platform',
      inputEventId: event.eventId,
      inputSeq: event.seq,
      correlationId: event.correlationId,
      asset: event.asset,
      partId,
      characteristicId,
      input: data,
      actor: { kind: 'service', ref: event.module?.id || 'platform', name: 'plataforma', role: null }
    });

    try {
      const measurements = numbers(data.measurements);
      const spec = await resolveSpec({ partId, characteristicId, usl: num(data.usl), lsl: num(data.lsl) });

      if (!measurements) {
        study.status = 'skipped';
        study.reason = 'El evento no trae un arreglo numérico `measurements`.';
      } else if (!spec) {
        study.status = 'skipped';
        study.reason = `No hay especificación (USL/LSL) conocida para la característica ${characteristicId ?? '(sin id)'}${partId ? ` de la pieza ${partId}` : ''}. Debe publicarse en ${SPEC_EVENT} (manage_product_specs).`;
      } else {
        study.spec = spec;
        const { analysis, criteria } = await analyzeUnderCriteria({ measurements, spec, characteristicId, explicit: num(data.minimumCpk) });
        study.criteria = criteria;
        if (!analysis.ok) {
          study.status = 'skipped';
          study.reason = analysis.errors.join(' ');
        } else {
          study.result = analysis.result;
          study.warnings = analysis.warnings;
          study.verdict = analysis.result.status;
          if (analysis.result.belowTarget) {
            const envelope = buildChild({
              parent: event,
              toolId: TOOL.id,
              toolVersion: TOOL.version,
              type: 'CAPABILITY_BELOW_TARGET',
              category: 'quality',
              severity: severityFor(analysis.result.status),
              data: belowTargetData(study)
            });
            await publishFor(study, envelope);
          }
        }
      }
    } catch (error) {
      if (error?.kind === 'retryable' || error?.kind === 'auth') throw error;
      study.status = 'error';
      study.reason = error?.message || String(error);
      log.error?.(`[cpk] event ${event.eventId}: ${study.reason}`);
    }

    study.updatedAt = new Date().toISOString();
    await store.saveStudy(study);
    return study;
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────
  function registerRoutes (api, { requireQuality, actorOf, canEdit }) {
    api.get('/studies', async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      let studies = (await store.listStudies(TOOL.id, limit)).map((s) => ({ ...s, priority: priorityOf(s) }));
      if (req.query.sort === 'priority') studies = studies.sort(byPriority);
      res.json({ studies });
    });

    // The header of the studies screen: counts by urgency and what to open first.
    api.get('/summary', async (req, res) => {
      res.json(summarize(await store.listStudies(TOOL.id, 200)));
    });

    settings.registerRoutes(api, { requireQuality, actorOf, canEdit });

    api.get('/studies/:id', async (req, res) => {
      const study = await store.getStudy(req.params.id);
      if (!study || study.tool !== TOOL.id) return res.status(404).json({ error: 'not_found' });
      return res.json({ study: { ...study, priority: priorityOf(study) } });
    });

    api.get('/specs', async (req, res) => {
      res.json({ specs: await store.listSpecs() });
    });

    // A study entered by a person. The actor comes from the verified session,
    // never from the body: nothing in req.body is read for identity.
    api.post('/studies', requireQuality, async (req, res) => {
      const body = req.body || {};
      const partId = body.partId ? String(body.partId).trim() : null;
      const characteristicId = body.characteristicId ? String(body.characteristicId).trim() : null;
      const measurements = numbers(body.measurements);
      if (!measurements) {
        return res.status(422).json({ error: 'invalid_input', errors: ['`measurements` debe ser un arreglo de números.'] });
      }
      const spec = await resolveSpec({ partId, characteristicId, usl: num(body.usl), lsl: num(body.lsl) });
      if (!spec) {
        return res.status(422).json({
          error: 'invalid_input',
          errors: ['Indique USL y LSL, o una característica con especificación publicada en la plataforma.']
        });
      }
      const { analysis, criteria } = await analyzeUnderCriteria({
        measurements,
        spec,
        characteristicId,
        explicit: num(body.minimumCpk),
        target: num(body.target)
      });
      if (!analysis.ok) return res.status(422).json({ error: 'invalid_input', errors: analysis.errors });

      const study = newStudy({
        source: 'manual',
        inputEventId: null,
        partId,
        characteristicId,
        asset: null,
        spec: spec.source === 'event' ? { ...spec, source: 'manual' } : spec,
        input: { partId, characteristicId, usl: spec.usl, lsl: spec.lsl, minimumCpk: num(body.minimumCpk) ?? null, target: num(body.target) ?? null, measurements },
        result: analysis.result,
        criteria,
        warnings: analysis.warnings,
        verdict: analysis.result.status,
        actor: actorOf(req.caller),
        publish: { state: analysis.result.belowTarget ? 'awaiting_decision' : 'not_required' },
        notes: body.notes ? String(body.notes).slice(0, 2000) : null
      });
      await store.saveStudy(study);
      return res.status(201).json({ study: { ...study, priority: priorityOf(study) } });
    });

    // Escalate a below-target study to specification review. Explicit and
    // signed: the person in session is written into the event's metadata.
    api.post('/studies/:id/publish', requireQuality, async (req, res) => {
      const study = await store.getStudy(req.params.id);
      if (!study || study.tool !== TOOL.id) return res.status(404).json({ error: 'not_found' });
      if (study.status !== 'completed' || !study.result?.belowTarget) {
        return res.status(409).json({ error: 'not_publishable', detail: 'Solo se escala un estudio completado con Cpk bajo el objetivo.' });
      }
      if (['published', 'duplicate'].includes(study.publish?.state)) {
        return res.status(409).json({ error: 'already_published', study });
      }

      const actor = actorOf(req.caller);
      const envelope = study.source === 'platform' && study.inputEventId && study.publish?.event
        ? study.publish.event
        : buildRoot({
          seed: study.id,
          toolId: TOOL.id,
          toolVersion: TOOL.version,
          asset: { asset_id: study.partId || study.characteristicId || study.id, asset_type: 'part' },
          type: 'CAPABILITY_BELOW_TARGET',
          category: 'quality',
          severity: severityFor(study.result.status),
          data: belowTargetData(study),
          metadata: { operator_id: actor?.ref ?? null, source: 'manual_study' }
        });

      try {
        study.publish = await publisher.publish(envelope);
      } catch (error) {
        return res.status(503).json({ error: 'core_unavailable', detail: error.message });
      }
      study.publishedBy = actor;
      study.updatedAt = new Date().toISOString();
      await store.saveStudy(study);
      return res.json({ study: { ...study, priority: priorityOf(study) } });
    });

    // Machine plane: compute an IES event synchronously. No side effects —
    // nothing stored, nothing published. For integration checks by other
    // services (they authenticate with TOOL_API_KEY).
    api.post('/invoke', async (req, res) => {
      const event = fromCore(req.body || {});
      if (event.type !== 'MEASUREMENTS_CAPTURED') {
        return res.status(422).json({ error: 'unsupported_event', expected: TOOL.consumes });
      }
      const data = event.data || {};
      const measurements = numbers(data.measurements);
      const spec = await resolveSpec({
        partId: data.partId ? String(data.partId) : null,
        characteristicId: data.characteristicId ? String(data.characteristicId) : null,
        usl: num(data.usl),
        lsl: num(data.lsl)
      });
      if (!measurements || !spec) {
        return res.status(422).json({ error: 'invalid_input', detail: !measurements ? 'measurements' : 'no spec for characteristic' });
      }
      const { analysis, criteria } = await analyzeUnderCriteria({
        measurements,
        spec,
        characteristicId: data.characteristicId ? String(data.characteristicId) : null,
        explicit: num(data.minimumCpk)
      });
      if (!analysis.ok) return res.status(422).json({ error: 'invalid_input', errors: analysis.errors });
      return res.json({ result: analysis.result, criteria, warnings: analysis.warnings, wouldPublish: analysis.result.belowTarget ? 'CAPABILITY_BELOW_TARGET' : null });
    });
  }

  return { processEvent, beforeTick: syncSpecs, syncSpecs, registerRoutes, settings };
}

export default { TOOL, createCapabilityTool, specsFromEvent, belowTargetData, severityFor };
