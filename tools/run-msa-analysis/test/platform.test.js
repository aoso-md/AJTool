// test/platform.test.js — the platform layer: IES envelope, core client,
// store, poller. Identical in both tools, like the code it tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv5, deterministicEventId, fromCore, buildChild, buildRoot, cleanAsset } from '../src/platform/ies.js';
import { createCoreClient, normalizeBaseUrl } from '../src/platform/core-client.js';
import { createStore } from '../src/platform/store.js';
import { createPoller, createPublisher } from '../src/platform/poller.js';
import { startFakeCore, producedEvent, validateCoreEvent } from './helpers/fake-core.js';

const quiet = { info () {}, warn () {}, error () {} };

test('uuidv5 matches the RFC 4122 reference vector', () => {
  // DNS namespace + "www.example.com" — the canonical v5 test vector.
  assert.equal(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
});

test('deterministic event ids: same cause, same id; different cause, different id', () => {
  const a = deterministicEventId('tool_x', 'parent-1', 'SOME_EVENT');
  assert.equal(a, deterministicEventId('tool_x', 'parent-1', 'SOME_EVENT'));
  assert.notEqual(a, deterministicEventId('tool_x', 'parent-2', 'SOME_EVENT'));
  assert.notEqual(a, deterministicEventId('tool_y', 'parent-1', 'SOME_EVENT'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('fromCore reads a flat subscription row and a nested envelope the same way', () => {
  const nested = producedEvent({ type: 'X_HAPPENED', data: { a: 1 }, asset: { asset_id: 'A-1', line_id: 'L2' } });
  const flat = {
    seq: '42', event_id: nested.event_id, timestamp: nested.timestamp, platform_version: '1.0',
    module_id: 'test-producer', module_version: '1.0.0', asset_id: 'A-1', asset_type: null,
    plant_id: null, area_id: null, line_id: 'L2', location: null, event_type: 'X_HAPPENED',
    category: 'quality', severity: 'low', data: { a: 1 }, metadata: { shift: 'A' },
    correlation_id: nested.correlation_id, causation_id: null
  };
  const a = fromCore(nested);
  const b = fromCore(flat);
  assert.equal(b.seq, 42);
  for (const key of ['eventId', 'type', 'category', 'severity', 'platformVersion', 'correlationId']) {
    assert.deepEqual(a[key], b[key], key);
  }
  assert.deepEqual(a.asset, b.asset);
  assert.deepEqual(a.data, b.data);
  assert.deepEqual(a.module, b.module);
});

test('fromCore tolerates data/metadata stored as JSON strings', () => {
  const e = fromCore({ event_id: 'e1', event_type: 'T', asset_id: 'A', data: '{"x":2}', metadata: 'not json' });
  assert.deepEqual(e.data, { x: 2 });
  assert.deepEqual(e.metadata, {});
});

test('buildChild produces an event the core accepts, chained to its parent', () => {
  const parentEnvelope = producedEvent({ type: 'PARENT_EVENT', data: {}, asset: { asset_id: 'A-9', plant_id: 'p1' }, correlationId: 'corr-123' });
  const parent = fromCore(parentEnvelope);
  const child = buildChild({ parent, toolId: 'my_tool', toolVersion: '2.0.0', type: 'CHILD_EVENT', category: 'quality', severity: 'high', data: { v: 1 } });

  assert.ok(validateCoreEvent(child), JSON.stringify(validateCoreEvent.errors));
  assert.equal(child.causation_id, parentEnvelope.event_id);
  assert.equal(child.correlation_id, 'corr-123');
  assert.deepEqual(child.asset, { asset_id: 'A-9', plant_id: 'p1' });
  assert.deepEqual(child.module, { id: 'my_tool', version: '2.0.0' });
  assert.equal(child.metadata.shift, 'A', 'metadata is inherited, like the core bus does');
  assert.equal(child.event_id, buildChild({ parent, toolId: 'my_tool', toolVersion: '2.0.0', type: 'CHILD_EVENT', data: {} }).event_id);
});

test('buildRoot starts its own correlation and is valid', () => {
  const root = buildRoot({ seed: 'study-1', toolId: 't', toolVersion: '1', asset: { asset_id: 'G-1', asset_type: 'gauge', junk: 'x' }, type: 'R', category: 'quality', data: {} });
  assert.ok(validateCoreEvent(root), JSON.stringify(validateCoreEvent.errors));
  assert.equal(root.correlation_id, root.event_id);
  assert.equal(root.causation_id, null);
  assert.equal(root.asset.junk, undefined, 'unknown asset keys would be a 400 at the core');
});

test('cleanAsset refuses nothing silently: asset_id is required to build an envelope', () => {
  assert.deepEqual(cleanAsset({ asset_id: 'x', plant_id: null, line_id: '' }), { asset_id: 'x' });
  assert.throws(() => buildRoot({ seed: 's', toolId: 't', toolVersion: '1', asset: {}, type: 'R', data: {} }), /asset_id/);
});

test('normalizeBaseUrl accepts the core URL with or without /api/v1', () => {
  assert.equal(normalizeBaseUrl('https://core.example.com'), 'https://core.example.com/api/v1');
  assert.equal(normalizeBaseUrl('https://core.example.com/api/v1/'), 'https://core.example.com/api/v1');
  assert.equal(normalizeBaseUrl(''), null);
});

test('memory store: cursor round-trip and newest spec wins', async () => {
  const store = await createStore({ log: quiet });
  assert.equal(await store.getCursor('c'), null);
  await store.setCursor('c', 17);
  assert.equal(await store.getCursor('c'), 17);

  await store.upsertSpec({ partId: 'P', characteristicId: 'C', usl: 2, lsl: 1, version: '2', sourceSeq: 20 });
  await store.upsertSpec({ partId: 'P', characteristicId: 'C', usl: 9, lsl: 8, version: '1', sourceSeq: 10 });
  const spec = await store.findSpec('P', 'C');
  assert.equal(spec.version, '2', 'an older event replayed later must not overwrite a newer spec');
  assert.equal((await store.findSpec('OTHER', 'C')).version, '2', 'falls back to the characteristic on any part');
  assert.equal(store.tier().durable, false);
});

test('core client: 401 and 403 are configuration errors, 503 is retryable, 400 is invalid', async () => {
  const core = await startFakeCore({ consumes: { t: ['X'] } });
  try {
    const bad = createCoreClient({ baseUrl: core.url, apiKey: 'nope' });
    await assert.rejects(bad.latestMaxSeq(['X']), (e) => e.kind === 'auth' && e.status === 401);

    const readOnly = createCoreClient({ baseUrl: core.url, apiKey: core.readOnlyKey });
    const event = buildRoot({ seed: 's', toolId: 't', toolVersion: '1', asset: { asset_id: 'a' }, type: 'X', data: {} });
    await assert.rejects(readOnly.publish(event), (e) => e.kind === 'auth' && e.status === 403 && /events:write/.test(e.message));

    const good = createCoreClient({ baseUrl: core.url, apiKey: core.key });
    await assert.rejects(good.publish({ ...event, extra: 1 }), (e) => e.kind === 'invalid' && e.status === 400);

    core.failNextRequests(1);
    await assert.rejects(good.latestMaxSeq(['X']), (e) => e.kind === 'retryable' && e.status === 503);

    assert.equal((await good.publish(event)).outcome, 'published');
    assert.equal((await good.publish(event)).outcome, 'duplicate', 'same event_id is discarded by the core');
  } finally {
    await core.close();
  }
});

test('poller: cold start at the tip — the backlog is NOT replayed', async () => {
  const core = await startFakeCore({ consumes: { t: ['WORK'] } });
  try {
    core.seed(producedEvent({ type: 'WORK', data: { n: 1 } }));
    core.seed(producedEvent({ type: 'WORK', data: { n: 2 } }));
    const store = await createStore({ log: quiet });
    const seen = [];
    const poller = createPoller({
      toolId: 't', consumes: ['WORK'], core: createCoreClient({ baseUrl: core.url, apiKey: core.key }),
      store, processEvent: async (e) => { seen.push(e.data.n); }, log: quiet
    });

    await poller.tick();
    assert.deepEqual(seen, [], 'old events were already handled by someone; replaying them publishes real duplicates');
    assert.equal(await store.getCursor('subscription:t'), 2);
    assert.equal(poller.status().coldStart.seq, 2);

    core.seed(producedEvent({ type: 'WORK', data: { n: 3 } }));
    core.seed(producedEvent({ type: 'OTHER', data: { n: 99 } }));
    core.seed(producedEvent({ type: 'WORK', data: { n: 4 } }));
    await poller.tick();
    assert.deepEqual(seen, [3, 4], 'only new events of the consumed type, in seq order');
    assert.equal(await store.getCursor('subscription:t'), 5);
  } finally {
    await core.close();
  }
});

test('poller: a retryable failure keeps the cursor on the last finished event', async () => {
  const core = await startFakeCore({ consumes: { t: ['WORK'] } });
  try {
    const store = await createStore({ log: quiet });
    await store.setCursor('subscription:t', 0);
    core.seed(producedEvent({ type: 'WORK', data: { n: 1 } }));
    core.seed(producedEvent({ type: 'WORK', data: { n: 2 } }));
    let calls = 0;
    const poller = createPoller({
      toolId: 't', consumes: ['WORK'], core: createCoreClient({ baseUrl: core.url, apiKey: core.key }), store, log: quiet,
      processEvent: async (e) => {
        calls += 1;
        if (e.data.n === 2 && calls === 2) {
          const err = new Error('core down while publishing');
          err.kind = 'retryable';
          throw err;
        }
      }
    });
    await assert.rejects(poller.tick(), /core down/);
    assert.equal(await store.getCursor('subscription:t'), 1, 'event 1 done, event 2 not');
    await poller.tick();
    assert.equal(await store.getCursor('subscription:t'), 2, 'event 2 retried and done');
  } finally {
    await core.close();
  }
});

test('poller without core config is disabled, and says why', () => {
  const poller = createPoller({ toolId: 't', consumes: ['X'], core: createCoreClient({}), store: {}, processEvent: async () => {}, log: quiet });
  poller.start();
  const s = poller.status();
  assert.equal(s.state, 'disabled');
  assert.match(s.reason, /ISOTOOLS_API_URL/);
});

test('publisher: shadow records the exact envelope and sends nothing', async () => {
  const core = await startFakeCore({ consumes: {} });
  try {
    const client = createCoreClient({ baseUrl: core.url, apiKey: core.key });
    const event = buildRoot({ seed: 's', toolId: 't', toolVersion: '1', asset: { asset_id: 'a' }, type: 'X', data: {} });
    const shadow = await createPublisher({ core: client, mode: 'shadow', log: quiet }).publish(event);
    assert.equal(shadow.state, 'shadow');
    assert.deepEqual(shadow.event, event);
    assert.equal(core.posted.length, 0);

    const live = await createPublisher({ core: client, mode: 'live', log: quiet }).publish(event);
    assert.equal(live.state, 'published');
    assert.equal(core.posted.length, 1);
  } finally {
    await core.close();
  }
});
