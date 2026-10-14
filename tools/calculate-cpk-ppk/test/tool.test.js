// test/tool.test.js — calculate_cpk_ppk end to end against a fake ORCA core:
// subscription in, spec cache, CAPABILITY_BELOW_TARGET out, as the real
// platform chain does it (rule-pkg-006 -> this tool -> rule-qual-005).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/platform/store.js';
import { createCoreClient } from '../src/platform/core-client.js';
import { createPoller, createPublisher } from '../src/platform/poller.js';
import { TOOL, createCapabilityTool, specsFromEvent } from '../src/tool.js';
import { fromCore } from '../src/platform/ies.js';
import { startFakeCore, producedEvent } from './helpers/fake-core.js';

const quiet = { info () {}, warn () {}, error () {} };

// Shapes copied from the core's reference handlers (src/tools/*.js).
const spec = (characteristicId, usl, lsl, version, partId = 'PART-001') => producedEvent({
  type: 'PRODUCT_SPEC_UPDATED',
  data: { partId, action: 'update', characteristics: [{ id: characteristicId, usl, lsl, version }] }
});
const measured = (characteristicId, measurements, partId = 'PART-001') => producedEvent({
  type: 'MEASUREMENTS_CAPTURED',
  data: { partId, characteristicId, measurements, passFailResult: 'pass', defectsFound: 0 },
  asset: { asset_id: 'LINE-2-ST-4', plant_id: 'plant_01', line_id: 'line_2' }
});

async function setup ({ mode = 'live' } = {}) {
  const core = await startFakeCore({ consumes: { [TOOL.id]: TOOL.consumes } });
  const store = await createStore({ log: quiet });
  const client = createCoreClient({ baseUrl: core.url, apiKey: core.key });
  const publisher = createPublisher({ core: client, mode, log: quiet });
  const tool = createCapabilityTool({ store, core: client, publisher, log: quiet });
  const poller = createPoller({
    toolId: TOOL.id, consumes: TOOL.consumes, core: client, store,
    processEvent: tool.processEvent, beforeTick: tool.beforeTick, log: quiet
  });
  return { core, store, client, publisher, tool, poller };
}

test('specsFromEvent reads the core PRODUCT_SPEC_UPDATED shape', () => {
  const e = fromCore({ ...spec('CHAR-DIAM-01', 10.05, 9.95, 2), seq: 7 });
  assert.deepEqual(specsFromEvent(e).map(({ characteristicId, usl, lsl, version, sourceSeq }) => ({ characteristicId, usl, lsl, version, sourceSeq })),
    [{ characteristicId: 'CHAR-DIAM-01', usl: 10.05, lsl: 9.95, version: '2', sourceSeq: 7 }]);
});

test('end to end: below-target measurement publishes CAPABILITY_BELOW_TARGET chained to its cause', async () => {
  const { core, store, poller } = await setup();
  try {
    core.seed(measured('CHAR-OLD', [1, 2, 3])); // backlog — must not be processed
    await poller.tick(); // cold start at the tip

    core.seed(spec('CHAR-SLOT', 5.1, 4.9, 3));
    const input = measured('CHAR-SLOT', [5.01, 5.08, 4.95, 5.12, 4.91, 5.06, 4.98, 5.1]);
    core.seed(input);
    await poller.tick();

    assert.deepEqual(core.rejected, [], 'every published event must pass the core schema');
    const out = core.published('CAPABILITY_BELOW_TARGET');
    assert.equal(out.length, 1);
    const e = out[0];
    assert.equal(e.module_id, 'calculate_cpk_ppk');
    assert.equal(e.causation_id, input.event_id, 'causation = the MEASUREMENTS_CAPTURED that caused it');
    assert.equal(e.correlation_id, input.correlation_id, 'same chain as its cause');
    assert.equal(e.asset_id, 'LINE-2-ST-4');
    assert.equal(e.line_id, 'line_2');
    assert.equal(e.category, 'quality');
    assert.equal(e.severity, 'high');
    assert.equal(e.data.status, 'not_capable');
    assert.equal(e.data.characteristicId, 'CHAR-SLOT');
    assert.equal(e.data.specVersion, '3', 'traceable to the exact spec version it was judged against');
    for (const field of ['cp', 'cpk', 'pp', 'ppk', 'sigmaLevel', 'ppmDefects']) {
      assert.equal(typeof e.data[field], 'number', `contract field ${field}`);
    }

    const studies = await store.listStudies(TOOL.id, 10);
    assert.equal(studies.length, 1, 'the backlog event was not processed');
    assert.equal(studies[0].publish.state, 'published');
  } finally {
    await core.close();
  }
});

test('a capable process is recorded but NOT published (core rule only routes below target)', async () => {
  const { core, store, poller } = await setup();
  try {
    await poller.tick();
    core.seed(spec('CHAR-OK', 11, 9, 1));
    core.seed(measured('CHAR-OK', [10, 10.1, 10, 10.1, 10.05]));
    await poller.tick();
    assert.equal(core.published('CAPABILITY_BELOW_TARGET').length, 0);
    const [study] = await store.listStudies(TOOL.id, 1);
    assert.equal(study.verdict, 'capable');
    assert.equal(study.publish.state, 'not_required');
  } finally {
    await core.close();
  }
});

test('no known spec: the study is SKIPPED with the reason, and nothing is published', async () => {
  const { core, store, poller } = await setup();
  try {
    await poller.tick();
    core.seed(measured('CHAR-NO-SPEC', [1, 2, 3, 4]));
    await poller.tick();
    assert.equal(core.published('CAPABILITY_BELOW_TARGET').length, 0);
    const [study] = await store.listStudies(TOOL.id, 1);
    assert.equal(study.status, 'skipped');
    assert.match(study.reason, /CHAR-NO-SPEC/);
    assert.match(study.reason, /PRODUCT_SPEC_UPDATED/);
  } finally {
    await core.close();
  }
});

test('limits carried inside the measurement event take precedence over the cache', async () => {
  const { core, store, poller } = await setup();
  try {
    await poller.tick();
    core.seed(spec('CHAR-X', 100, 0, 1));
    core.seed(producedEvent({ type: 'MEASUREMENTS_CAPTURED', data: { characteristicId: 'CHAR-X', measurements: [10, 12, 10, 12], usl: 14, lsl: 8 } }));
    await poller.tick();
    const [study] = await store.listStudies(TOOL.id, 1);
    assert.equal(study.spec.source, 'event');
    assert.equal(study.result.usl, 14);
  } finally {
    await core.close();
  }
});

test('replays never duplicate: lost cursor AND lost database still yield one event', async () => {
  const { core, poller } = await setup();
  try {
    await poller.tick();
    core.seed(spec('CHAR-SLOT', 5.1, 4.9, 3));
    core.seed(measured('CHAR-SLOT', [5.01, 5.08, 4.95, 5.12, 4.91, 5.06, 4.98, 5.1]));
    await poller.tick();
    assert.equal(core.published('CAPABILITY_BELOW_TARGET').length, 1);

    // Worst case: a brand-new instance with an empty store, reprocessing from 0.
    const store2 = await createStore({ log: quiet });
    await store2.setCursor(`subscription:${TOOL.id}`, 0);
    const client = createCoreClient({ baseUrl: core.url, apiKey: core.key });
    const tool2 = createCapabilityTool({ store: store2, core: client, publisher: createPublisher({ core: client, mode: 'live', log: quiet }), log: quiet });
    const poller2 = createPoller({ toolId: TOOL.id, consumes: TOOL.consumes, core: client, store: store2, processEvent: tool2.processEvent, beforeTick: tool2.beforeTick, log: quiet });
    await poller2.tick();

    assert.equal(core.published('CAPABILITY_BELOW_TARGET').length, 1, 'deterministic event_id: the core discards the repeat');
    const [study] = await store2.listStudies(TOOL.id, 5);
    assert.equal(study.publish.state, 'duplicate');
  } finally {
    await core.close();
  }
});

test('shadow mode computes and stores the would-be event, sends nothing', async () => {
  const { core, store, poller } = await setup({ mode: 'shadow' });
  try {
    await poller.tick();
    core.seed(spec('CHAR-SLOT', 5.1, 4.9, 3));
    core.seed(measured('CHAR-SLOT', [5.01, 5.08, 4.95, 5.12, 4.91, 5.06, 4.98, 5.1]));
    await poller.tick();
    assert.equal(core.posted.length, 0);
    const [study] = await store.listStudies(TOOL.id, 1);
    assert.equal(study.publish.state, 'shadow');
    assert.equal(study.publish.event.event.type, 'CAPABILITY_BELOW_TARGET');
  } finally {
    await core.close();
  }
});

test('core outage while publishing: cursor holds, next tick publishes', async () => {
  const { core, store, poller } = await setup();
  try {
    await poller.tick();
    core.seed(spec('CHAR-SLOT', 5.1, 4.9, 3));
    core.seed(measured('CHAR-SLOT', [5.01, 5.08, 4.95, 5.12, 4.91, 5.06, 4.98, 5.1]));
    const before = await store.getCursor(`subscription:${TOOL.id}`);

    // Spec query and subscription succeed — then the POST fails with a 503.
    core.failNextPublishes(1);
    await assert.rejects(poller.tick(), (e) => e.kind === 'retryable');
    assert.equal(await store.getCursor(`subscription:${TOOL.id}`), before, 'not advanced past the unpublished event');
    const [pending] = await store.listStudies(TOOL.id, 1);
    assert.equal(pending.publish.state, 'retrying');

    await poller.tick();
    assert.equal(core.published('CAPABILITY_BELOW_TARGET').length, 1);
    const [done] = await store.listStudies(TOOL.id, 1);
    assert.equal(done.publish.state, 'published');
  } finally {
    await core.close();
  }
});
