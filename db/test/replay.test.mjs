import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepare, fixture, quiet } from './helpers/isolated-postgres.mjs';
import { startFakeCore, producedEvent } from '../../tools/calculate-cpk-ppk/test/helpers/fake-core.js';
import { reconcile, replayStatus } from '../../deploy/official/replay.mjs';
import { decisionErrors } from '../../deploy/official/check-transition-decision.mjs';

test('reconstruction approval is bound to the release and explicit manual-data disposition', () => {
  const scope = { tool: 'calculate_cpk_ppk', revision: 'a'.repeat(40) };
  const decision = {
    ...scope, action: 'rebuild_from_core', approvedBy: 'Fixture owner',
    approvedAtUtc: new Date().toISOString(), evidenceReference: 'fixture-approval',
    productionChangeApproved: true, historicalSourceVerified: true, sourceCutoff: '9', specCutoff: '7',
    acceptsReconstructionDifferences: true, manualData: { action: 'discard', evidenceReference: 'fixture-inventory' }
  };
  assert.deepEqual(decisionErrors(decision, scope), ['manual_loss_not_accepted']);
  decision.manualData.explicitlyAcceptsLoss = true;
  assert.deepEqual(decisionErrors(decision, scope), []);
  assert.ok(decisionErrors(decision, { ...scope, revision: 'b'.repeat(40) }).includes('revision_not_approved'));
});

test('reconciliation checks a second page and reports an inbox hash mismatch', async () => {
  const events = Array.from({ length: 101 }, (_, i) => ({
    eventId: `fixture-${i + 1}`, sourceSeq: String(i + 1), inputHash: 'fixture-hash'
  }));
  const lane = 'subscription:calculate_cpk_ppk';
  const calls = [];
  const result = await reconcile({
    store: {
      getCursorState: async () => ({ seq: '101' }),
      getInboxRecord: async (tool, id) => ({
        consumer: lane, outcome: 'ignored', inputHash: id === 'fixture-101' ? 'changed-hash' : 'fixture-hash'
      })
    },
    tool: 'calculate_cpk_ppk', lane, cutoff: '101',
    page: async (core, after) => {
      calls.push(after);
      return { events: events.slice(Number(after), Number(after) + 100) };
    },
    normalize: event => event, sequence: String
  });
  assert.deepEqual(calls, ['0', '100']);
  assert.equal(result.events, 101);
  assert.equal(result.ignored, 100);
  assert.equal(result.mismatched, 1);
  assert.equal(result.complete, false);
});

for (const service of ['calculate-cpk-ppk', 'run-msa-analysis']) test(service + ' PostgreSQL replay', async t => {
  const f = await fixture(service, prepare());
  const { TOOL, createCapabilityTool, createMsaTool } = await import(`../../tools/${service}/src/tool.js`);
  const { createCoreClient } = await import(`../../tools/${service}/src/platform/core-client.js`);
  const { createPoller, createPublisher } = await import(`../../tools/${service}/src/platform/poller.js`);
  const { fromCore } = await import(`../../tools/${service}/src/platform/ies.js`);
  const { inboxEvent, sequenceText } = await import(`../../tools/${service}/src/platform/reliability.js`);
  const fake = await startFakeCore({ consumes: { [TOOL.id]: TOOL.consumes } });
  const core = createCoreClient({ baseUrl: fake.url, apiKey: fake.key });
  const name = `subscription:${TOOL.id}`;
  const cpk = Boolean(createCapabilityTool);
  const seed = () => fake.seed(producedEvent({
    type: TOOL.consumes[0],
    moduleId: cpk ? 'collect_quality_measurements' : 'manage_device_registry',
    data: cpk
      ? { partId: 'SYNTHETIC', characteristicId: 'D', measurements: [10, 10.08, 10, 10.08] }
      : { operation: 'register', gaugeId: 'SYNTHETIC' }
  }));
  if (cpk) fake.seed(producedEvent({
    type: 'PRODUCT_SPEC_UPDATED', moduleId: 'manage_product_specs',
    data: { partId: 'SYNTHETIC', characteristics: [{ id: 'D', lsl: 9.95, usl: 10.05, version: 'R1' }] }
  }));
  const first = seed(), second = seed(), third = seed();
  let reopened;
  const poller = (store, client = core, hook = handler => handler) => {
    const domain = (createCapabilityTool || createMsaTool)({
      store, core: client, publisher: createPublisher({ core: client, mode: 'shadow' }), log: quiet
    });
    return createPoller({
      toolId: TOOL.id, consumes: TOOL.consumes, core: client, store,
      processEvent: hook(domain.processEvent), beforeTick: domain.beforeTick, log: quiet
    });
  };
  try {
    await t.test('ordinary cold start still starts at the tip', async () => {
      const fresh = await fixture(service, prepare());
      try {
        await poller(fresh.store).tick();
        assert.equal(String(await fresh.store.getCursor(name)), String(third.seq));
        assert.equal((await fresh.store.listStudies(TOOL.id, 20)).length, 0);
      } finally { await fresh.close(); }
    });
    await f.store.ensureRuntimeIdentity({ tool: TOOL.id, publishMode: 'shadow' });
    await t.test('initialization serializes with the consumer and inserts zero exactly once', async () => {
      const other = await f.createStore({ databaseUrl: f.url, log: quiet });
      try {
        await f.store.withPollerLock(name, async () => {
          await assert.rejects(other.initializeReplay(TOOL.id), /already active/);
          await assert.rejects(poller(other).tick(), /already active/);
        });
        assert.equal(await f.store.getCursor(name), null);
        assert.equal((await f.store.initializeReplay(TOOL.id)).inserted, true);
        assert.equal((await other.initializeReplay(TOOL.id)).inserted, false);
        assert.equal(String(await other.getCursor(name)), '0');
      } finally { await other.close(); }
    });
    await t.test('interruption resumes after the committed event, dedupes and reconciles source', async () => {
      const requested = [];
      const client = {
        ...core,
        async subscription(tool, since, limit) {
          requested.push(String(since));
          return core.subscription(tool, since, limit);
        },
        latestMaxSeq() { throw new Error('Replay unexpectedly used cold start'); }
      };
      const fault = Object.assign(new Error('synthetic interruption'), { kind: 'retryable', retryAfterMs: 1250 });
      const interrupted = poller(f.store, client, handler => async (event, context) => {
        if (event.eventId === second.event_id) throw fault;
        return handler(event, context);
      });
      await assert.rejects(interrupted.tick(), error => error === fault && error.retryAfterMs === 1250);
      assert.equal(interrupted.status().processedTotal, 1);
      assert.equal(String(await f.store.getCursor(name)), String(first.seq));
      await assert.rejects(f.store.initializeReplay(TOOL.id), /cursor has progressed/);
      reopened = await f.createStore({ databaseUrl: f.url, log: quiet });
      const duplicate = { ...third, seq: Number(third.seq) + 1 };
      fake.rows.push(duplicate);
      const resumed = poller(reopened, client);
      await resumed.tick();
      assert.deepEqual(requested, ['0', String(first.seq)]);
      await resumed.tick();
      assert.equal(String(await reopened.getCursor(name)), String(duplicate.seq));
      const studies = await reopened.listStudies(TOOL.id, 20);
      assert.equal(studies.length, 3);
      assert.ok(studies.every(study => cpk
        ? study.spec.version === 'R1' && study.result.cpk < 1.33
        : study.status === 'pending'));
      assert.equal(fake.posted.length, 0);
      const status = await replayStatus(reopened, TOOL.id);
      assert.deepEqual(status.outcomes, [{ outcome: 'processed', count: '3' }]);
      assert.equal(status.outbox.other, '0');
      const result = await reconcile({
        core, store: reopened, tool: TOOL.id, lane: name, cutoff: String(duplicate.seq),
        page: (client, after) => client.subscription(TOOL.id, after, 100),
        normalize: raw => inboxEvent(fromCore(raw)), sequence: sequenceText
      });
      assert.equal(result.complete, true, JSON.stringify(result));
      assert.equal(result.events, 4);
      assert.equal(result.confirmedCursor, String(duplicate.seq));
      console.log(JSON.stringify({ synthetic: true, tool: TOOL.id, events: result.events, studies: 3,
        confirmedCursor: result.confirmedCursor, shadowOutbox: status.outbox.shadow, corePosts: 0,
        studyIds: studies.map(study => study.id) }));
    });
  } finally {
    if (reopened) await reopened.close();
    await fake.close();
    await f.close();
  }
});
