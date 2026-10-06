// src/platform/settings.js
// -----------------------------------------------------------------------------
// Editable acceptance criteria, with a deliberate speed bump. Changing the line
// between "capable" and "not capable" changes what a plant ships, so it is a
// two-step action:
//
//   POST /api/settings/preview   validates, shows what changes, what it would
//                                have meant for studies on file, and which
//                                values depart from the usual reference.
//   PUT  /api/settings           applies it — and only with `confirm: true`, the
//                                version the person was looking at, and a reason.
//
// The server enforces the confirmation: a client that skips the preview and
// sends a bare PUT gets 428, so "are you sure?" is not just a UI nicety.
// Every applied change is stored with who, when, why and the before/after.
// -----------------------------------------------------------------------------

const MIN_REASON = 8;

/**
 * @param {object} o
 * @param {object} o.store
 * @param {string} o.key           settings key in the store
 * @param {object} o.defaults
 * @param {object} o.bounds        sent to the UI so its inputs match the server's limits
 * @param {(c:any)=>{ok:boolean,value?:any,errors?:string[]}} o.validate
 * @param {(a:any,b:any)=>object[]} o.describeChanges
 * @param {(v:any)=>string[]} o.deviations
 * @param {(studies:any[],before:any,after:any)=>object} o.impact
 * @param {()=>Promise<any[]>} o.recentStudies
 */
export function createSettingsService ({ store, key, defaults, bounds, validate, describeChanges, deviations, impact, recentStudies }) {
  const base = () => structuredClone(defaults);

  /** Effective criteria + provenance. Stored values are merged over defaults so a newer field never reads undefined. */
  async function current () {
    const record = await store.getSettings(key);
    const merged = validate({ ...base(), ...(record?.doc || {}) });
    return {
      value: merged.ok ? merged.value : base(),
      version: record?.version ?? 0,
      updatedAt: record?.updatedAt ?? null,
      updatedBy: record?.updatedBy ?? null,
      reason: record?.reason ?? null,
      isDefault: !record
    };
  }

  async function preview (candidate) {
    const checked = validate(candidate);
    const now = await current();
    if (!checked.ok) return { ok: false, errors: checked.errors, version: now.version };
    const changes = describeChanges(now.value, checked.value);
    return {
      ok: true,
      settings: checked.value,
      version: now.version,
      changes,
      noChange: changes.length === 0,
      deviations: deviations(checked.value),
      impact: changes.length ? impact(await recentStudies(), now.value, checked.value) : null,
      appliesTo: 'new_studies'
    };
  }

  async function apply ({ candidate, expectedVersion, confirm, reason, actor }) {
    if (confirm !== true) {
      return { status: 428, body: { error: 'confirmation_required', detail: 'Cambiar los criterios de aceptación requiere confirmación explícita (confirm: true) después de revisar la vista previa.' } };
    }
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (why.length < MIN_REASON) {
      return { status: 422, body: { error: 'reason_required', errors: [`Indique el motivo del cambio (mínimo ${MIN_REASON} caracteres): queda en el historial.`] } };
    }
    const checked = validate(candidate);
    if (!checked.ok) return { status: 422, body: { error: 'invalid_input', errors: checked.errors } };

    const now = await current();
    const changes = describeChanges(now.value, checked.value);
    if (!changes.length) return { status: 200, body: { unchanged: true, settings: now.value, version: now.version } };

    const saved = await store.saveSettings({
      key,
      doc: checked.value,
      expectedVersion: Number(expectedVersion ?? -1),
      actor,
      reason: why.slice(0, 500),
      // the EFFECTIVE previous values (defaults included), so the history reads
      // "1.33 -> 1.5" even for the very first change
      before: now.value
    });
    if (!saved.ok) {
      return { status: 409, body: { error: 'version_conflict', detail: 'Otra persona cambió los criterios mientras usted los revisaba. Recargue y revise de nuevo.', current: await current() } };
    }
    return { status: 200, body: { applied: true, changes, settings: checked.value, version: saved.record.version, durable: saved.durable } };
  }

  function registerRoutes (api, { requireQuality, actorOf, canEdit = () => true }) {
    api.get('/settings', async (req, res) => {
      const now = await current();
      res.json({
        settings: now.value,
        defaults: base(),
        bounds,
        version: now.version,
        updatedAt: now.updatedAt,
        updatedBy: now.updatedBy,
        reason: now.reason,
        isDefault: now.isDefault,
        canEdit: canEdit(req),
        appliesTo: 'new_studies',
        history: await store.listSettingsHistory(key, 10),
        persistence: store.tier()
      });
    });

    api.post('/settings/preview', requireQuality, async (req, res) => {
      const result = await preview(req.body?.settings);
      return res.status(result.ok ? 200 : 422).json(result.ok ? result : { error: 'invalid_input', errors: result.errors, version: result.version });
    });

    api.put('/settings', requireQuality, async (req, res) => {
      const { status, body } = await apply({
        candidate: req.body?.settings,
        expectedVersion: req.body?.expectedVersion,
        confirm: req.body?.confirm,
        reason: req.body?.reason,
        actor: actorOf(req.caller)
      });
      return res.status(status).json(body);
    });
  }

  return { current, preview, apply, registerRoutes };
}

export default { createSettingsService };
