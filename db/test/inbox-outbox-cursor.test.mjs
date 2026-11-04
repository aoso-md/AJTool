import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepare, fixture, sql } from './helpers/isolated-postgres.mjs';

const input = { measurement: 42 };
const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');

for (const service of ['calculate-cpk-ppk', 'run-msa-analysis']) {
  test(`${service}: cursor lane invariants`, async (t) => {
    const f = await fixture(service, prepare());
    const tool = service.replaceAll('-', '_');
    const consume = (id, seq, cursor, handler = async () => ({})) => f.store.processEventTransaction({
      tool, consumer: cursor.name,
      event: { eventId: id, sourceSeq: seq, rawInput: input, canonicalInput: input, inputHash },
      cursor: { targetSeq: seq, ...cursor }, handler
    });
    try {
      await t.test('a new old event cannot regress the lane or execute its handler', async () => {
        await f.store.setCursor('regression', '100');
        let calls = 0;
        const result = await consume('late-old-event', '99', { name: 'regression' }, async () => { calls++; });
        assert.equal(result.status, 'stale_cursor');
        assert.equal(calls, 0);
        assert.equal((await f.store.getCursorState('regression')).seq, '100');
        assert.equal(await f.store.getInboxRecord(tool, 'late-old-event'), null);
      });
      await t.test('a page fetched at another cursor cannot commit', async () => {
        await f.store.setCursor('page', '20');
        let calls = 0;
        const result = await consume('obsolete-page', '30', { name: 'page', expectedSeq: '10' }, async () => { calls++; });
        assert.equal(result.status, 'stale_cursor');
        assert.equal(calls, 0);
        assert.equal((await f.store.getCursorState('page')).seq, '20');
      });
      await t.test('two first events from the same empty lane cannot both commit a stale page', async () => {
        let calls = 0;
        const handler = async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 40)); };
        const results = await Promise.all([
          consume('bootstrap-a', '10', { name: 'bootstrap', expectedSeq: null }, handler),
          consume('bootstrap-b', '20', { name: 'bootstrap', expectedSeq: null }, handler)
        ]);
        assert.equal(results.filter((r) => r.status === 'committed').length, 1);
        assert.equal(results.filter((r) => r.status === 'stale_cursor').length, 1);
        assert.equal(calls, 1);
      });
      await t.test('unsafe numeric sequence is rejected before persistence', async () => {
        await assert.rejects(consume('unsafe-number', Number.MAX_SAFE_INTEGER + 2, { name: 'unsafe' }), /sequence/i);
        assert.equal(await f.store.getInboxRecord(tool, 'unsafe-number'), null);
        assert.equal(await f.store.getCursorState('unsafe'), null);
      });
      await t.test('generation beyond 2^53 round-trips exactly and fences stale callers', async () => {
        await f.store.setCursor('generation', '10');
        await f.ownerPool.query("UPDATE public.consumer_cursors SET generation=9007199254740993 WHERE name='generation'");
        const state = await f.store.getCursorState('generation');
        assert.equal(String(state.generation), '9007199254740993');
        const result = await consume('stale-generation', '11', { name: 'generation', expectedGeneration: '9007199254740992' });
        assert.equal(result.status, 'stale_cursor');
        assert.equal((await f.store.getCursorState('generation')).seq, '10');
      });
      await t.test('conflicting content leaves durable evidence without advancing the cursor', async () => {
        await consume('conflict-evidence', '10', { name: 'conflict' });
        const other = { measurement: 999 };
        const otherHash = createHash('sha256').update(JSON.stringify(other)).digest('hex');
        const result = await f.store.processEventTransaction({
          tool, consumer: 'conflict',
          event: { eventId: 'conflict-evidence', sourceSeq: '11', rawInput: other, canonicalInput: other, inputHash: otherHash },
          cursor: { name: 'conflict', targetSeq: '11' },
          handler: () => { assert.fail('A conflict must not execute business logic'); }
        });
        assert.equal(result.status, 'conflict');
        assert.equal((await f.store.getCursorState('conflict')).seq, '10');
        const rows = (await f.pool.query("SELECT code, input_hash FROM public.event_rejections WHERE tool=$1 AND event_id='conflict-evidence'", [tool])).rows;
        assert.deepEqual(rows, [{ code: 'input_hash_conflict', input_hash: otherHash }]);
        assert.equal((await f.store.getInboxRecord(tool, 'conflict-evidence')).inputHash, inputHash);
      });
      await t.test('a connection killed after study and outbox writes rolls back every effect', async () => {
        const id = 'connection-killed';
        await assert.rejects(consume(id, '10', { name: 'disconnect' }, async (tx) => {
          const at = new Date().toISOString();
          await tx.saveStudy({ id, tool, status: 'completed', inputEventId: id, createdAt: at, updatedAt: at });
          const envelopeText = JSON.stringify({ event_id: id, module: { id: tool } });
          await tx.stageOutbox({ eventId: id, studyId: id, publicationKey: id, destinationId: 'fake-core', envelopeText });
          const pid = (await tx.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          assert.equal(sql(f.db, `SELECT pg_terminate_backend(${Number(pid)})`), 't');
          await tx.client.query('SELECT 1');
        }));
        // Inspect directly through another connection; recovery is exercised by
        // the existing outage suites, independently of this rollback assertion.
        for (const [table, key] of [['studies', 'id'], ['event_inbox', 'event_id'], ['event_outbox', 'event_id']]) {
          assert.equal((await f.pool.query(`SELECT count(*) AS count FROM public.${table} WHERE ${key}=$1`, [id])).rows[0].count, '0');
        }
        assert.equal((await f.pool.query("SELECT count(*) AS count FROM public.consumer_cursors WHERE name='disconnect'")).rows[0].count, '0');
      });
    } finally { await f.close(); }
  });
}
