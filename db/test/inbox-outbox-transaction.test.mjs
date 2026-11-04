import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { container, root, quiet, docker, sql, prepare, fixture } from './helpers/isolated-postgres.mjs';

function sha256Hex (text) {
  return createHash('sha256').update(typeof text === 'string' ? text : JSON.stringify(text), 'utf8').digest('hex');
}

function makeEnvelope ({ eventId, toolId = 'calculate_cpk_ppk', type = 'CAPABILITY_BELOW_TARGET' }) {
  const env = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform_version: '1.0',
    module: { id: toolId, version: '1.0.0' },
    asset: { asset_id: 'part-01' },
    event: { type, category: 'quality', severity: 'high' },
    data: { cpk: 1.12 },
    metadata: {},
    correlation_id: eventId,
    causation_id: null
  };
  const envelopeText = JSON.stringify(env);
  const envelopeHash = sha256Hex(envelopeText);
  return { env, envelopeText, envelopeHash };
}

test('Etapa 2: Transactional Inbox/Outbox persistence layer (CPK & MSA)', async (t) => {
  const remote = prepare();
  const f = await fixture('calculate-cpk-ppk', remote);
  const { db, role, store, pool, ownerPool } = f;

  try {
    const tool = 'calculate_cpk_ppk';
    await store.setRuntimeIdentity({
      tool,
      environment: 'test',
      publishMode: 'shadow',
      schemaVersion: '003'
    });

    await t.test('atomic commit: inbox + study + outbox + cursor commit together', async () => {
      const eventId = 'evt-tx-001';
      const studyId = 'study-tx-001';
      const rawInput = { id: eventId, partId: 'P1', readings: [10, 11, 10.5] };
      const canonicalInput = { partId: 'P1', readings: [10, 11, 10.5] };
      const inputHash = sha256Hex(canonicalInput);
      const { envelopeText, envelopeHash } = makeEnvelope({ eventId, toolId: tool });

      let handlerExecuted = false;
      const res = await store.processEventTransaction({
        tool,
        consumer: 'cpk_measurements',
        event: {
          eventId,
          sourceSeq: '100',
          rawInput,
          canonicalInput,
          inputHash
        },
        cursor: {
          name: 'cpk_measurements',
          targetSeq: '100'
        },
        handler: async (tx) => {
          handlerExecuted = true;
          await tx.saveStudy({
            id: studyId,
            tool,
            status: 'completed',
            inputEventId: eventId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            doc: { cpk: 1.12 }
          });
          const outboxId = await tx.stageOutbox({
            eventId,
            studyId,
            publicationKey: `cpk:${studyId}:below_target`,
            destinationId: 'core_api',
            envelopeText,
            envelopeHash,
            mode: 'shadow'
          });
          return { studyId, outboxId };
        }
      });

      assert.equal(handlerExecuted, true);
      assert.equal(res.ok, true);
      assert.equal(res.status, 'committed');
      assert.equal(res.outcome, 'processed');

      // Verify DB persistence of all 4 entities
      const inboxRec = await store.getInboxRecord(tool, eventId);
      assert.ok(inboxRec);
      assert.equal(inboxRec.outcome, 'processed');
      assert.equal(inboxRec.studyId, studyId);

      const studyRec = await store.getStudy(studyId);
      assert.ok(studyRec);
      assert.equal(studyRec.id, studyId);

      const outboxRec = await store.getOutboxRecord(tool, eventId);
      assert.ok(outboxRec);
      assert.equal(outboxRec.mode, 'shadow');
      assert.equal(outboxRec.state, 'shadow_recorded');

      const cursorState = await store.getCursorState('cpk_measurements');
      assert.ok(cursorState);
      assert.equal(cursorState.seq, '100');
    });

    await t.test('atomic rollback: mid-transaction handler failure leaves zero orphaned state', async () => {
      const eventId = 'evt-tx-fail';
      const studyId = 'study-tx-fail';
      const rawInput = { id: eventId, fail: true };
      const canonicalInput = { fail: true };
      const inputHash = sha256Hex(canonicalInput);
      const { envelopeText, envelopeHash } = makeEnvelope({ eventId, toolId: tool });

      await assert.rejects(
        store.processEventTransaction({
          tool,
          consumer: 'cpk_measurements',
          event: {
            eventId,
            sourceSeq: '101',
            rawInput,
            canonicalInput,
            inputHash
          },
          cursor: {
            name: 'cpk_measurements',
            targetSeq: '101'
          },
          handler: async (tx) => {
            // Stage study and outbox before crashing
            await tx.saveStudy({
              id: studyId,
              tool,
              status: 'completed',
              inputEventId: eventId,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
            await tx.stageOutbox({
              eventId,
              studyId,
              publicationKey: `cpk:${studyId}:fail`,
              destinationId: 'core_api',
              envelopeText,
              envelopeHash
            });
            throw new Error('Simulated domain or math error during capability analysis');
          }
        }),
        /Simulated domain or math error/
      );

      // Verify zero partial persistence
      assert.equal(await store.getInboxRecord(tool, eventId), null);
      assert.equal(await store.getStudy(studyId), null);
      assert.equal(await store.getOutboxRecord(tool, eventId), null);

      // Cursor must NOT have advanced
      const cursorState = await store.getCursorState('cpk_measurements');
      assert.equal(cursorState.seq, '100');
    });

    await t.test('atomic rejection: invalid business input records rejection and advances cursor without outbox', async () => {
      const eventId = 'evt-tx-rej-001';
      const rawInput = { id: eventId, invalid: 'no readings' };
      const canonicalInput = { invalid: 'no readings' };
      const inputHash = sha256Hex(canonicalInput);

      const res = await store.processEventTransaction({
        tool,
        consumer: 'cpk_measurements',
        event: {
          eventId,
          sourceSeq: '102',
          rawInput,
          canonicalInput,
          inputHash
        },
        cursor: {
          name: 'cpk_measurements',
          targetSeq: '102'
        },
        handler: async (tx) => {
          tx.reject({ code: 'ERR_NO_DATA', reason: 'Payload lacks measurement observations' });
          return null;
        }
      });

      assert.equal(res.ok, true);
      assert.equal(res.status, 'committed');
      assert.equal(res.outcome, 'rejected');

      // Verify inbox and rejections table
      const inboxRec = await store.getInboxRecord(tool, eventId);
      assert.equal(inboxRec.outcome, 'rejected');
      assert.equal(inboxRec.errorDetail, 'Payload lacks measurement observations');

      const rejections = await pool.query('SELECT * FROM public.event_rejections WHERE event_id = $1', [eventId]);
      assert.equal(rejections.rowCount, 1);
      assert.equal(rejections.rows[0].code, 'ERR_NO_DATA');

      // Zero outbox records created
      assert.equal(await store.getOutboxRecord(tool, eventId), null);

      // Cursor advanced past rejected event
      const cursorState = await store.getCursorState('cpk_measurements');
      assert.equal(cursorState.seq, '102');
    });

    await t.test('replay idempotency: duplicate event with same hash recovers outcome without re-execution', async () => {
      const eventId = 'evt-tx-001'; // already committed in first subtest
      const canonicalInput = { partId: 'P1', readings: [10, 11, 10.5] };
      const inputHash = sha256Hex(canonicalInput);

      let handlerCalled = false;
      const res = await store.processEventTransaction({
        tool,
        consumer: 'cpk_measurements',
        event: {
          eventId,
          sourceSeq: '100',
          rawInput: { id: eventId },
          canonicalInput,
          inputHash
        },
        cursor: {
          name: 'cpk_measurements',
          targetSeq: '105' // newer cursor
        },
        handler: async () => {
          handlerCalled = true;
        }
      });

      assert.equal(handlerCalled, false, 'Handler must not execute on replay');
      assert.equal(res.ok, true);
      assert.equal(res.status, 'replay');
      assert.equal(res.outcome, 'processed');
      assert.equal(res.studyId, 'study-tx-001');

      // Cursor safely advanced
      const cursorState = await store.getCursorState('cpk_measurements');
      assert.equal(cursorState.seq, '105');
    });

    await t.test('hash conflict: same event ID with different content is rejected and preserves cursor', async () => {
      const eventId = 'evt-tx-001';
      const conflictingInput = { partId: 'P1', readings: [999, 999] };
      const conflictingHash = sha256Hex(conflictingInput);

      let handlerCalled = false;
      const res = await store.processEventTransaction({
        tool,
        consumer: 'cpk_measurements',
        event: {
          eventId,
          sourceSeq: '106',
          rawInput: conflictingInput,
          canonicalInput: conflictingInput,
          inputHash: conflictingHash
        },
        cursor: {
          name: 'cpk_measurements',
          targetSeq: '106'
        },
        handler: async () => {
          handlerCalled = true;
        }
      });

      assert.equal(handlerCalled, false);
      assert.equal(res.ok, false);
      assert.equal(res.status, 'conflict');
      assert.equal(res.reason, 'input_hash_mismatch');

      // Cursor must NOT have advanced
      const cursorState = await store.getCursorState('cpk_measurements');
      assert.equal(cursorState.seq, '105');
    });

    await t.test('64-bit BIGINT sequence precision beyond Number.MAX_SAFE_INTEGER', async () => {
      const hugeSeq = '9007199254740997'; // > 2^53 - 1 (9007199254740991)
      const eventId = 'evt-huge-seq';
      const input = { data: 'bigint-test' };
      const inputHash = sha256Hex(input);

      const res = await store.processEventTransaction({
        tool,
        consumer: 'cpk_bigint_lane',
        event: {
          eventId,
          sourceSeq: hugeSeq,
          rawInput: input,
          canonicalInput: input,
          inputHash
        },
        cursor: {
          name: 'cpk_bigint_lane',
          targetSeq: hugeSeq
        },
        handler: async () => ({ studyId: 'huge-seq-study' })
      });

      assert.equal(res.ok, true);
      assert.equal(res.status, 'committed');

      const inboxRec = await store.getInboxRecord(tool, eventId);
      assert.equal(inboxRec.sourceSeq, hugeSeq);

      const cursorState = await store.getCursorState('cpk_bigint_lane');
      assert.equal(cursorState.seq, hugeSeq);
    });

    await t.test('concurrency: multiple simultaneous workers on the same event yield exactly 1 commit and N replays', async () => {
      const eventId = 'evt-concurrent-001';
      const studyId = 'study-concurrent-001';
      const input = { measurement: 42 };
      const inputHash = sha256Hex(input);
      const { envelopeText, envelopeHash } = makeEnvelope({ eventId, toolId: tool });

      let commitCount = 0;
      const workerRun = () => store.processEventTransaction({
        tool,
        consumer: 'cpk_measurements',
        event: {
          eventId,
          sourceSeq: '110',
          rawInput: input,
          canonicalInput: input,
          inputHash
        },
        cursor: {
          name: 'cpk_measurements',
          targetSeq: '110'
        },
        handler: async (tx) => {
          commitCount++;
          await tx.saveStudy({
            id: studyId,
            tool,
            status: 'completed',
            inputEventId: eventId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          await tx.stageOutbox({
            eventId,
            studyId,
            publicationKey: `cpk:${studyId}:concurrent`,
            destinationId: 'core_api',
            envelopeText,
            envelopeHash
          });
          return { studyId };
        }
      });

      // 5 concurrent workers attempting the exact same event
      const results = await Promise.all([workerRun(), workerRun(), workerRun(), workerRun(), workerRun()]);

      const committed = results.filter((r) => r.status === 'committed');
      const replayed = results.filter((r) => r.status === 'replay');

      assert.equal(committed.length, 1, 'Exactly one worker must commit the event');
      assert.equal(replayed.length, 4, 'Remaining workers must receive safe replay');
      assert.equal(commitCount, 1, 'Handler must execute only once');

      // Database rows must be singular
      const inboxRows = (await pool.query('SELECT count(*) FROM public.event_inbox WHERE event_id = $1', [eventId])).rows[0].count;
      assert.equal(inboxRows, '1');

      const outboxRows = (await pool.query('SELECT count(*) FROM public.event_outbox WHERE event_id = $1', [eventId])).rows[0].count;
      assert.equal(outboxRows, '1');
    });

    await t.test('shadow isolation: shadow database strictly isolates outbox from live queue', async () => {
      const eventId = 'evt-shadow-isolation';
      const { envelopeText, envelopeHash } = makeEnvelope({ eventId, toolId: tool });

      // Staging in shadow DB automatically marks shadow_recorded
      await store.processEventTransaction({
        tool,
        consumer: 'cpk_measurements',
        event: {
          eventId,
          rawInput: { ok: true },
          canonicalInput: { ok: true },
          inputHash: sha256Hex({ ok: true })
        },
        handler: async (tx) => {
          await tx.stageOutbox({
            eventId,
            publicationKey: 'key-shadow-iso',
            destinationId: 'core_api',
            envelopeText,
            envelopeHash
          });
        }
      });

      const outboxRec = await store.getOutboxRecord(tool, eventId);
      assert.equal(outboxRec.mode, 'shadow');
      assert.equal(outboxRec.state, 'shadow_recorded');

      // Live delivery worker query must return zero rows
      const pending = await store.listPendingOutbox(tool);
      assert.equal(pending.length, 0);

      // Attempting to stage live outbox on shadow database is rejected
      await assert.rejects(
        store.processEventTransaction({
          tool,
          consumer: 'cpk_measurements',
          event: {
            eventId: 'evt-illegal-live',
            rawInput: {},
            canonicalInput: {},
            inputHash: sha256Hex({})
          },
          handler: async (tx) => {
            await tx.stageOutbox({
              eventId: 'evt-illegal-live',
              publicationKey: 'key-illegal',
              destinationId: 'core_api',
              envelopeText: makeEnvelope({ eventId: 'evt-illegal-live', toolId: tool }).envelopeText,
              envelopeHash: makeEnvelope({ eventId: 'evt-illegal-live', toolId: tool }).envelopeHash,
              mode: 'live' // ILLEGAL in shadow database
            });
          }
        }),
        /Cannot stage live outbox event on a database declared as shadow/
      );
    });

    await t.test('manual command transaction: MSA study capture idempotency and concurrency', async () => {
      const msaTool = 'run_msa_analysis';
      await store.setRuntimeIdentity({
        tool: msaTool,
        environment: 'test',
        publishMode: 'shadow',
        schemaVersion: '003'
      });

      const studyId = 'msa-gauge-study-001';
      // Step 1: Registration event puts study in pending state
      await store.saveStudy({
        id: studyId,
        tool: msaTool,
        status: 'pending',
        inputEventId: 'evt-dev-reg-001',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        doc: { gaugeId: 'G-100', status: 'pending' }
      });

      // Step 2: Operator performs manual measurement capture
      const commandId = 'cmd-msa-capture-001';
      const capturePayload = { appraiserTrials: [[10, 10.1], [10.2, 10.1]] };
      const commandHash = sha256Hex(capturePayload);
      const { envelopeText, envelopeHash } = makeEnvelope({
        eventId: 'evt-msa-val-001',
        toolId: msaTool,
        type: 'MSA_VALIDATED'
      });

      let captureCount = 0;
      const executeCapture = () => store.recordManualCommandTransaction({
        tool: msaTool,
        commandId,
        commandType: 'msa_capture',
        commandHash,
        studyId,
        handler: async (tx) => {
          captureCount++;
          const currentStudy = await tx.getStudyForUpdate(studyId);
          assert.equal(currentStudy.status, 'pending');

          const updatedDoc = { ...currentStudy, status: 'completed', verdict: 'acceptable', grrPercent: 8.5 };
          await tx.saveStudy({
            id: studyId,
            tool: msaTool,
            status: 'completed',
            inputEventId: currentStudy.inputEventId,
            createdAt: currentStudy.createdAt,
            updatedAt: new Date().toISOString(),
            doc: updatedDoc
          });

          const outboxId = await tx.stageOutbox({
            eventId: 'evt-msa-val-001',
            studyId,
            publicationKey: `msa:${studyId}:validated`,
            destinationId: 'core_api',
            envelopeText,
            envelopeHash
          });

          return { result: updatedDoc, outboxId };
        }
      });

      // Execute first time: committed
      const firstRes = await executeCapture();
      assert.equal(firstRes.ok, true);
      assert.equal(firstRes.status, 'committed');
      assert.equal(firstRes.result.verdict, 'acceptable');
      assert.equal(captureCount, 1);

      // Verify study status is updated
      const studyAfter = await store.getStudy(studyId);
      assert.equal(studyAfter.status, 'completed');

      // Execute second time (double click / replay): recovers result without re-executing
      const secondRes = await executeCapture();
      assert.equal(secondRes.ok, true);
      assert.equal(secondRes.status, 'replay');
      assert.equal(secondRes.result.verdict, 'acceptable');
      assert.equal(captureCount, 1, 'Handler must NOT re-execute on manual command replay');

      // Execute with conflicting body: rejected
      const conflictRes = await store.recordManualCommandTransaction({
        tool: msaTool,
        commandId,
        commandType: 'msa_capture',
        commandHash: sha256Hex({ different: 'tampered' }),
        studyId,
        handler: async () => { throw new Error('Must not be reached'); }
      });
      assert.equal(conflictRes.ok, false);
      assert.equal(conflictRes.status, 'conflict');
    });

    await t.test('restart recovery: persisted state survives store closure and reopening', async () => {
      // Close active store
      await store.close();

      // Create new store instance on same DB
      const { createStore } = await import('../../tools/calculate-cpk-ppk/src/platform/store.js');
      const freshStore = await createStore({ databaseUrl: f.url, log: quiet });

      try {
        const id = await freshStore.getRuntimeIdentity('calculate_cpk_ppk');
        assert.equal(id.publishMode, 'shadow');

        const cursor = await freshStore.getCursorState('cpk_measurements');
        assert.equal(cursor.seq, '110');

        const bigintCursor = await freshStore.getCursorState('cpk_bigint_lane');
        assert.equal(bigintCursor.seq, '9007199254740997');

        const inbox = await freshStore.getInboxRecord('calculate_cpk_ppk', 'evt-tx-001');
        assert.equal(inbox.outcome, 'processed');

        const outbox = await freshStore.getOutboxRecord('calculate_cpk_ppk', 'evt-tx-001');
        assert.equal(outbox.state, 'shadow_recorded');

        const study = await freshStore.getStudy('study-tx-001');
        assert.equal(study.status, 'completed');

        const cmd = await freshStore.getManualCommand('run_msa_analysis', 'cmd-msa-capture-001');
        assert.equal(cmd.status, 'completed');
      } finally {
        await freshStore.close();
      }
    });

  } finally {
    await f.close();
  }
});
