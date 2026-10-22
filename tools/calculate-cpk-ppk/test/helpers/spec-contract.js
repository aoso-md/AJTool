import assert from 'node:assert/strict';

// The same behavioral contract runs against RAM and real PostgreSQL.
export async function assertSpecContract (store) {
  const read = async (part, options) => {
    const spec = await store.findSpec(part, 'contract-C', options);
    return spec && [spec.partId || '', spec.lsl, spec.usl];
  };
  await store.upsertSpec({ partId: 'P1', characteristicId: 'contract-C', lsl: 10, usl: 20, sourceSeq: 1 });
  await store.upsertSpec({ partId: 'P2', characteristicId: 'contract-C', lsl: 30, usl: 40, sourceSeq: 100 });
  assert.deepEqual(await read('P1'), ['P1', 10, 20]);
  assert.deepEqual(await read('P2'), ['P2', 30, 40]);
  assert.equal(await read('P3'), null);
  assert.equal(await read(null), null);
  assert.equal(await read(''), null);
  await store.upsertSpec({ partId: '', characteristicId: 'contract-C', lsl: 0, usl: 100, sourceSeq: 500 });
  assert.deepEqual(await read('P1'), ['P1', 10, 20]); // exact wins over a newer global
  assert.deepEqual(await read('P2'), ['P2', 30, 40]);
  assert.deepEqual(await read('P3'), ['', 0, 100]);
  assert.deepEqual(await read(null), ['', 0, 100]);
  assert.equal(await read('P3', { allowGlobal: false }), null);
  assert.equal(await read('', { allowGlobal: false }), null);
  assert.deepEqual(await read('P1', { allowGlobal: false }), ['P1', 10, 20]);
  assert.equal(await store.findSpec('P1', 'unknown'), null);
}
