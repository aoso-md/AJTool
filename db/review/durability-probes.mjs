// Post-fix versions of the original nine audit probes per tool.
// Historical observations remain in docs/durability-review-evidence/probes.json.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { MIGRATIONS } from '../../tools/calculate-cpk-ppk/src/platform/postgres-contract.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
import { container, port, assertTestContainer } from '../test/helpers/test-environment.mjs';
import { runStartup } from '../test/helpers/startup-process.mjs';
const { Pool } = createRequire(new URL('../../tools/calculate-cpk-ppk/package.json', import.meta.url))('pg');
const results = [];
const quiet = { info () {}, warn () {}, error () {} };
const suffix = randomBytes(6).toString('hex');
const remote = `/tmp/ajtool-review-${suffix}`;
const unavailable = { code: 'persistence_unavailable' };
function run (args, check = true) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (check) assert.equal(r.status, 0, r.stderr || r.error?.message);
  return r;
}
const sql = (db, command) => run(['exec', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'ajtool_migrator', '-d', db, '-Atc', command]).stdout.trim();
const script = (db, file, role, check = true) => run(['exec', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'ajtool_migrator', '-d', db,
  ...(role ? ['-v', `runtime_role=${role}`] : []), '-f', `${remote}/${file}`], check);
function record (tool, probe, evidence) {
  results.push({ tool, probe, evidence });
  console.log(`${tool}: ${probe}: ${JSON.stringify(evidence)}`);
}
const inspected = JSON.parse(run(['inspect', container]).stdout)[0];
assertTestContainer(inspected);
run(['cp', `${root}db`, `${container}:${remote}`]);

try {
  for (const tool of ['calculate-cpk-ppk', 'run-msa-analysis']) {
    const tag = tool === 'calculate-cpk-ppk' ? 'cpk' : 'msa';
    const db = `review_${tag}_${suffix}`;
    const role = `${db}_runtime`;
    const password = randomBytes(20).toString('hex');
    const databaseUrl = `postgresql://${role}:${password}@127.0.0.1:${port}/${db}`;
    const { createStore } = await import(`../../tools/${tool}/src/platform/store.js`);
    let store;
    let pool;
    try {
      sql('ajtool_test', `CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      sql('ajtool_test', `CREATE DATABASE ${db}`);
      // Unlike the original unmigrated test, remove PUBLIC TEMP before testing
      // absent tables, so the failure cannot be masked by the privilege check.
      sql(db, `REVOKE CREATE, TEMP ON DATABASE ${db} FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${role}`);
      const logs = [];
      store = await createStore({ databaseUrl, recoveryBackoffMs: 0, log: { ...quiet, error: (s) => logs.push(s) } });
      assert.equal(await store.ping(), false);
      assert.ok(logs.length > 0);
      await assert.rejects(store.getStudy('missing'), unavailable);
      await assert.rejects(store.saveStudy({}), unavailable);
      const failed = await runStartup(tool, databaseUrl);
      assert.equal(failed.code, 1);
      assert.match(failed.stderr, /STARTUP_CONFIGURATION_FAILURE/);
      assert.equal(failed.listening, false);
      record(tool, 'absent-schema-real-process-and-domain-routes', { startupExit: failed.code, listening: false, publicTables: sql(db, "SELECT count(*) FROM pg_tables WHERE schemaname='public'") });
      await store.close();
      // Force failure while adopting an existing table with duplicate events.
      const studiesDdl = readFileSync(`${root}db/migrations/001-initial.sql`, 'utf8').split(';')[0];
      sql(db, studiesDdl);
      sql(db, `INSERT INTO studies(id,tool,status,input_event_id,created_at,updated_at,doc) VALUES
        ('migration-A','migration','completed','duplicate',now(),now(),'{}'),
        ('migration-B','migration','completed','duplicate',now(),now(),'{}')`);
      const failedMigration = script(db, 'migrate.sql', null, false);
      assert.notEqual(failedMigration.status, 0);
      assert.equal(sql(db, "SELECT to_regclass('public.schema_migrations') IS NULL"), 't');
      assert.equal(sql(db, 'SELECT count(*) FROM studies'), '2');
      assert.equal(sql(db, "SELECT to_regclass('public.consumer_cursors') IS NULL"), 't');
      sql(db, "DELETE FROM studies WHERE id='migration-B'");
      script(db, 'migrate.sql');
      assert.equal(sql(db, "SELECT count(*) FROM studies WHERE id='migration-A'"), '1');
      record(tool, 'migration-rollback-and-legacy-data-preservation', { failedOnDuplicates: true, noVersionOnFailure: true, rowsPreservedOnFailure: 2, legacyRowPreservedOnSuccess: true });
      script(db, 'runtime-role.sql', role);
      store = await createStore({ databaseUrl, recoveryBackoffMs: 0, log: quiet });
      pool = new Pool({ connectionString: databaseUrl, ssl: false });
      pool.on('error', () => {});
      assert.equal(await store.ping(), true);
      const now = new Date().toISOString();
      const study = { id: 'seed', tool: tag, status: 'completed', inputEventId: 'seed-event', createdAt: now, updatedAt: now };
      await store.saveStudy(study);
      await store.setCursor('audit', 4);
      await store.upsertSpec({ partId: 'part', characteristicId: 'seed', lsl: 1, usl: 3, sourceSeq: 1 });
      await store.saveSettings({ key: 'audit', doc: { limit: 1 }, expectedVersion: 0 });

      // A permission error is enough to latch unavailable, even with PG up.
      sql(db, `REVOKE INSERT ON studies FROM ${role}`);
      assert.equal(await store.ping(), false);
      record(tool, 'ready-checks-write-permissions', { insertRevoked: true, runtimeReady: false });
      await assert.rejects(store.saveStudy({ ...study, id: 'rejected' }), unavailable);
      const blocked = [
        () => store.getStudy('seed'), () => store.findStudyByInputEvent(tag, 'seed-event'), () => store.listStudies(tag),
        () => store.getCursor('audit'), () => store.listSpecs(), () => store.findSpec('part', 'seed'),
        () => store.getSettings('audit'), () => store.listSettingsHistory('audit'),
        () => store.saveStudy({ ...study, id: 'rejected' }), () => store.setCursor('audit', 99),
        () => store.upsertSpec({ partId: 'part', characteristicId: 'seed', lsl: 99, usl: 100 }),
        () => store.saveSettings({ key: 'audit', doc: { limit: 99 }, expectedVersion: 1 })
      ];
      for (const action of blocked) await assert.rejects(action(), unavailable);
      assert.equal(sql(db, "SELECT count(*) FROM studies WHERE id='rejected'"), '0');
      sql(db, `GRANT INSERT ON studies TO ${role}`);
      assert.equal(await store.getCursor('audit'), 4);
      record(tool, 'no-RAM-fallback-and-automatic-recovery', { blockedReads: 8, blockedWrites: 4, recoveredWithoutPing: true });

      // Neither provisioning nor runtime accepts powerful memberships.
      sql('ajtool_test', `GRANT pg_execute_server_program TO ${role}`);
      assert.notEqual(script(db, 'runtime-role.sql', role, false).status, 0);
      assert.equal(await store.ping(), false);
      assert.equal((await pool.query("SELECT pg_has_role(current_user, 'pg_execute_server_program', 'USAGE') AS allowed")).rows[0].allowed, true);
      record(tool, 'predefined-admin-membership-rejected', { runtimeReady: false, effectiveServerProgramPrivilege: true, programExecuted: false });
      sql('ajtool_test', `REVOKE pg_execute_server_program FROM ${role}`);

      sql(db, 'GRANT DELETE ON settings_history TO PUBLIC');
      script(db, 'runtime-role.sql', role);
      assert.equal(await store.ping(), true);
      await assert.rejects(pool.query("DELETE FROM settings_history WHERE key='audit'"), { code: '42501' });
      record(tool, 'PUBLIC-history-delete-removed', { runtimeReady: true, deletedAuditRows: 0 });
      sql(db, 'REVOKE DELETE ON settings_history FROM PUBLIC');

      // The original corrupt-index reproduction must now fail closed.
      sql(db, "DELETE FROM schema_migrations; DROP INDEX studies_tool_input_event_uidx; CREATE INDEX studies_tool_input_event_uidx ON studies(id)");
      assert.notEqual(script(db, 'migrate.sql', null, false).status, 0);
      assert.equal(await store.ping(), false);
      await assert.rejects(store.saveStudy({ ...study, id: 'duplicate-input' }), unavailable);
      assert.equal(sql(db, "SELECT count(*) FROM studies WHERE input_event_id='seed-event'"), '1');
      sql(db, `DROP INDEX studies_tool_input_event_uidx;
        CREATE UNIQUE INDEX studies_tool_input_event_uidx ON studies(tool,input_event_id) WHERE input_event_id IS NOT NULL;
        INSERT INTO schema_migrations(version,checksum) VALUES ('001','${MIGRATIONS['001']}'),('002','${MIGRATIONS['002']}'),('003','${MIGRATIONS['003']}')`);
      sql(db, "DELETE FROM schema_migrations WHERE version='002'");
      assert.equal(await store.ping(), false);
      sql(db, `INSERT INTO schema_migrations(version,checksum) VALUES ('002','${MIGRATIONS['002']}')`);
      record(tool, 'wrong-index-and-missing-ledger-rejected', { duplicateInputStudies: 1, migrationVersionRequiredByReady: true, wrongIndexRejected: true });

      // Compare the same public store contract in memory and PostgreSQL.
      const memory = await createStore({ log: quiet });
      const partSpec = { partId: 'P2', characteristicId: 'C', lsl: 8, usl: 12, sourceSeq: 10 };
      const globalSpec = { partId: '', characteristicId: 'C', lsl: 1, usl: 5, sourceSeq: 1 };
      await store.upsertSpec(partSpec); await memory.upsertSpec(partSpec);
      const postgresUnspecified = await store.findSpec(null, 'C');
      const memoryUnspecified = await memory.findSpec(null, 'C');
      await store.upsertSpec(globalSpec); await memory.upsertSpec(globalSpec);
      const postgresOther = await store.findSpec('P1', 'C');
      const memoryOther = await memory.findSpec('P1', 'C');
      if (tag === 'cpk') {
        assert.equal(memoryUnspecified, null);
        assert.equal(memoryOther.lsl, 1);
        assert.equal(postgresUnspecified, null);
        assert.equal(postgresOther.lsl, 1);
      } else {
        assert.equal(memoryUnspecified?.partId, 'P2');
        assert.equal(postgresUnspecified?.partId, 'P2');
        assert.equal(memoryOther.lsl, 8);
        assert.equal(postgresOther?.partId, 'P2');
      }
      record(tool, tag === 'cpk' ? 'memory-postgres-spec-contract-equivalent' : 'MSA-existing-any-part-spec-fallback', { unspecifiedPart: { memory: memoryUnspecified?.partId ?? null, postgres: postgresUnspecified?.partId ?? null }, otherPartWithGlobalSpec: { memoryLsl: memoryOther.lsl, postgresLsl: postgresOther?.lsl ?? null } });
      await memory.close();

      const peer = await createStore({ databaseUrl, recoveryBackoffMs: 0, log: quiet });
      try {
        const attempts = await Promise.all([store.saveSettings({ key: 'concurrent', doc: { actor: 'A' }, expectedVersion: 0 }), peer.saveSettings({ key: 'concurrent', doc: { actor: 'B' }, expectedVersion: 0 })]);
        assert.equal(attempts.filter((r) => r.ok).length, 1);
        assert.equal(attempts.filter((r) => r.conflict).length, 1);
        assert.equal((await store.listSettingsHistory('concurrent')).length, 1);
        record(tool, 'concurrent-settings-initialization', { committed: 1, conflict: 1, historyRows: 1 });
      } finally { await peer.close(); }
    } finally {
      if (pool) await pool.end();
      if (store) await store.close();
      sql('ajtool_test', `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      sql('ajtool_test', `DROP ROLE IF EXISTS ${role}`);
    }
  }
} finally {
  writeFileSync(process.env.AJTOOL_PROBES_OUTPUT || `${root}docs/durability-fix-evidence/probes-after.json`, JSON.stringify({ container, image: process.env.AJTOOL_TEST_POSTGRES_IMAGE || 'postgres:16', at: new Date().toISOString(), results }, null, 2) + '\n');
}
