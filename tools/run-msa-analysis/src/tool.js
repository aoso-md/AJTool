// src/tool.js — run_msa_analysis on the ORCA platform
// -----------------------------------------------------------------------------
// Where this tool sits in the ISO chain (core communication-rules.json):
//
//   manage_device_registry ──NEW_DEVICE_REGISTERED──▶ run_msa_analysis       (rule-pkg-004,
//                                                       "operation == 'register'")
//   run_msa_analysis ──MSA_VALIDATED──▶ calculate_control_charts              (rule-pkg-005,
//                                                       "verdict == 'acceptable'")
//
// NEW_DEVICE_REGISTERED as the platform publishes it says WHICH gauge was
// registered (`gaugeId`, `devices[]`) — it does not, and cannot, carry a Gage
// R&R study. That study is physical work: appraisers measure parts, repeatedly.
// So the flow is:
//
//   1. The poller receives NEW_DEVICE_REGISTERED → this tool opens a PENDING
//      study for that gauge, keeping the event it came from.
//   2. A quality engineer captures the readings in the UI.
//   3. On save, the study is computed and MSA_VALIDATED is published as a CHILD
//      of the registration event (causation_id = that event). The ISO evidence
//      log then shows the full chain: gauge registered → MSA performed → result.
//
// MSA_VALIDATED is published for EVERY completed study, whatever the verdict:
// the verdict travels inside it (`acceptable | marginal | unacceptable`, core
// contract) and the platform's routing rule decides what happens next. That
// replaces the old non-official MSA_NOT_ACCEPTABLE event of this repo.
//
// If a registration event ever does carry observations, it's computed and
// published straight away, no human step.
// -----------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { analyzeGageRR, verdictFor } from './domain/gage-rr.js';
import { SETTINGS_KEY, DEFAULTS, BOUNDS, validateCriteria, describeChanges, deviations, impactOn } from './domain/criteria.js';
import { byPriority, priorityOf, summarize } from './domain/priority.js';
import { createSettingsService } from './platform/settings.js';
import { buildChild, buildRoot, fromCore } from './platform/ies.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const TOOL = Object.freeze({
  id: 'run_msa_analysis',
  name: 'Análisis del sistema de medición (MSA)',
  clause: '7.1.5.2 — trazabilidad de las mediciones',
  consumes: ['NEW_DEVICE_REGISTERED'],
  produces: ['MSA_VALIDATED'],
  // Matches `localPort` in the core's deployments.json entry for this tool.
  localPort: 8109,
  version: pkg.version
});

const SUPPORTED_STUDY_TYPES = new Set(['gage_rr']);

function num (value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Accept the field names this repo used before and the obvious synonyms. */
export function normalizeObservations (raw) {
  if (!Array.isArray(raw)) return null;
  return raw.map((o) => ({
    partId: o?.partId ?? o?.part ?? o?.part_id,
    operatorId: o?.operatorId ?? o?.operator ?? o?.appraiser ?? o?.operator_id,
    trial: o?.trial ?? o?.replicate ?? o?.trialNumber,
    value: num(o?.value ?? o?.measurement ?? o?.reading)
  }));
}

export function gaugeIdOf (event) {
  const d = event.data || {};
  return String(d.gaugeId ?? d.devices?.[0]?.id ?? d.deviceId ?? event.asset?.asset_id ?? '').trim() || null;
}

export function severityFor (verdict) {
  if (verdict === 'unacceptable') return 'high';
  if (verdict === 'marginal') return 'medium';
  return 'low';
}

/** `data` of MSA_VALIDATED: the contract fields first, then traceability. */
export function validatedData (study) {
  const r = study.result;
  return {
    // contract (core tools.json, outputSchema of run_msa_analysis)
    gaugeId: study.gaugeId,
    studyType: study.studyType || 'gage_rr',
    gageRRPercent: r.gageRRPercent,
    repeatability: r.repeatability,
    reproducibility: r.reproducibility,
    ndc: r.ndc,
    verdict: r.verdict,
    // traceability
    method: r.method,
    parts: r.parts,
    appraisers: r.appraisers,
    trials: r.trials,
    partVariation: r.partVariation,
    totalVariation: r.totalVariation,
    contributionPercent: r.contributionPercent,
    // the thresholds this verdict was judged with, so a downstream reader
    // never has to guess whether 12% was "acceptable" under that plant's rule
    acceptanceCriteria: r.criteria ?? null,
    criteriaVersion: study.criteria?.version ?? null,
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
    studyType: 'gage_rr',
    publish: { state: 'not_required' },
    createdAt: now,
    updatedAt: now,
    ...fields
  };
}

export function createMsaTool ({ store, publisher, log = console }) {
  // ── Acceptance criteria (editable, with confirmation) ──────────────────────
  const settings = createSettingsService({
    store,
    key: SETTINGS_KEY,
    defaults: DEFAULTS,
    bounds: BOUNDS,
    validate: validateCriteria,
    describeChanges,
    deviations,
    impact: (studies, before, after) => impactOn(studies, before, after, verdictFor),
    recentStudies: () => store.listStudies(TOOL.id, 200)
  });

  async function publishInto (study, envelope) {
    try {
      study.publish = await publisher.publish(envelope);
      return true;
    } catch (error) {
      // Saved as "retrying": the next poller tick picks it up (retryPublishes).
      study.publish = { state: 'retrying', eventId: envelope.event_id, event: envelope, error: error.message, at: new Date().toISOString() };
      return false;
    }
  }

  function childEnvelope (study) {
    return buildChild({
      parent: study.parent,
      toolId: TOOL.id,
      toolVersion: TOOL.version,
      type: 'MSA_VALIDATED',
      category: 'quality',
      severity: severityFor(study.result.verdict),
      data: validatedData(study),
      metadata: study.actor?.kind === 'user' || study.actor?.kind === 'open'
        ? { operator_id: study.actor.ref }
        : undefined
    });
  }

  // Judged under the criteria in force NOW; the study keeps that snapshot.
  async function computeInto (study, observations) {
    const now = await settings.current();
    const analysis = analyzeGageRR(observations, now.value);
    if (!analysis.ok) return analysis;
    study.criteria = { version: now.version, ...now.value };
    study.status = 'completed';
    study.reason = null;
    study.result = analysis.result;
    study.verdict = analysis.result.verdict;
    study.warnings = analysis.warnings;
    study.input = { ...(study.input || {}), observations };
    return analysis;
  }

  // ── Platform path ──────────────────────────────────────────────────────────
  async function processEvent (event) {
    const data = event.data || {};
    if (data.operation && data.operation !== 'register') return null; // rule-pkg-004 only fires on 'register'

    const existing = await store.findStudyByInputEvent(TOOL.id, event.eventId);
    if (existing) return existing;

    const gaugeId = gaugeIdOf(event);
    const study = newStudy({
      source: 'platform',
      status: 'pending',
      reason: 'Equipo registrado: falta capturar el estudio Gage R&R.',
      inputEventId: event.eventId,
      inputSeq: event.seq,
      correlationId: event.correlationId,
      gaugeId,
      asset: event.asset,
      // Everything needed to publish the result later as a CHILD of this event.
      parent: event,
      input: { device: data.devices?.[0] ?? null },
      actor: { kind: 'service', ref: event.module?.id || 'platform', name: 'plataforma', role: null },
      publish: { state: 'awaiting_capture' }
    });

    const embedded = normalizeObservations(data.observations ?? (Array.isArray(data.measurements) && typeof data.measurements[0] === 'object' ? data.measurements : null));
    if (embedded && embedded.length) {
      const analysis = await computeInto(study, embedded);
      if (analysis.ok) {
        const envelope = childEnvelope(study);
        const ok = await publishInto(study, envelope);
        study.updatedAt = new Date().toISOString();
        await store.saveStudy(study);
        if (!ok) {
          const error = new Error(study.publish.error);
          error.kind = 'retryable';
          throw error;
        }
        return study;
      }
      study.reason = `El evento traía observaciones inválidas; capture el estudio manualmente. ${analysis.errors.join(' ')}`;
    }

    await store.saveStudy(study);
    return study;
  }

  // Publishes that couldn't reach the core are retried on every tick.
  async function retryPublishes () {
    const studies = await store.listStudies(TOOL.id, 200);
    for (const study of studies.filter((s) => s.publish?.state === 'retrying' && s.publish.event)) {
      if (await publishInto(study, study.publish.event)) {
        study.updatedAt = new Date().toISOString();
        await store.saveStudy(study);
      } else {
        const error = new Error(study.publish.error);
        error.kind = 'retryable';
        throw error;
      }
    }
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────
  function registerRoutes (api, { requireQuality, actorOf, canEdit }) {
    api.get('/studies', async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      let studies = await store.listStudies(TOOL.id, limit);
      if (req.query.status) studies = studies.filter((s) => s.status === req.query.status);
      studies = studies.map((s) => ({ ...s, priority: priorityOf(s) }));
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

    // Capture the readings for a gauge the platform registered. Computes and
    // publishes MSA_VALIDATED as a child of the registration event, signed by
    // the person in session.
    api.post('/studies/:id/capture', requireQuality, async (req, res) => {
      const study = await store.getStudy(req.params.id);
      if (!study || study.tool !== TOOL.id) return res.status(404).json({ error: 'not_found' });
      if (study.status !== 'pending') return res.status(409).json({ error: 'not_pending', study });

      const studyType = String(req.body?.studyType || 'gage_rr');
      if (!SUPPORTED_STUDY_TYPES.has(studyType)) {
        return res.status(422).json({ error: 'unsupported_study_type', errors: [`Tipo de estudio "${studyType}" no soportado todavía. Disponible: gage_rr.`] });
      }
      const observations = normalizeObservations(req.body?.observations);
      const analysis = observations ? await computeInto(study, observations) : { ok: false, errors: ['`observations` debe ser un arreglo.'] };
      if (!analysis.ok) return res.status(422).json({ error: 'invalid_input', errors: analysis.errors });

      study.studyType = studyType;
      study.actor = actorOf(req.caller);
      study.notes = req.body?.notes ? String(req.body.notes).slice(0, 2000) : null;
      const published = await publishInto(study, childEnvelope(study));
      study.updatedAt = new Date().toISOString();
      await store.saveStudy(study);
      return res.status(published ? 200 : 202).json({ study: { ...study, priority: priorityOf(study) } });
    });

    // A study with no registration behind it (e.g. a periodic re-study).
    api.post('/studies', requireQuality, async (req, res) => {
      const body = req.body || {};
      const gaugeId = body.gaugeId ? String(body.gaugeId).trim() : '';
      if (!gaugeId) return res.status(422).json({ error: 'invalid_input', errors: ['Indique el equipo de medición (gaugeId).'] });
      const studyType = String(body.studyType || 'gage_rr');
      if (!SUPPORTED_STUDY_TYPES.has(studyType)) {
        return res.status(422).json({ error: 'unsupported_study_type', errors: [`Tipo de estudio "${studyType}" no soportado todavía. Disponible: gage_rr.`] });
      }
      const observations = normalizeObservations(body.observations);
      const study = newStudy({
        source: 'manual',
        inputEventId: null,
        gaugeId,
        studyType,
        asset: { asset_id: gaugeId, asset_type: 'gauge' },
        actor: actorOf(req.caller),
        notes: body.notes ? String(body.notes).slice(0, 2000) : null,
        publish: { state: 'awaiting_decision' }
      });
      const analysis = observations ? await computeInto(study, observations) : { ok: false, errors: ['`observations` debe ser un arreglo.'] };
      if (!analysis.ok) return res.status(422).json({ error: 'invalid_input', errors: analysis.errors });
      await store.saveStudy(study);
      return res.status(201).json({ study: { ...study, priority: priorityOf(study) } });
    });

    // Publish a completed study: a manual one (as a root event), or retry one
    // whose publish failed. Signed by the person in session.
    api.post('/studies/:id/publish', requireQuality, async (req, res) => {
      const study = await store.getStudy(req.params.id);
      if (!study || study.tool !== TOOL.id) return res.status(404).json({ error: 'not_found' });
      if (study.status !== 'completed') return res.status(409).json({ error: 'not_publishable', detail: 'Solo se publica un estudio completado.' });
      if (['published', 'duplicate'].includes(study.publish?.state)) return res.status(409).json({ error: 'already_published', study });

      const actor = actorOf(req.caller);
      const envelope = study.publish?.event || (study.parent
        ? childEnvelope(study)
        : buildRoot({
          seed: study.id,
          toolId: TOOL.id,
          toolVersion: TOOL.version,
          asset: study.asset || { asset_id: study.gaugeId, asset_type: 'gauge' },
          type: 'MSA_VALIDATED',
          category: 'quality',
          severity: severityFor(study.result.verdict),
          data: validatedData(study),
          metadata: { operator_id: actor?.ref ?? null, source: 'manual_study' }
        }));

      const published = await publishInto(study, envelope);
      study.publishedBy = actor;
      study.updatedAt = new Date().toISOString();
      await store.saveStudy(study);
      if (!published) return res.status(503).json({ error: 'core_unavailable', detail: study.publish.error, study });
      return res.json({ study });
    });

    // Machine plane: compute synchronously, no side effects.
    api.post('/invoke', async (req, res) => {
      const event = fromCore(req.body || {});
      const observations = normalizeObservations(event.data?.observations ?? event.data?.measurements);
      if (!observations) return res.status(422).json({ error: 'invalid_input', detail: 'observations' });
      const now = await settings.current();
      const analysis = analyzeGageRR(observations, now.value);
      if (!analysis.ok) return res.status(422).json({ error: 'invalid_input', errors: analysis.errors });
      return res.json({ result: analysis.result, criteria: { version: now.version, ...now.value }, warnings: analysis.warnings, wouldPublish: 'MSA_VALIDATED' });
    });
  }

  return { processEvent, beforeTick: retryPublishes, retryPublishes, registerRoutes, settings };
}

export default { TOOL, createMsaTool, normalizeObservations, gaugeIdOf, validatedData, severityFor };
