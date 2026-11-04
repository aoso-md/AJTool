import { createHash } from 'node:crypto';

export function sequenceText (value) {
  if ((typeof value === 'number' && !Number.isSafeInteger(value))
    || !['number', 'string', 'bigint'].includes(typeof value) || !/^\d+$/.test(String(value))) {
    throw Object.assign(new Error('Invalid sequence: a nonnegative exact integer is required'), { code: 'invalid_sequence', kind: 'protocol' });
  }
  const n = BigInt(value);
  if (n > 9223372036854775807n) throw Object.assign(new Error('Invalid sequence: exceeds BIGINT'), { code: 'invalid_sequence', kind: 'protocol' });
  return n.toString();
}
export function sequenceValue (value) {
  const text = sequenceText(value);
  return BigInt(text) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(text) : text;
}
export function compareSequence (a, b) { return BigInt(sequenceText(a)) < BigInt(sequenceText(b)) ? -1 : BigInt(sequenceText(a)) > BigInt(sequenceText(b)) ? 1 : 0; }
export function canonicalText (value) {
  function normalize (v) {
    if (typeof v === 'number' && !Number.isFinite(v)) throw Object.assign(new Error('Nonfinite event value'), { kind: 'protocol' });
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter((key) => v[key] !== undefined).map((key) => [key, normalize(v[key])]));
    return v;
  }
  return JSON.stringify(normalize(value));
}
export function digest (value) { return createHash('sha256').update(canonicalText(value)).digest('hex'); }
export function inboxEvent (event) {
  if (typeof event?.eventId !== 'string' || !event.eventId.trim() || event.seq == null) throw Object.assign(new Error('Event identity and sequence required'), { kind: 'protocol' });
  const { seq, ...content } = event;
  const canonicalInput = { canonicalVersion: 1, ...content };
  return { eventId: event.eventId, sourceSeq: sequenceText(seq), rawInput: event.rawReceipt || event, canonicalInput, inputHash: digest(canonicalInput) };
}
export async function retryTransaction (operation, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!['40001', '40P01'].includes(error.code) || attempt >= attempts) throw error;
      // A fresh client/transaction and fresh reads on every bounded retry.
    }
  }
}
export function transactionStore (store, tx) {
  return {
    ...store, transactional: false, transactionLocal: true,
    saveStudy: tx.saveStudy, getStudy: tx.getStudyForUpdate || tx.getStudy,
    findStudyByInputEvent: async () => null,
    findSpec: tx.findSpec, upsertSpec: tx.upsertSpec, getSettings: tx.getSettings
  };
}
export function outboxPublisher (tx, mode, destinationId = 'core_api') {
  return { mode, async publish (envelope) {
    const envelopeText = JSON.stringify(envelope);
    await tx.stageOutbox({ eventId: envelope.event_id, publicationKey: envelope.event_id, studyId: envelope.data?.studyId, destinationId, envelopeText, mode });
    return { state: mode === 'shadow' ? 'shadow' : 'pending', eventId: envelope.event_id, event: envelope, at: new Date().toISOString() };
  } };
}

export function manualRoute ({ store, tool, publisher, factory, method, actorOf, core, log }) {
  return async (req, res) => {
    const actor = actorOf(req.caller);
    const args = { studyId: req.params.id, body: req.body || {}, actor };
    const identity={ref:actor?.ref,kind:actor?.kind};
    const commandHash = digest({method,studyId:args.studyId,body:args.body,identity});
    const suppliedKey = req.get('idempotency-key');
    if (suppliedKey && (suppliedKey.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(suppliedKey))) return res.status(422).json({ error: 'invalid_idempotency_key' });
    if (!store.transactional) {
      const outcome = await factory({ store, publisher, core, log })[method](args);
      return res.status(outcome.status).json(outcome.body);
    }
    // Scope the client's key to the verified actor and endpoint. No user-supplied identity.
    const commandId = digest({ method, identity, key: suppliedKey || commandHash });
    const result = await store.recordManualCommandTransaction({
      tool, commandId, commandType: method, commandHash, studyId: args.studyId,
      handler: async (tx) => {
        const local = factory({ store: transactionStore(store, tx), publisher: outboxPublisher(tx, publisher.mode), core, log });
        return local[method](args);
      }
    });
    if (!result.ok) return res.status(409).json({ error: 'idempotency_conflict' });
    return res.status(result.result.status).json(result.result.body);
  };
}
