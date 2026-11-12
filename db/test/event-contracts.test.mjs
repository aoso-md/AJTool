import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { CORE_EVENT_SCHEMA, startFakeCore, validateCoreEvent } from '../../tools/calculate-cpk-ppk/test/helpers/fake-core.js';

function fixture (event) {
  return JSON.parse(readFileSync(new URL(`./fixtures/orca-events/${event}.json`, import.meta.url), 'utf8'));
}

const events = ['NEW_DEVICE_REGISTERED', 'MEASUREMENTS_CAPTURED', 'MSA_VALIDATED', 'CAPABILITY_BELOW_TARGET'];
const require = createRequire(new URL('../../tools/calculate-cpk-ppk/package.json', import.meta.url));
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const reviewedAjv = new Ajv({ allErrors: true, useDefaults: true, removeAdditional: true });
addFormats(reviewedAjv);
const validateAsReviewedCore = reviewedAjv.compile(CORE_EVENT_SCHEMA);

test('all four fixtures satisfy IES; closed sections and data differ', () => {
  for (const name of events) {
    const envelope = fixture(name);
    assert.equal(envelope.event.type, name);
    assert.equal(validateCoreEvent(envelope), true, JSON.stringify(validateCoreEvent.errors));
    assert.equal(validateAsReviewedCore(envelope), true);
  }

  const event = fixture('NEW_DEVICE_REGISTERED');
  const missingAsset = structuredClone(event);
  delete missingAsset.asset;
  assert.equal(validateAsReviewedCore(missingAsset), false);
  assert.equal(validateAsReviewedCore({ ...event, data: [] }), false);
  assert.equal(validateAsReviewedCore({ ...event, asset: { asset_id: 123 } }), false);
  assert.equal(validateAsReviewedCore({ ...event, asset: { asset_id: '' } }), true);
  assert.equal(validateAsReviewedCore({ ...event, platform_version: '999' }), true);

  event.schema_version = '2';
  event.module.schema_version = '2';
  event.data.schema_version = '2';
  assert.equal(validateCoreEvent(event), false);
  assert.equal(validateAsReviewedCore(event), true);
  assert.equal(Object.hasOwn(event, 'schema_version'), false);
  assert.equal(Object.hasOwn(event.module, 'schema_version'), false);
  assert.equal(event.data.schema_version, '2');
});

const observations = [
  ['P1', 'A', 1, 25.001], ['P1', 'A', 2, 25.002], ['P1', 'B', 1, 25.001], ['P1', 'B', 2, 25.003],
  ['P2', 'A', 1, 25.200], ['P2', 'A', 2, 25.201], ['P2', 'B', 1, 25.202], ['P2', 'B', 2, 25.203]
].map(([partId, operatorId, trial, value]) => ({ partId, operatorId, trial, value }));
const quiet = { info () {}, warn () {}, error () {} };

for (const [service, inputType, outputType] of [
  ['run-msa-analysis', 'NEW_DEVICE_REGISTERED', 'MSA_VALIDATED'],
  ['calculate-cpk-ppk', 'MEASUREMENTS_CAPTURED', 'CAPABILITY_BELOW_TARGET']
]) {
  test(`${inputType} flat subscription produces exact ${outputType} in shadow`, async t => {
    const { TOOL, createCapabilityTool, createMsaTool } = await import(`../../tools/${service}/src/tool.js`);
    const { createStore } = await import(`../../tools/${service}/src/platform/store.js`);
    const { createCoreClient } = await import(`../../tools/${service}/src/platform/core-client.js`);
    const { createPoller, createPublisher } = await import(`../../tools/${service}/src/platform/poller.js`);
    const fake = await startFakeCore({ consumes: { [TOOL.id]: TOOL.consumes } });
    t.after(() => fake.close());
    const store = await createStore({ log: quiet });
    t.after(() => store.close());
    const core = createCoreClient({ baseUrl: fake.url, apiKey: fake.key });
    const publisher = createPublisher({ core, mode: 'shadow', log: quiet });
    const domain = (createMsaTool || createCapabilityTool)({ store, core, publisher, log: quiet });
    const poller = createPoller({ toolId: TOOL.id, consumes: TOOL.consumes, core, store, processEvent: domain.processEvent, log: quiet });
    const input = fixture(inputType);
    if (createMsaTool) {
      input.data.observations = observations;
    } else {
      await store.upsertSpec({
        partId: input.data.partId, characteristicId: input.data.characteristicId,
        lsl: 24.95, usl: 25.05, version: '1', sourceSeq: 1, sourceEventId: input.causation_id
      });
    }
    await poller.tick();
    const blankAsset = structuredClone(input);
    blankAsset.event_id = '8a000000-0000-4000-8000-000000000006';
    blankAsset.asset.asset_id = '';
    const malformedData = structuredClone(input);
    malformedData.event_id = '8a000000-0000-4000-8000-000000000007';
    if (createMsaTool) delete malformedData.data.operation;
    else malformedData.data.measurements[0] = { value: 25 };
    const wrongProducer = structuredClone(input);
    wrongProducer.event_id = '8a000000-0000-4000-8000-000000000008';
    wrongProducer.module.id = 'wrong-producer';
    const wrongType = structuredClone(input);
    wrongType.event_id = '8a000000-0000-4000-8000-000000000009';
    wrongType.event.type = inputType + '_TYPO';
    fake.seed(blankAsset);
    fake.seed(malformedData);
    fake.seed(wrongProducer);
    fake.seed(wrongType);
    const row = fake.seed(input);
    await poller.tick();
    const rejected = await store.findStudyByInputEvent(TOOL.id, blankAsset.event_id);
    assert.equal(rejected.status, 'skipped');
    assert.match(rejected.reason, /asset\.asset_id/);
    assert.equal(rejected.publish.state, 'not_required');
    const other = await store.findStudyByInputEvent(TOOL.id, malformedData.event_id);
    if (createMsaTool) assert.ok(!other);
    else {
      assert.equal(other.status, 'skipped');
      assert.equal(other.publish.state, 'not_required');
    }

    assert.ok(!await store.findStudyByInputEvent(TOOL.id, wrongProducer.event_id));
    assert.ok(!await store.findStudyByInputEvent(TOOL.id, wrongType.event_id));
    const study = await store.findStudyByInputEvent(TOOL.id, input.event_id);
    assert.equal(study.status, 'completed');
    assert.equal(study.publish.state, 'shadow');
    const output = study.publish.event;
    const expected = fixture(outputType);
    assert.equal(output.correlation_id, input.correlation_id);
    assert.equal(output.causation_id, input.event_id);
    assert.equal(output.data.studyId, study.id);
    assert.equal(validateCoreEvent(output), true, JSON.stringify(validateCoreEvent.errors));
    assert.deepEqual(output, { ...expected, timestamp: output.timestamp, data: { ...expected.data, studyId: study.id } });

    fake.rows.push({ ...row, seq: row.seq + 1 });
    await poller.tick();
    assert.deepEqual(await store.findStudyByInputEvent(TOOL.id, input.event_id), study);
    assert.equal(String(await store.getCursor(`subscription:${TOOL.id}`)), String(row.seq + 1));
    assert.equal(fake.posted.length, 0);
  });
}
