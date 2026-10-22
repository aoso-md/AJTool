import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { assertSpecContract } from '../../tools/calculate-cpk-ppk/test/helpers/spec-contract.js';
import { container, root, quiet, docker, sql, prepare, fixture, eventually, waitReady } from './helpers/isolated-postgres.mjs';
import { MIGRATIONS } from '../../tools/calculate-cpk-ppk/src/platform/postgres-contract.js';

const unavailable = { code: 'persistence_unavailable', kind: 'retryable' };
const initialIndex = 'CREATE UNIQUE INDEX studies_tool_input_event_uidx ON public.studies(tool,input_event_id) WHERE input_event_id IS NOT NULL';
const study = (tool, id, event = id) => ({ id, tool, inputEventId: event, status: 'completed', createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' });

test('immutable migrations and identical validators for both runtime images', () => {
  for (const [version, file] of [['001', '001-initial.sql'], ['002', '002-schema-contract.sql']]) {
    const source = readFileSync(`${root}db/migrations/${file}`, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(source).digest('hex'), MIGRATIONS[version]);
  }
  assert.equal(MIGRATIONS['001'], '5c5f8eed8ade4a6c6438bcf84f47d85d1da96a6cb5748f87638614c706331ccb');
  assert.equal(readFileSync(`${root}tools/calculate-cpk-ppk/src/platform/postgres-contract.js`, 'utf8'), readFileSync(`${root}tools/run-msa-analysis/src/platform/postgres-contract.js`, 'utf8'));
});

test('PostgreSQL hardening: schema, effective privileges, automatic recovery and CPK specs', async (t) => {
  const remote = prepare();
  for (const tool of ['calculate-cpk-ppk', 'run-msa-analysis']) {
    await t.test(tool, async (t) => {
      const f = await fixture(tool, remote, { legacy: true });
      const { db, owner, role, store, pool, ownerPool } = f;
      try {
        await t.test('001 upgrades additively as non-superuser owner and runtime remains DML-only', async () => {
          assert.equal(sql(db, `SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname='${owner}'`), 'f');
          assert.deepEqual((await pool.query('SELECT version,checksum FROM public.schema_migrations ORDER BY version')).rows,
            Object.entries(MIGRATIONS).map(([version, checksum]) => ({ version, checksum })));
          f.runFile('migrate.sql');
          assert.equal(await store.ping(), true);
          for (const command of ['CREATE TABLE forbidden(id int)', 'ALTER TABLE public.studies ADD COLUMN forbidden int',
            'DROP TABLE public.studies', 'CREATE TEMP TABLE forbidden(id int)', 'TRUNCATE public.settings_history',
            "UPDATE public.schema_migrations SET checksum='tampered'", "UPDATE public.settings_history SET after='{}'", 'DELETE FROM public.settings_history']) {
            await assert.rejects(pool.query(command), { code: '42501' });
          }
        });
        await store.saveStudy(study(tool, 'confirmed', 'one-event'));
        await t.test('wrong nonunique index fails migration and runtime before another event can be saved', async () => {
          sql(db, 'DROP INDEX public.studies_tool_input_event_uidx; CREATE INDEX studies_tool_input_event_uidx ON public.studies(id)');
          try {
            assert.equal(await store.ping(), false);
            await assert.rejects(store.saveStudy(study(tool, 'duplicate', 'one-event')), unavailable);
            assert.notEqual(f.runFile('migrate.sql', false).status, 0);
            assert.equal(sql(db, "SELECT count(*) FROM public.studies WHERE input_event_id='one-event'"), '1');
            assert.equal(sql(db, 'SELECT count(*) FROM public.schema_migrations'), '2');
          } finally { sql(db, `DROP INDEX public.studies_tool_input_event_uidx; ${initialIndex}`); }
          await assert.rejects(store.saveStudy(study(tool, 'duplicate', 'one-event')), { code: '23505', kind: 'retryable' });
          assert.equal(store.tier().durable, true); // a logical conflict does not poison recovery
          assert.equal((await store.getStudy('confirmed')).id, 'confirmed');
        });
        const mutations = [
          ['unexpected unique index', 'CREATE UNIQUE INDEX unexpected_unique ON public.studies(status)', 'DROP INDEX public.unexpected_unique'],
          ['inherited table data', 'CREATE TABLE public.studies_child() INHERITS(public.studies)', 'DROP TABLE public.studies_child'],
          ['generated application column', 'ALTER TABLE public.settings DROP COLUMN version; ALTER TABLE public.settings ADD COLUMN version integer GENERATED ALWAYS AS (1) STORED NOT NULL', 'ALTER TABLE public.settings DROP COLUMN version; ALTER TABLE public.settings ADD COLUMN version integer NOT NULL'],
          ['wrong unique predicate', 'DROP INDEX public.studies_tool_input_event_uidx; CREATE UNIQUE INDEX studies_tool_input_event_uidx ON public.studies(tool,input_event_id) WHERE input_event_id IS NULL', `DROP INDEX public.studies_tool_input_event_uidx; ${initialIndex}`],
          ['wrong key columns', 'DROP INDEX public.studies_tool_created_idx; CREATE INDEX studies_tool_created_idx ON public.studies(status)', 'DROP INDEX public.studies_tool_created_idx; CREATE INDEX studies_tool_created_idx ON public.studies(tool,created_at DESC)'],
          ['missing primary key', 'ALTER TABLE public.studies DROP CONSTRAINT studies_pkey', 'ALTER TABLE public.studies ADD CONSTRAINT studies_pkey PRIMARY KEY(id)'],
          ['wrong column type', 'ALTER TABLE public.settings ALTER COLUMN version TYPE bigint', 'ALTER TABLE public.settings ALTER COLUMN version TYPE integer'],
          ['wrong nullability', 'ALTER TABLE public.studies ALTER COLUMN doc DROP NOT NULL', 'ALTER TABLE public.studies ALTER COLUMN doc SET NOT NULL'],
          ['unexpected constraint', 'ALTER TABLE public.settings ADD CONSTRAINT unexpected CHECK(version>99) NOT VALID', 'ALTER TABLE public.settings DROP CONSTRAINT unexpected'],
          ['wrong history sequence', 'ALTER SEQUENCE public.settings_history_id_seq INCREMENT 2', 'ALTER SEQUENCE public.settings_history_id_seq INCREMENT 1'],
          ['missing migration', "DELETE FROM public.schema_migrations WHERE version='002'", `INSERT INTO public.schema_migrations(version,checksum) VALUES('002','${MIGRATIONS['002']}')`],
          ['future migration', "INSERT INTO public.schema_migrations(version,checksum) VALUES('999','unknown')", "DELETE FROM public.schema_migrations WHERE version='999'"],
          ['changed checksum', "UPDATE public.schema_migrations SET checksum='tampered' WHERE version='001'", `UPDATE public.schema_migrations SET checksum='${MIGRATIONS['001']}' WHERE version='001'`]
        ];
        for (const [name, mutate, restore] of mutations) {
          await t.test(`rejects ${name} without RAM fallback or false migration success`, async () => {
            sql(db, mutate);
            try {
              await assert.rejects(store.getStudy('confirmed'), unavailable);
              await assert.rejects(store.setCursor('unsafe', 99), unavailable);
              assert.notEqual(f.runFile('migrate.sql', false).status, 0);
            } finally { sql(db, restore); }
            assert.equal((await store.getStudy('confirmed')).id, 'confirmed'); // no ping
          });
        }
        await t.test('missing INSERT is reflected in readiness and recovers before an operation without ping', async () => {
          sql(db, `REVOKE INSERT ON public.studies FROM ${role}`);
          try {
            assert.equal(await store.ping(), false);
            await assert.rejects(store.saveStudy(study(tool, 'not-saved')), unavailable);
          } finally { sql(db, `GRANT INSERT ON public.studies TO ${role}`); }
          await store.saveStudy(study(tool, 'auto-recovered'));
          assert.equal((await store.getStudy('auto-recovered')).id, 'auto-recovered');
        });
        for (const membership of ['pg_execute_server_program', 'pg_read_server_files', 'pg_write_all_data']) {
          await t.test(`provisioning and runtime reject effective membership ${membership}`, async () => {
            sql('ajtool_test', `GRANT ${membership} TO ${role}`);
            try {
              assert.notEqual(f.runFile('runtime-role.sql', false).status, 0);
              await assert.rejects(store.getStudy('confirmed'), unavailable);
            } finally { sql('ajtool_test', `REVOKE ${membership} FROM ${role}`); }
            assert.equal((await store.getStudy('confirmed')).id, 'confirmed');
          });
        }
        await t.test('NOINHERIT/SET ROLE membership is rejected even with no inherited DML', async () => {
          const parent = `${db}_parent`;
          sql('ajtool_test', `CREATE ROLE ${parent}; GRANT ${parent} TO ${role} WITH INHERIT FALSE`);
          try {
            assert.notEqual(f.runFile('runtime-role.sql', false).status, 0);
            await assert.rejects(store.getStudy('confirmed'), unavailable);
          } finally { sql('ajtool_test', `REVOKE ${parent} FROM ${role}; DROP ROLE ${parent}`); }
        });
        for (const [name, grant, operation] of [
          ['PUBLIC DELETE', 'GRANT DELETE ON public.settings_history TO PUBLIC', 'DELETE FROM public.settings_history'],
          ['PUBLIC column UPDATE', 'GRANT UPDATE(after) ON public.settings_history TO PUBLIC', "UPDATE public.settings_history SET after='{}'"],
          ['direct column UPDATE', `GRANT UPDATE(after) ON public.settings_history TO ${role}`, "UPDATE public.settings_history SET after='{}'"],
          ['sequence UPDATE', `GRANT UPDATE ON SEQUENCE public.settings_history_id_seq TO ${role}`, "SELECT setval('public.settings_history_id_seq',999)"],
          ['DDL CREATE', `GRANT CREATE ON SCHEMA public TO ${role}`, 'CREATE TABLE public.forbidden(id int)']
        ]) {
          await t.test(`detects and removes ${name} without broad grants`, async () => {
            sql(db, grant);
            await assert.rejects(store.getStudy('confirmed'), unavailable);
            f.runFile('runtime-role.sql');
            await assert.rejects(pool.query(operation), { code: '42501' });
            assert.equal((await store.getStudy('confirmed')).id, 'confirmed');
          });
        }
        await t.test('ownership of a type cannot bypass the no-DDL guard', async () => {
          sql(db, `CREATE TYPE public.runtime_owned_enum AS ENUM ('one'); ALTER TYPE public.runtime_owned_enum OWNER TO ${role}`);
          try {
            assert.notEqual(f.runFile('runtime-role.sql', false).status, 0);
            await assert.rejects(store.getStudy('confirmed'), unavailable);
          } finally { sql(db, 'DROP TYPE public.runtime_owned_enum'); }
        });
        await t.test('effective grants outside the application tables are rejected', async () => {
          sql(db, `CREATE SCHEMA private_audit; CREATE TABLE private_audit.extra(id int); GRANT USAGE ON SCHEMA private_audit TO ${role}; GRANT SELECT ON private_audit.extra TO ${role}`, owner);
          try { await assert.rejects(store.getStudy('confirmed'), unavailable); }
          finally { sql(db, 'DROP SCHEMA private_audit CASCADE', owner); }
          assert.equal((await store.getStudy('confirmed')).id, 'confirmed');
        });
        await t.test('transaction rollback really runs after settings upsert if history insert fails', async () => {
          await store.saveSettings({ key: 'rollback', doc: { limit: 1 }, expectedVersion: 0 });
          sql(db, "CREATE FUNCTION public.reject_history() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''test history failure''; END'; CREATE TRIGGER reject_history BEFORE INSERT ON public.settings_history FOR EACH ROW EXECUTE FUNCTION public.reject_history()", owner);
          try {
            await assert.rejects(store.saveSettings({ key: 'rollback', doc: { limit: 99 }, expectedVersion: 1 }), { code: 'P0001' });
            assert.equal((await store.getSettings('rollback')).version, 1);
            assert.equal((await store.listSettingsHistory('rollback')).length, 1);
          } finally { sql(db, 'DROP TRIGGER reject_history ON public.settings_history; DROP FUNCTION public.reject_history()', owner); }
        });
        await t.test('concurrent operation recovery uses one validation flight and bounded clients', async () => {
          const locker = await ownerPool.connect();
          let requests;
          try {
            await locker.query('BEGIN; LOCK TABLE public.schema_migrations IN ACCESS EXCLUSIVE MODE');
            requests = Array.from({ length: 20 }, () => store.getStudy('confirmed'));
            await eventually(async () => assert.equal(sql(db, `SELECT count(*) FROM pg_stat_activity WHERE usename='${role}' AND wait_event_type='Lock'`), '1'), 1500);
          } finally { await locker.query('ROLLBACK'); locker.release(); }
          assert.equal((await Promise.all(requests)).filter((s) => s.id === 'confirmed').length, 20);
          assert.ok(Number(sql(db, `SELECT count(*) FROM pg_stat_activity WHERE usename='${role}'`)) <= 6); // store max 5 + test pool
        });
        if (tool === 'calculate-cpk-ppk') {
          await t.test('same exact/global/two-piece spec contract as RAM', async () => { await assertSpecContract(store); });
        }
        await t.test('real stop/start auto-recovers reads and four writes without ping or ready', async () => {
          // Exercise production backoff rather than fixture's zero-delay option.
          const liveStore = await f.createStore({ databaseUrl: f.url, recoveryBackoffMs: 250, log: quiet });
          try {
            await liveStore.setCursor('recovery', 7);
            await liveStore.upsertSpec({ partId: 'part', characteristicId: 'recovery', lsl: 1, usl: 3, sourceSeq: 1 });
            await liveStore.saveSettings({ key: 'recovery', doc: { limit: 1 }, expectedVersion: 0 });
            docker(['stop', '--time', '3', container]);
            for (const action of [() => liveStore.getStudy('confirmed'), () => liveStore.saveStudy(study(tool, 'rejected-outage')),
              () => liveStore.setCursor('recovery', 99), () => liveStore.upsertSpec({ partId: 'part', characteristicId: 'recovery', lsl: 99, usl: 100 }),
              () => liveStore.saveSettings({ key: 'recovery', doc: { limit: 99 }, expectedVersion: 1 })]) {
              await assert.rejects(action(), unavailable);
            }
            docker(['start', container]); await waitReady();
            await eventually(async () => assert.equal((await liveStore.getStudy('confirmed')).id, 'confirmed'));
            assert.equal(await liveStore.getStudy('rejected-outage'), null);
            assert.equal(await liveStore.getCursor('recovery'), 7);
            assert.equal((await liveStore.findSpec('part', 'recovery')).lsl, 1);
            assert.equal((await liveStore.getSettings('recovery')).version, 1);
            await liveStore.saveStudy(study(tool, 'persist-after-recovery'));
            await liveStore.setCursor('recovery', 8);
            await liveStore.upsertSpec({ partId: 'part', characteristicId: 'recovery', lsl: 2, usl: 4, sourceSeq: 2 });
            assert.equal((await liveStore.saveSettings({ key: 'recovery', doc: { limit: 2 }, expectedVersion: 1 })).durable, true);
            const reopened = await f.createStore({ databaseUrl: f.url, log: quiet });
            try {
              assert.equal((await reopened.getStudy('persist-after-recovery')).id, 'persist-after-recovery');
              assert.equal(await reopened.getCursor('recovery'), 8);
              assert.equal((await reopened.getSettings('recovery')).version, 2);
              assert.equal((await reopened.listSettingsHistory('recovery')).length, 2);
            } finally { await reopened.close(); }
          } finally {
            docker(['start', container]); await waitReady(); await liveStore.close();
          }
        });
      } finally { await f.close(); }
    });
  }
});
