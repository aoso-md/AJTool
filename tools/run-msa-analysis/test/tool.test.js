// test/tool.test.js — run_msa_analysis end to end against a fake ORCA core:
// gauge registered (rule-pkg-004) -> pending study -> a person captures the
// readings -> MSA_VALIDATED published as a child of the registration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/platform/store.js';
import { createCoreClient } from '../src/platform/core-client.js';
import { createPoller, createPublisher } from '../src/platform/poller.js';
import { createApp } from '../src/platform/app.js';
import { TOOL, createMsaTool, gaugeIdOf } from '../src/tool.js';
import { fromCore } from '../src/platform/ies.js';
import { startFakeCore, producedEvent } from './helpers/fake-core.js';

const quiet = { info () {}, warn () {}, error () {} };

// Shape copied from the core's reference handler src/tools/manage_device_registry.js
const registered = (gaugeId, extra = {}) => producedEvent({
  type: 'NEW_DEVICE_REGISTERED',
  moduleId: 'manage_device_registry',
  asset: { asset_id: gaugeId, asset_type: 'gauge', plant_id: 'plant_01' },
  data: {
    operation: 'register',
    gaugeId,
    devices: [{ id: gaugeId, type: 'micrometer', nextCalibration: '2026-12-01' }],
    totalDevices: 24,
    operationResult: 'registered',
    ...extra
  }
});

const TIGHT = [
  ['P1', 'A', 1, 10.01], ['P1', 'A', 2, 10.011], ['P1', 'B', 1, 10.012], ['P1', 'B', 2, 10.013],
  ['P2', 'A', 1, 10.2], ['P2', 'A', 2, 10.201], ['P2', 'B', 1, 10.202], ['P2', 'B', 2, 10.203]
].map(([partId, operatorId, trial, value]) => ({ partId, operatorId, trial, value }));

const NOISY = [
  ['P1', 'A', 1, 5.01], ['P1', 'A', 2, 5.12], ['P1', 'B', 1, 4.95], ['P1', 'B', 2, 5.09],
  ['P2', 'A', 1, 5.05], ['P2', 'A', 2, 4.93], ['P2', 'B', 1, 5.14], ['P2', 'B', 2, 4.91]
].map(([partId, operatorId, trial, value]) => ({ partId, operatorId, trial, value }));

async function setup () {
  const core = await startFakeCore({ consumes: { [TOOL.id]: TOOL.consumes } });
  const store = await createStore({ log: quiet });
  const client = createCoreClient({ baseUrl: core.url, apiKey: core.key });
  const publisher = createPublisher({ core: client, mode: 'live', log: quiet });
  const domain = createMsaTool({ store, publisher, log: quiet });
  const poller = createPoller({ toolId: TOOL.id, consumes: TOOL.consumes, core: client, store, processEvent: domain.processEvent, beforeTick: domain.beforeTick, log: quiet });
  const app = createApp({ tool: TOOL, config: {}, core: client, store, poller, publisher, registerRoutes: domain.registerRoutes, log: quiet });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const close = async () => { await new Promise((r) => server.close(r)); await core.close(); };
  return { core, store, poller, post, base, close };
}

test('gaugeIdOf follows the core reference shape and falls back sensibly', () => {
  assert.equal(gaugeIdOf(fromCore(registered('GAUGE-07'))), 'GAUGE-07');
  assert.equal(gaugeIdOf(fromCore(producedEvent({ type: 'NEW_DEVICE_REGISTERED', data: { devices: [{ id: 'DEV-2' }] } }))), 'DEV-2');
  assert.equal(gaugeIdOf(fromCore(producedEvent({ type: 'NEW_DEVICE_REGISTERED', data: {}, asset: { asset_id: 'AS-1' } }))), 'AS-1');
});

test('registration -> pending study -> capture -> MSA_VALIDATED chained to the registration', async () => {
  const { core, store, poller, post, close } = await setup();
  try {
    core.seed(registered('GAUGE-OLD')); // backlog
    await poller.tick(); // cold start at the tip

    const reg = registered('GAUGE-07');
    core.seed(reg);
    await poller.tick();

    assert.equal(core.published('MSA_VALIDATED').length, 0, 'nothing to publish until someone performs the study');
    const pending = (await store.listStudies(TOOL.id, 10)).filter((s) => s.status === 'pending');
    assert.equal(pending.length, 1, 'the backlog registration was not turned into a study');
    assert.equal(pending[0].gaugeId, 'GAUGE-07');

    const captured = await post(`/api/studies/${pending[0].id}/capture`, { studyType: 'gage_rr', observations: TIGHT });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.study.verdict, 'acceptable');
    assert.equal(captured.body.study.actor.ref, 'local-dev', 'actor comes from the session, not the body');

    assert.deepEqual(core.rejected, []);
    const [e] = core.published('MSA_VALIDATED');
    assert.equal(e.module_id, 'run_msa_analysis');
    assert.equal(e.causation_id, reg.event_id, 'causation = the gauge registration');
    assert.equal(e.correlation_id, reg.correlation_id);
    assert.equal(e.asset_id, 'GAUGE-07');
    assert.equal(e.asset_type, 'gauge');
    assert.equal(e.severity, 'low');
    assert.equal(e.data.gaugeId, 'GAUGE-07');
    assert.equal(e.data.verdict, 'acceptable', 'the core rule to control charts fires on this exact value');
    for (const field of ['gageRRPercent', 'repeatability', 'reproducibility', 'ndc']) {
      assert.equal(typeof e.data[field], 'number', `contract field ${field}`);
    }
    assert.equal(e.metadata.operator_id, 'local-dev');

    const again = await post(`/api/studies/${pending[0].id}/capture`, { observations: TIGHT });
    assert.equal(again.status, 409, 'a study is captured once');
  } finally {
    await close();
  }
});

test('an unacceptable gauge is published too, with the verdict inside (no separate event)', async () => {
  const { core, store, poller, post, close } = await setup();
  try {
    await poller.tick();
    core.seed(registered('GAUGE-BAD'));
    await poller.tick();
    const [pending] = await store.listStudies(TOOL.id, 1);
    const res = await post(`/api/studies/${pending.id}/capture`, { observations: NOISY });
    assert.equal(res.status, 200);
    const [e] = core.published('MSA_VALIDATED');
    assert.equal(e.data.verdict, 'unacceptable');
    assert.equal(e.severity, 'high');
  } finally {
    await close();
  }
});

test('invalid capture is a 422 with reasons, and the study stays pending', async () => {
  const { core, store, poller, post, close } = await setup();
  try {
    await poller.tick();
    core.seed(registered('GAUGE-08'));
    await poller.tick();
    const [pending] = await store.listStudies(TOOL.id, 1);
    const res = await post(`/api/studies/${pending.id}/capture`, { observations: TIGHT.slice(0, 5) });
    assert.equal(res.status, 422);
    assert.ok(res.body.errors.length > 0);
    assert.equal((await store.getStudy(pending.id)).status, 'pending');
    assert.equal(core.published('MSA_VALIDATED').length, 0);
  } finally {
    await close();
  }
});

test('non-register operations are ignored (rule-pkg-004 only fires on register)', async () => {
  const { core, store, poller, close } = await setup();
  try {
    await poller.tick();
    core.seed(registered('GAUGE-09', { operation: 'update' }));
    await poller.tick();
    assert.equal((await store.listStudies(TOOL.id, 10)).length, 0);
  } finally {
    await close();
  }
});

test('a registration that already carries observations is computed and published at once', async () => {
  const { core, poller, close } = await setup();
  try {
    await poller.tick();
    core.seed(registered('GAUGE-10', { observations: TIGHT }));
    await poller.tick();
    const [e] = core.published('MSA_VALIDATED');
    assert.ok(e, 'published without a human step');
    assert.equal(e.data.gaugeId, 'GAUGE-10');
  } finally {
    await close();
  }
});

test('core down at capture time: saved as retrying (202), published on the next tick', async () => {
  const { core, store, poller, post, close } = await setup();
  try {
    await poller.tick();
    core.seed(registered('GAUGE-11'));
    await poller.tick();
    const [pending] = await store.listStudies(TOOL.id, 1);

    core.failNextPublishes(1);
    const res = await post(`/api/studies/${pending.id}/capture`, { observations: TIGHT });
    assert.equal(res.status, 202);
    assert.equal(res.body.study.publish.state, 'retrying');
    assert.equal(core.published('MSA_VALIDATED').length, 0);

    await poller.tick();
    assert.equal(core.published('MSA_VALIDATED').length, 1);
    assert.equal((await store.getStudy(pending.id)).publish.state, 'published');
  } finally {
    await close();
  }
});

test('ad-hoc study: saved, then published as a root event on explicit request', async () => {
  const { core, post, close } = await setup();
  try {
    const created = await post('/api/studies', { gaugeId: 'GAUGE-20', observations: TIGHT });
    assert.equal(created.status, 201);
    assert.equal(created.body.study.publish.state, 'awaiting_decision');
    assert.equal(core.posted.length, 0, 'nothing is sent without the explicit publish');

    const published = await post(`/api/studies/${created.body.study.id}/publish`, {});
    assert.equal(published.status, 200);
    const [e] = core.published('MSA_VALIDATED');
    assert.equal(e.causation_id, null, 'no platform event behind it');
    assert.equal(e.correlation_id, e.event_id);
    assert.equal(e.asset_id, 'GAUGE-20');

    const twice = await post(`/api/studies/${created.body.study.id}/publish`, {});
    assert.equal(twice.status, 409);
  } finally {
    await close();
  }
});

test('unsupported study types are refused honestly', async () => {
  const { post, close } = await setup();
  try {
    const res = await post('/api/studies', { gaugeId: 'G', studyType: 'linearity', observations: TIGHT });
    assert.equal(res.status, 422);
    assert.match(res.body.errors[0], /no soportado/);
  } finally {
    await close();
  }
});
