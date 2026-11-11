import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, prepare, quiet } from './helpers/isolated-postgres.mjs';
import { startFakeCore, producedEvent, validateCoreEvent } from '../../tools/calculate-cpk-ppk/test/helpers/fake-core.js';

const readings = [
  ...Array.from({ length: 5 }, () => [25, 25.01, 24.99, 25.02, 24.98]).flat(),
  25.03, 25.03, 25.04, 25.03, 25.04, 25.03, 25.04, 25.04, 25.09
];
const observations = (values) => values.map((value, i) => ({
  partId: i < 4 ? 'P1' : 'P2', operatorId: i % 4 < 2 ? 'OP-A' : 'OP-B', trial: i % 2 + 1, value
}));
const acceptable = observations([25.001, 25.002, 25.001, 25.003, 25.200, 25.201, 25.202, 25.203]);
const unacceptable = observations([24.80, 25.30, 24.70, 25.40, 25.10, 24.90, 25.30, 24.80]);

async function setup(t, service) {
  const { TOOL, createCapabilityTool, createMsaTool } = await import(`../../tools/${service}/src/tool.js`);
  const { createCoreClient } = await import(`../../tools/${service}/src/platform/core-client.js`);
  const { createPoller, createPublisher } = await import(`../../tools/${service}/src/platform/poller.js`);
  const { createApp } = await import(`../../tools/${service}/src/platform/app.js`);
  const fake = await startFakeCore({ consumes: { [TOOL.id]: TOOL.consumes } });
  const cleanup = [() => fake.close()];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const core = createCoreClient({ baseUrl: fake.url, apiKey: fake.key });
  const publisher = createPublisher({ core, mode: 'shadow', log: quiet });
  const lane = `subscription:${TOOL.id}`;

  async function connect(store) {
    const domain = (createCapabilityTool || createMsaTool)({ store, core, publisher, log: quiet });
    const poller = createPoller({
      toolId: TOOL.id, consumes: TOOL.consumes, core, store, processEvent: domain.processEvent,
      beforeTick: domain.beforeTick, log: quiet
    });
    const app = createApp({ tool: TOOL, config: {}, core, store, poller, publisher, registerRoutes: domain.registerRoutes, log: quiet });
    const server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    let open = true;
    const stopHttp = async () => {
      if (!open) return;
      open = false;
      await new Promise(resolve => server.close(resolve));
    };
    cleanup.push(stopHttp);
    return { store, poller, stopHttp, base };
  }

  async function database() {
    const f = await fixture(service, prepare());
    cleanup.push(() => f.close());
    await f.store.initializeReplay(TOOL.id);
    const app = await connect(f.store);
    return {
      ...app,
      async reopen() {
        await app.stopHttp();
        const reopened = await f.createStore({ databaseUrl: f.url, log: quiet });
        cleanup.push(() => reopened.close());
        return connect(reopened);
      }
    };
  }

  async function evidence(app, input, study) {
    const inbox = await app.store.getInboxRecord(TOOL.id, input.event_id);
    const outbox = await app.store.getOutboxRecord(TOOL.id, study.publish.eventId);
    assert.equal(inbox.studyId, study.id);
    assert.equal(inbox.outcome, 'processed');
    assert.equal(outbox.studyId, study.id);
    assert.equal(outbox.mode, 'shadow');
    assert.equal(outbox.state, 'shadow_recorded');
    assert.equal(outbox.attempts, 0);
    const envelope = JSON.parse(outbox.envelopeText);
    assert.equal(validateCoreEvent(envelope), true, JSON.stringify(validateCoreEvent.errors));
    assert.equal(envelope.correlation_id, input.correlation_id);
    assert.equal(envelope.causation_id, input.event_id);
    assert.equal(envelope.event.type, TOOL.produces[0]);
    return {
      studyId: study.id, eventId: input.event_id, outputEventId: envelope.event_id,
      correlationId: envelope.correlation_id, causationId: envelope.causation_id,
      inbox: inbox.outcome, outbox: outbox.state, cursor: String(await app.store.getCursor(lane))
    };
  }

  async function studyFor(app, input) {
    const inbox = await app.store.getInboxRecord(TOOL.id, input.event_id);
    return app.store.getStudy(inbox.studyId);
  }
  return { fake, lane, database, evidence, studyFor, id: TOOL.id };
}

async function capture(app, study, data, notes) {
  const response = await fetch(`${app.base}/api/studies/${study.id}/capture`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `capture-${study.id}` },
    body: JSON.stringify({ observations: data, notes })
  });
  assert.equal(response.status, 200);
  return app.store.getStudy(study.id);
}

test('v1.1 MSA: capture, shadow routing evidence, reopen and reconstruction', async t => {
  const s = await setup(t, 'run-msa-analysis');
  const db = await s.database();
  const event = (gaugeId, operation) => producedEvent({
    type: 'NEW_DEVICE_REGISTERED', moduleId: 'manage_device_registry',
    asset: { asset_id: gaugeId }, data: { gaugeId, ...(operation && { operation }) }
  });
  const good = event('ENS-CAL-001', 'register');
  const bad = event('ENS-CAL-002', 'register');
  const missing = event('ENS-CAL-003');
  for (const item of [good, bad, missing]) s.fake.seed(item);
  await db.poller.tick();
  assert.equal((await db.store.getInboxRecord(s.id, missing.event_id)).outcome, 'ignored');
  assert.equal((await db.store.listStudies(s.id, 20)).length, 2);
  const first = await s.studyFor(db, good);
  assert.equal(first.status, 'pending');
  const saved = await capture(db, first, acceptable, 'ENS-captura manual');
  const negative = await capture(db, await s.studyFor(db, bad), unacceptable, 'ENS-caso negativo');
  assert.equal(saved.verdict, 'acceptable');
  assert.ok(saved.result.gageRRPercent < 10 && saved.result.ndc >= 5);
  assert.equal(negative.verdict, 'unacceptable');
  const before = [await s.evidence(db, good, saved), await s.evidence(db, bad, negative)];

  const reopened = await db.reopen();
  s.fake.rows.push({ ...s.fake.rows[0], seq: 4 });
  await reopened.poller.tick();
  const response = await fetch(`${reopened.base}/api/studies/${saved.id}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).study.id, saved.id);
  assert.deepEqual(await reopened.store.getStudy(saved.id), saved);
  assert.deepEqual(await reopened.store.getStudy(negative.id), negative);
  assert.equal((await reopened.store.listStudies(s.id, 20)).length, 2);
  assert.equal(String(await reopened.store.getCursor(s.lane)), '4');

  const fresh = await s.database();
  await fresh.poller.tick();
  const replayed = await s.studyFor(fresh, good);
  assert.equal(replayed.status, 'pending');
  assert.equal(replayed.result, null);
  const recaptured = await capture(fresh, replayed, saved.input.observations, saved.notes);
  assert.deepEqual(recaptured.result, saved.result);
  const recovered = await s.evidence(fresh, good, recaptured);
  assert.equal(recovered.outputEventId, before[0].outputEventId);
  assert.equal(s.fake.posted.length, 0);
  console.log(JSON.stringify({
    ensayoV11: true, tool: s.id, before, reopenedCursor: '4', captures: [saved, negative].map(study => ({
      studyId: study.id, verdict: study.verdict, grr: study.result.gageRRPercent, ndc: study.result.ndc
    })), freshReplayPending: true, recaptured: recovered, corePosts: 0
  }));
});

test('v1.1 CPK: capability, spec revisions, outage, dedupe and new-event feedback', async t => {
  const s = await setup(t, 'calculate-cpk-ppk');
  const db = await s.database();
  const partId = 'ENS-PZA-001', characteristicId = 'CTQ-DIAM-001';
  const spec = (version, correlationId, parent) => ({
    ...producedEvent({ type: 'PRODUCT_SPEC_UPDATED', moduleId: 'manage_product_specs', correlationId,
      data: { partId, characteristics: [{ id: characteristicId, lsl: 24.95, usl: 25.05, version }] } }),
    causation_id: parent ?? null
  });
  const measurements = (characteristic, correlationId, parent) => ({
    ...producedEvent({ type: 'MEASUREMENTS_CAPTURED', moduleId: 'collect_quality_measurements', correlationId,
      data: { partId, characteristicId: characteristic, measurements: readings, defectsFound: 1 } }),
    causation_id: parent ?? null
  });
  const initial = spec('1');
  const input = measurements(characteristicId, initial.correlation_id, initial.event_id);
  const unknown = measurements('ENS-SIN-ESPECIFICACION', initial.correlation_id, initial.event_id);
  for (const item of [initial, input, unknown]) s.fake.seed(item);
  s.fake.failNextRequests(1);
  await assert.rejects(db.poller.tick(), error => error.kind === 'retryable');
  assert.equal(String(await db.store.getCursor(s.lane)), '0');
  await db.poller.tick();
  const saved = await s.studyFor(db, input);
  const reference = { cp: 0.8499, cpk: 0.6649, pp: 0.6933, ppk: 0.5424 };
  for (const [key, expected] of Object.entries(reference)) assert.equal(saved.result[key], expected);
  assert.equal(saved.result.minimumCpk, 1.33);
  assert.equal(saved.spec.version, '1');
  assert.equal(saved.spec.lsl, 24.95);
  assert.equal(saved.spec.usl, 25.05);
  assert.equal((await db.store.getInboxRecord(s.id, unknown.event_id)).outcome, 'rejected');
  const first = await s.evidence(db, input, saved);

  const revision = spec('2', input.correlation_id, first.outputEventId);
  s.fake.seed(revision);
  await db.poller.tick();
  assert.equal((await db.store.findSpec(partId, characteristicId)).version, '2');
  assert.equal((await db.store.listStudies(s.id, 20)).length, 2);
  s.fake.rows.push({ ...s.fake.rows[1], seq: 5 });
  await db.poller.tick();
  assert.equal((await db.store.listStudies(s.id, 20)).length, 2);

  const feedback = measurements(characteristicId, input.correlation_id, revision.event_id);
  s.fake.seed(feedback).seq = 6;
  await db.poller.tick();
  const next = await s.studyFor(db, feedback);
  assert.equal(next.spec.version, '2');
  const second = await s.evidence(db, feedback, next);
  assert.notEqual(second.outputEventId, first.outputEventId);
  assert.equal(second.correlationId, first.correlationId);

  const reopened = await db.reopen();
  assert.deepEqual(await reopened.store.getStudy(saved.id), saved);
  assert.equal(String(await reopened.store.getCursor(s.lane)), '6');
  assert.equal(s.fake.posted.length, 0);
  console.log(JSON.stringify({ ensayoV11: true, tool: s.id, first, second, reference,
    limits: { lsl: saved.spec.lsl, usl: saved.spec.usl, versions: ['1', '2'] },
    missingSpec: 'rejected', reopenedCursor: '6', corePosts: 0 }));
});
