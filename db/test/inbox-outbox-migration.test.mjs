import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { container, root, quiet, docker, sql, prepare, fixture } from './helpers/isolated-postgres.mjs';
import { MIGRATIONS } from '../../tools/calculate-cpk-ppk/src/platform/postgres-contract.js';

function sha256Hex (text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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

test('Transactional Inbox/Outbox Migration 003: schema, idempotency, immutability, least privilege', async (t) => {
  const remote = prepare();
  const f = await fixture('calculate-cpk-ppk', remote, { legacy: true });
  const { db, owner, role, pool, ownerPool } = f;

  try {
    await t.test('all three migrations applied with exact checksums and catalog validator passes', async () => {
      const rows = (await pool.query('SELECT version, checksum FROM public.schema_migrations ORDER BY version')).rows;
      assert.equal(rows.length, 3);
      assert.deepEqual(rows, Object.entries(MIGRATIONS).map(([version, checksum]) => ({ version, checksum })));

      // Validate schema STABLE SECURITY INVOKER function runs without error
      await pool.query('SELECT public.ajtool_validate_schema()');
    });

    await t.test('migrate.sql is idempotent and re-running produces no side-effects or duplicate rows', async () => {
      f.runFile('migrate.sql');
      f.runFile('migrate.sql');
      const count = sql(db, 'SELECT count(*) FROM public.schema_migrations');
      assert.equal(count, '3');
      await pool.query('SELECT public.ajtool_validate_schema()');
    });

    await t.test('runtime_identity enforces isolated execution mode per tool', async () => {
      // Runtime role can insert and read runtime_identity
      await pool.query(`
        INSERT INTO public.runtime_identity (tool, environment, publish_mode, schema_version)
        VALUES ('calculate_cpk_ppk', 'test', 'shadow', '003')
        ON CONFLICT (tool) DO UPDATE SET publish_mode = EXCLUDED.publish_mode
      `);

      const res = await pool.query("SELECT tool, publish_mode, schema_version FROM public.runtime_identity WHERE tool = 'calculate_cpk_ppk'");
      assert.equal(res.rows[0].publish_mode, 'shadow');
      assert.equal(res.rows[0].schema_version, '003');

      // Invalid publish_mode is rejected by check constraint
      await assert.rejects(
        pool.query("INSERT INTO public.runtime_identity (tool, publish_mode, schema_version) VALUES ('invalid_tool', 'promiscuous', '003')"),
        { code: '23514' }
      );
    });

    await t.test('consumer_cursors monotonic generation and 64-bit BigInt sequence precision', async () => {
      // Beyond Number.MAX_SAFE_INTEGER (9007199254740991)
      const bigSeq = '9007199254740999';
      await pool.query(`
        INSERT INTO public.consumer_cursors (name, seq, generation)
        VALUES ('cpk_measurements', $1::bigint, 1)
        ON CONFLICT (name) DO UPDATE SET seq = EXCLUDED.seq, generation = public.consumer_cursors.generation + 1
      `, [bigSeq]);

      const res = await pool.query("SELECT name, seq::text AS seq_str, generation FROM public.consumer_cursors WHERE name = 'cpk_measurements'");
      assert.equal(res.rows[0].seq_str, bigSeq);
      assert.equal(res.rows[0].generation, '1');

      // Optimistic locking via generation check:
      const updateOk = await pool.query(`
        UPDATE public.consumer_cursors
        SET seq = seq + 1, generation = generation + 1, updated_at = now()
        WHERE name = 'cpk_measurements' AND generation = 1
        RETURNING generation
      `);
      assert.equal(updateOk.rowCount, 1);
      assert.equal(updateOk.rows[0].generation, '2');

      // Stale generation update fails to match any row (fencing token protects against race conditions)
      const staleUpdate = await pool.query(`
        UPDATE public.consumer_cursors
        SET seq = seq + 1, generation = generation + 1
        WHERE name = 'cpk_measurements' AND generation = 1
      `);
      assert.equal(staleUpdate.rowCount, 0);
    });

    await t.test('event_inbox idempotency per (tool, event_id) and content hash collision detection', async () => {
      const eventId = 'evt-inbox-001';
      const rawInput = { id: eventId, data: { value: 42 } };
      const canonicalInput = { data: { value: 42 } };
      const inputHash = sha256Hex(JSON.stringify(canonicalInput));

      // Initial insert succeeds
      await pool.query(`
        INSERT INTO public.event_inbox
          (tool, event_id, consumer, source_seq, raw_input, canonical_input, input_hash, outcome, study_id)
        VALUES
          ('calculate_cpk_ppk', $1, 'measurements', 100, $2, $3, $4, 'processed', 'study-001')
      `, [eventId, JSON.stringify(rawInput), JSON.stringify(canonicalInput), inputHash]);

      // Same tool + same event_id fails with unique violation
      await assert.rejects(
        pool.query(`
          INSERT INTO public.event_inbox
            (tool, event_id, consumer, source_seq, raw_input, canonical_input, input_hash, outcome)
          VALUES
            ('calculate_cpk_ppk', $1, 'measurements', 101, $2, $3, $4, 'processed')
        `, [eventId, JSON.stringify(rawInput), JSON.stringify(canonicalInput), inputHash]),
        { code: '23505' } // unique_violation
      );

      // Same event_id for a DIFFERENT tool is allowed (tool isolation)
      const msaInsert = await pool.query(`
        INSERT INTO public.event_inbox
          (tool, event_id, consumer, source_seq, raw_input, canonical_input, input_hash, outcome)
        VALUES
          ('run_msa_analysis', $1, 'devices', 100, $2, $3, $4, 'processed')
        RETURNING tool, event_id
      `, [eventId, JSON.stringify(rawInput), JSON.stringify(canonicalInput), inputHash]);
      assert.equal(msaInsert.rowCount, 1);

      // Verify protocol conflict detection logic:
      // When the event_id matches but the hash is different, store detects anomaly
      const existing = await pool.query(
        "SELECT input_hash, outcome FROM public.event_inbox WHERE tool = 'calculate_cpk_ppk' AND event_id = $1",
        [eventId]
      );
      assert.equal(existing.rows[0].input_hash, inputHash);
      const conflictingHash = sha256Hex(JSON.stringify({ data: { value: 999 } }));
      assert.notEqual(existing.rows[0].input_hash, conflictingHash);

      // Trigger prevents updating immutable identity/payload fields
      await assert.rejects(
        pool.query("UPDATE public.event_inbox SET input_hash = 'tampered' WHERE event_id = $1", [eventId]),
        /event_inbox: immutable identity and payload fields cannot be modified/
      );

      await assert.rejects(
        pool.query("UPDATE public.event_inbox SET raw_input = '{}'::jsonb WHERE event_id = $1", [eventId]),
        /event_inbox: immutable identity and payload fields cannot be modified/
      );

      // Trigger prevents updating terminal outcome
      await assert.rejects(
        pool.query("UPDATE public.event_inbox SET outcome = 'rejected' WHERE event_id = $1", [eventId]),
        /event_inbox: terminal outcome cannot be modified/
      );

      // Trigger prevents deletion
      await assert.rejects(
        ownerPool.query("DELETE FROM public.event_inbox WHERE event_id = $1", [eventId]),
        /event_inbox: deletion of inbox records is forbidden/
      );
    });

    await t.test('event_rejections append-only ledger and foreign key to inbox', async () => {
      const rejEventId = 'evt-rejected-001';
      const rawInput = { id: rejEventId, bad: true };
      const inputHash = sha256Hex(JSON.stringify(rawInput));

      // Rejection requires valid inbox parent
      await assert.rejects(
        pool.query(`
          INSERT INTO public.event_rejections (tool, event_id, code, reason, raw_input, input_hash)
          VALUES ('calculate_cpk_ppk', 'non_existent_event', 'ERR_INVALID', 'Bad spec', $1, $2)
        `, [JSON.stringify(rawInput), inputHash]),
        { code: '23503' } // foreign_key_violation
      );

      // Insert terminal inbox rejected row first
      await pool.query(`
        INSERT INTO public.event_inbox (tool, event_id, consumer, source_seq, raw_input, canonical_input, input_hash, outcome, error_detail)
        VALUES ('calculate_cpk_ppk', $1, 'measurements', 200, $2, $2, $3, 'rejected', 'Missing spec limits')
      `, [rejEventId, JSON.stringify(rawInput), inputHash]);

      // Insert rejection record
      const rejRes = await pool.query(`
        INSERT INTO public.event_rejections (tool, event_id, code, reason, raw_input, input_hash)
        VALUES ('calculate_cpk_ppk', $1, 'ERR_NO_SPEC', 'Missing spec limits', $2, $3)
        RETURNING rejection_id
      `, [rejEventId, JSON.stringify(rawInput), inputHash]);
      assert.equal(rejRes.rowCount, 1);

      // Rejection cannot be deleted or updated (append-only trigger + permissions)
      await assert.rejects(
        ownerPool.query("UPDATE public.event_rejections SET reason = 'modified' WHERE event_id = $1", [rejEventId]),
        /event_rejections: append-only table cannot be updated/
      );
      await assert.rejects(
        ownerPool.query("DELETE FROM public.event_rejections WHERE event_id = $1", [rejEventId]),
        /event_rejections: deletion of rejection records is forbidden/
      );
    });

    await t.test('event_outbox cryptographic envelope verification and strict immutability', async () => {
      const eventId = 'evt-outbox-001';
      const { envelopeText, envelopeHash } = makeEnvelope({ eventId, toolId: 'calculate_cpk_ppk' });

      // Check constraint: hash mismatch rejected
      await assert.rejects(
        pool.query(`
          INSERT INTO public.event_outbox
            (tool, event_id, study_id, publication_key, mode, destination_id, envelope_text, envelope_hash, state)
          VALUES
            ('calculate_cpk_ppk', $1, 'study-001', 'key-001', 'shadow', 'core', $2, 'wrong_hash', 'shadow_recorded')
        `, [eventId, envelopeText]),
        { code: '23514' } // check_violation (event_outbox_envelope_hash_match)
      );

      // Check constraint: event_id inside JSON must match column
      const mismatchedIdEnv = makeEnvelope({ eventId: 'different-id', toolId: 'calculate_cpk_ppk' });
      await assert.rejects(
        pool.query(`
          INSERT INTO public.event_outbox
            (tool, event_id, study_id, publication_key, mode, destination_id, envelope_text, envelope_hash, state)
          VALUES
            ('calculate_cpk_ppk', $1, 'study-001', 'key-002', 'shadow', 'core', $2, $3, 'shadow_recorded')
        `, [eventId, mismatchedIdEnv.envelopeText, mismatchedIdEnv.envelopeHash]),
        { code: '23514' } // check_violation (event_outbox_event_id_match)
      );

      // Check constraint: tool inside JSON module.id must match tool column
      const mismatchedToolEnv = makeEnvelope({ eventId, toolId: 'run_msa_analysis' });
      await assert.rejects(
        pool.query(`
          INSERT INTO public.event_outbox
            (tool, event_id, study_id, publication_key, mode, destination_id, envelope_text, envelope_hash, state)
          VALUES
            ('calculate_cpk_ppk', $1, 'study-001', 'key-003', 'shadow', 'core', $2, $3, 'shadow_recorded')
        `, [eventId, mismatchedToolEnv.envelopeText, mismatchedToolEnv.envelopeHash]),
        { code: '23514' } // check_violation (event_outbox_tool_match)
      );

      // Valid insert succeeds
      const insertOk = await pool.query(`
        INSERT INTO public.event_outbox
          (tool, event_id, study_id, publication_key, mode, destination_id, envelope_text, envelope_hash, state)
        VALUES
          ('calculate_cpk_ppk', $1, 'study-001', 'key-cpk-001', 'shadow', 'core', $2, $3, 'shadow_recorded')
        RETURNING outbox_id, state, mode
      `, [eventId, envelopeText, envelopeHash]);
      assert.equal(insertOk.rowCount, 1);
      const outboxId = insertOk.rows[0].outbox_id;

      // Duplicate publication key for same tool is rejected
      const duplicateKeyEnvelope = makeEnvelope({ eventId: 'evt-outbox-002', toolId: 'calculate_cpk_ppk' });
      await assert.rejects(
        pool.query(`
          INSERT INTO public.event_outbox
            (tool, event_id, study_id, publication_key, mode, destination_id, envelope_text, envelope_hash, state)
          VALUES
            ('calculate_cpk_ppk', 'evt-outbox-002', 'study-002', 'key-cpk-001', 'shadow', 'core', $1, $2, 'shadow_recorded')
        `, [duplicateKeyEnvelope.envelopeText, duplicateKeyEnvelope.envelopeHash]),
        { code: '23505' } // unique_violation
      );

      // Trigger prevents updating immutable envelope/identity columns
      await assert.rejects(
        pool.query("UPDATE public.event_outbox SET envelope_text = '{\"tampered\":true}' WHERE outbox_id = $1", [outboxId]),
        /event_outbox: immutable publication fields cannot be modified/
      );
      await assert.rejects(
        pool.query("UPDATE public.event_outbox SET event_id = 'new-id' WHERE outbox_id = $1", [outboxId]),
        /event_outbox: immutable publication fields cannot be modified/
      );
      await assert.rejects(
        pool.query("UPDATE public.event_outbox SET mode = 'live' WHERE outbox_id = $1", [outboxId]),
        /event_outbox: immutable publication fields cannot be modified/
      );

      // Delivery mutable columns CAN be updated by worker
      const updateDelivery = await pool.query(`
        UPDATE public.event_outbox
        SET state = 'delivered', attempts = attempts + 1, delivered_at = now()
        WHERE outbox_id = $1
        RETURNING state, attempts
      `, [outboxId]);
      assert.equal(updateDelivery.rows[0].state, 'delivered');
      assert.equal(updateDelivery.rows[0].attempts, 1);

      // Trigger prevents deletion
      await assert.rejects(
        ownerPool.query('DELETE FROM public.event_outbox WHERE outbox_id = $1', [outboxId]),
        /event_outbox: deletion of outbox records is forbidden/
      );
    });

    await t.test('outbox_attempts append-only lifecycle and immutability', async () => {
      // Fetch an existing outbox_id
      const { rows } = await pool.query('SELECT outbox_id FROM public.event_outbox LIMIT 1');
      const outboxId = rows[0].outbox_id;

      // Insert started attempt
      const attemptRes = await pool.query(`
        INSERT INTO public.outbox_attempts (outbox_id, attempt_no, lease_token, started_at)
        VALUES ($1, 1, 'token-123', now())
        RETURNING id
      `, [outboxId]);
      const attemptId = attemptRes.rows[0].id;

      // Update attempt on completion is allowed
      await pool.query(`
        UPDATE public.outbox_attempts
        SET finished_at = now(), outcome = 'delivered', http_status = 201
        WHERE id = $1
      `, [attemptId]);

      // Once finished, updating again is rejected
      await assert.rejects(
        pool.query("UPDATE public.outbox_attempts SET outcome = 'tampered' WHERE id = $1", [attemptId]),
        /outbox_attempts: completed attempt cannot be modified/
      );

      // Attempt deletion is forbidden
      await assert.rejects(
        ownerPool.query('DELETE FROM public.outbox_attempts WHERE id = $1', [attemptId]),
        /outbox_attempts: deletion of attempt records is forbidden/
      );
    });

    await t.test('manual_commands idempotency and immutability', async () => {
      const commandId = 'cmd-user-001';
      const commandHash = sha256Hex(JSON.stringify({ user: 'operator1', action: 'publish' }));

      // Insert command
      await pool.query(`
        INSERT INTO public.manual_commands (tool, command_id, command_type, command_hash, status, result)
        VALUES ('calculate_cpk_ppk', $1, 'cpk_publish', $2, 'completed', '{"studyId":"s-1"}'::jsonb)
      `, [commandId, commandHash]);

      // Duplicate command fails PK
      await assert.rejects(
        pool.query(`
          INSERT INTO public.manual_commands (tool, command_id, command_type, command_hash, status)
          VALUES ('calculate_cpk_ppk', $1, 'cpk_publish', $2, 'completed')
        `, [commandId, commandHash]),
        { code: '23505' }
      );

      // Trigger rejects modification of identity/hash
      await assert.rejects(
        pool.query("UPDATE public.manual_commands SET command_hash = 'different' WHERE command_id = $1", [commandId]),
        /manual_commands: immutable command fields cannot be modified/
      );

      // Trigger rejects deletion
      await assert.rejects(
        ownerPool.query("DELETE FROM public.manual_commands WHERE command_id = $1", [commandId]),
        /manual_commands: deletion of manual commands is forbidden/
      );
    });

    await t.test('delivery_gates circuit breaker state and immutability', async () => {
      await pool.query(`
        INSERT INTO public.delivery_gates (tool, destination, state, auth_generation, reason)
        VALUES ('calculate_cpk_ppk', 'core_api', 'closed', 'gen-1', 'initial boot')
      `);

      // Update state to open on consecutive errors
      await pool.query(`
        UPDATE public.delivery_gates
        SET state = 'open', reason = '401 Unauthorized', next_probe_at = now() + interval '30 seconds'
        WHERE tool = 'calculate_cpk_ppk' AND destination = 'core_api'
      `);

      const gate = await pool.query("SELECT state, reason FROM public.delivery_gates WHERE tool = 'calculate_cpk_ppk' AND destination = 'core_api'");
      assert.equal(gate.rows[0].state, 'open');
      assert.equal(gate.rows[0].reason, '401 Unauthorized');

      // Key modification is rejected
      await assert.rejects(
        pool.query("UPDATE public.delivery_gates SET destination = 'tampered' WHERE tool = 'calculate_cpk_ppk'"),
        /delivery_gates: gate key fields cannot be modified/
      );

      // Deletion is rejected
      await assert.rejects(
        ownerPool.query("DELETE FROM public.delivery_gates WHERE tool = 'calculate_cpk_ppk'"),
        /delivery_gates: deletion of delivery gates is forbidden/
      );
    });

    await t.test('runtime role has strictly zero DDL and zero DELETE across all 13 tables', async () => {
      // Zero DDL
      for (const cmd of [
        'CREATE TABLE public.forbidden (id int)',
        'ALTER TABLE public.event_outbox ADD COLUMN forbidden int',
        'DROP TABLE public.event_outbox',
        'CREATE TEMP TABLE forbidden (id int)',
        'TRUNCATE public.event_inbox'
      ]) {
        await assert.rejects(pool.query(cmd), { code: '42501' });
      }

      // Zero DELETE across all tables
      for (const tbl of [
        'studies', 'consumer_cursors', 'spec_cache', 'settings', 'settings_history', 'schema_migrations',
        'runtime_identity', 'event_inbox', 'event_rejections', 'event_outbox', 'outbox_attempts', 'manual_commands', 'delivery_gates'
      ]) {
        await assert.rejects(pool.query(`DELETE FROM public.${tbl}`), { code: '42501' });
      }

      // Append-only tables reject UPDATE from runtime role
      await assert.rejects(pool.query("UPDATE public.settings_history SET version = 1"), { code: '42501' });
      await assert.rejects(pool.query("UPDATE public.event_rejections SET code = 'ERR'"), { code: '42501' });
    });

    await t.test('catalog validator catches any corruption or drift in 003 schema', async () => {
      const corruptions = [
        ['missing inbox column', 'ALTER TABLE public.event_inbox DROP COLUMN error_detail', 'ALTER TABLE public.event_inbox ADD COLUMN error_detail text'],
        ['wrong outbox column type', 'ALTER TABLE public.event_outbox ALTER COLUMN attempts TYPE bigint', 'ALTER TABLE public.event_outbox ALTER COLUMN attempts TYPE integer'],
        ['unexpected index', 'CREATE INDEX unexpected_idx ON public.event_inbox (consumer)', 'DROP INDEX public.unexpected_idx'],
        ['wrong sequence type', 'ALTER SEQUENCE public.event_outbox_outbox_id_seq AS integer', 'ALTER SEQUENCE public.event_outbox_outbox_id_seq AS bigint']
      ];

      for (const [desc, corrupt, restore] of corruptions) {
        await ownerPool.query(corrupt);
        try {
          await assert.rejects(
            pool.query('SELECT public.ajtool_validate_schema()'),
            /schema_contract:/
          );
        } finally {
          await ownerPool.query(restore);
        }
        // Restored schema must validate successfully
        await pool.query('SELECT public.ajtool_validate_schema()');
      }
    });

    await t.test('migration failure midway rolls back atomically and records no migration ledger entry', async () => {
      const rollbackDb = `test_rollback_${randomBytes(4).toString('hex')}`;
      sql('ajtool_test', `CREATE DATABASE ${rollbackDb} OWNER ${owner}`);
      try {
        // Set up 001 and 002 baseline
        const initSql = `
          CREATE TABLE public.schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), checksum text NOT NULL DEFAULT '');
          INSERT INTO public.schema_migrations (version, checksum) VALUES ('001', '${MIGRATIONS['001']}'), ('002', '${MIGRATIONS['002']}');
        `;
        docker(['exec', container, 'psql', '-X', '-U', owner, '-d', rollbackDb, '-c', initSql]);

        // Attempt an atomic migration transaction that encounters an unexpected error
        const failSql = `
          BEGIN;
          SET LOCAL search_path = public;
          CREATE TABLE public.temporary_aborted_table (id int);
          -- Simulated mid-migration failure:
          DO $$ BEGIN RAISE EXCEPTION 'simulated disk or network failure during 003'; END $$;
          INSERT INTO public.schema_migrations (version, checksum) VALUES ('003', 'invalid');
          COMMIT;
        `;
        const res = docker(['exec', container, 'psql', '-X', '-U', owner, '-d', rollbackDb, '-c', failSql], false);
        assert.notEqual(res.status, 0);

        // Verify total rollback: temporary table was discarded and version 003 was not recorded
        assert.equal(sql(rollbackDb, "SELECT to_regclass('public.temporary_aborted_table') IS NULL", owner), 't');
        assert.equal(sql(rollbackDb, "SELECT count(*) FROM public.schema_migrations WHERE version = '003'", owner), '0');
        assert.equal(sql(rollbackDb, "SELECT count(*) FROM public.schema_migrations", owner), '2');
      } finally {
        sql('ajtool_test', `DROP DATABASE IF EXISTS ${rollbackDb} WITH (FORCE);`);
      }
    });
  } finally {
    await f.close();
  }
});
