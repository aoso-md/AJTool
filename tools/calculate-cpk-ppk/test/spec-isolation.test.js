import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/platform/store.js';
import { assertSpecContract } from './helpers/spec-contract.js';
test('part specifications never leak across parts', async () => {
  const store = await createStore({ log: { info(){}, warn(){}, error(){} } });
  await store.upsertSpec({ partId: 'P2', characteristicId: 'C', lsl: 8, usl: 12 });
  assert.equal(await store.findSpec('P1', 'C'), null);
  await store.upsertSpec({ partId: '', characteristicId: 'C', lsl: 1, usl: 5 });
  assert.equal((await store.findSpec('P1', 'C')).lsl, 1);
  assert.equal((await store.findSpec('P1', 'C')).usl, 5);
  assert.equal((await store.findSpec('P2', 'C')).lsl, 8);
  assert.equal((await store.findSpec('P2', 'C')).usl, 12);
});

test('exact part, optional global and never another part: complete spec contract', async () => {
  const store = await createStore({ log: { info () {}, error () {} } });
  try { await assertSpecContract(store); } finally { await store.close(); }
});
