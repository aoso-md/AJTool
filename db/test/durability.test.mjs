// Explicit integration suite: node --test db/test/durability.test.mjs
// Uses ONLY a guarded local/CI PostgreSQL 16 test container.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { container, port, assertTestContainer } from './helpers/test-environment.mjs';
import { waitReady } from './helpers/isolated-postgres.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../tools/calculate-cpk-ppk/package.json', import.meta.url));
const { Pool } = require('pg');
const quiet = { info () {}, error () {}, warn () {} };
const errorCode = { code: 'persistence_unavailable' };
delete process.env.OIDC_ISSUER;
process.env.TOOL_API_KEY = 'durability-local-test-key';

function docker (...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}
function sql (database, command) {
  return docker('exec', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'ajtool_migrator', '-d', database, '-Atc', command);
}
test('PostgreSQL 16: migrations, restricted runtime, outages and persistence', async (t) => {
  const inspected = JSON.parse(docker('inspect', container))[0];
  assertTestContainer(inspected);
  const suffix = randomBytes(6).toString('hex');
  const remote = `/tmp/ajtool-durability-${suffix}`;
  docker('cp', `${root}db`, `${container}:${remote}`);

  for (const tool of ['calculate-cpk-ppk', 'run-msa-analysis']) {
    await t.test(tool, async (t) => {
      const tag = tool === 'calculate-cpk-ppk' ? 'cpk' : 'msa';
      const database = `durability_${tag}_${suffix}`;
      const role = `${database}_runtime`;
      const password = randomBytes(20).toString('hex');
      const databaseUrl = `postgresql://${role}:${password}@127.0.0.1:${port}/${database}`;
      const { createStore } = await import(`../../tools/${tool}/src/platform/store.js`);
      let store;
      let pool;
      const now = new Date().toISOString();
      const study = { id: 'confirmed', tool: tag, status: 'completed', inputEventId: 'event-1', createdAt: now, updatedAt: now };
      const spec = { partId: 'part', characteristicId: 'diameter', usl: 11, lsl: 9, sourceSeq: 5 };
      try {
        await t.test('required database with missing URL cannot become memory-only', async () => {
          const missing = await createStore({ databaseRequired: true, log: quiet });
          assert.equal(await missing.ping(), false);
          await assert.rejects(missing.saveStudy(study), errorCode);
          await assert.rejects(missing.setCursor('subscription', 1), errorCode);
          await missing.close();
        });
        sql('ajtool_test', `CREATE ROLE ${role} LOGIN PASSWORD '${password}';`);
        sql('ajtool_test', `CREATE DATABASE ${database};`);
        store = await createStore({ databaseUrl, log: quiet });
        await t.test('unmigrated runtime rejects writes and readiness', async () => {
          assert.equal(await store.ping(), false);
          await assert.rejects(store.saveStudy(study), errorCode);
          assert.equal(sql(database, "SELECT count(*) FROM pg_tables WHERE schemaname='public'").trim(), '0');
        });
        const migrate = () => docker('exec', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'ajtool_migrator', '-d', database, '-f', `${remote}/migrate.sql`);
        await t.test('explicit migration is repeatable and recovers existing runtime', async () => {
          migrate();
          migrate();
          docker('exec', container, 'psql', '-X', '-U', 'ajtool_migrator', '-d', database, '-v', `runtime_role=${role}`, '-f', `${remote}/runtime-role.sql`);
          assert.equal(sql(database, 'SELECT count(*) FROM schema_migrations').trim(), '3');
          assert.equal(await store.ping(), true);
        });
        pool = new Pool({ connectionString: databaseUrl, ssl: false });
        pool.on('error', () => {});
        await t.test('runtime refuses administrative credentials', async () => {
          sql('ajtool_test', `ALTER ROLE ${role} CREATEDB;`);
          const unsafe = await createStore({ databaseUrl, log: quiet });
          try {
            assert.equal(await unsafe.ping(), false);
            await assert.rejects(unsafe.saveStudy(study), errorCode);
          } finally {
            await unsafe.close();
            sql('ajtool_test', `ALTER ROLE ${role} NOCREATEDB;`);
          }
        });
        await t.test('runtime cannot CREATE, ALTER, DROP, TEMP, or edit migration history', async () => {
          for (const statement of ['CREATE TABLE forbidden (id int)', 'ALTER TABLE studies ADD COLUMN forbidden int', 'DROP TABLE studies', 'CREATE TEMP TABLE forbidden (id int)', "INSERT INTO schema_migrations(version) VALUES ('forbidden')"]) {
            await assert.rejects(pool.query(statement), { code: '42501' });
          }
        });
        await t.test('all four write paths commit with runtime privileges', async () => {
          await store.saveStudy(study);
          await store.setCursor('subscription', 12);
          await store.upsertSpec(spec);
          const saved = await store.saveSettings({ key: 'criteria', doc: { limit: 1 }, expectedVersion: 0, actor: { ref: 'engineer' }, reason: 'test' });
          assert.equal(saved.ok, true);
          assert.equal(saved.durable, true);
          assert.equal((await store.listSettingsHistory('criteria')).length, 1);
        });
        await t.test('settings and audit history roll back together on SQL failure', async () => {
          sql(database, `REVOKE INSERT ON settings_history FROM ${role};`);
          try {
            await assert.rejects(store.saveSettings({ key: 'criteria', doc: { limit: 99 }, expectedVersion: 1 }), errorCode);
            assert.equal(sql(database, "SELECT version FROM settings WHERE key='criteria'").trim(), '1');
            assert.equal(sql(database, "SELECT count(*) FROM settings_history WHERE key='criteria'").trim(), '1');
          } finally {
            sql(database, `GRANT INSERT ON settings_history TO ${role};`);
          }
          assert.equal(await store.ping(), true);
        });
        await pool.end();
        pool = null;
        await t.test('real PostgreSQL stop rejects writes and HTTP with no false success', async () => {
          docker('stop', '--time', '3', container);
          // Exercise a write before ping: catches a connection failure mid-operation.
          await assert.rejects(store.saveStudy({ ...study, id: 'lost' }), errorCode);
          assert.equal(await store.ping(), false);
          assert.equal(store.tier().tier, 'unavailable');
          await assert.rejects(store.setCursor('subscription', 99), errorCode);
          await assert.rejects(store.upsertSpec({ ...spec, sourceSeq: 99 }), errorCode);
          await assert.rejects(store.saveSettings({ key: 'criteria', doc: { limit: 99 }, expectedVersion: 1 }), errorCode);
          const cold = await createStore({ databaseUrl, log: quiet });
          try {
            assert.equal(await cold.ping(), false);
            await assert.rejects(cold.saveStudy(study), errorCode);
          } finally {
            await cold.close();
          }
          const { createApp } = await import(`../../tools/${tool}/src/platform/app.js`);
          const app = createApp({ tool: { id: tag }, config: {}, core: {}, store, poller: { status: () => ({}) }, publisher: {}, log: quiet,
            registerRoutes (api) { api.post('/durability-test', async (req, res) => { await store.saveStudy(study); res.sendStatus(201); }); } });
          const server = app.listen(0, '127.0.0.1');
          await new Promise((resolve) => server.once('listening', resolve));
          try {
            const base = `http://127.0.0.1:${server.address().port}`;
            assert.equal((await fetch(`${base}/health`)).status, 200);
            assert.equal((await fetch(`${base}/ready`)).status, 503);
            const response = await fetch(`${base}/api/durability-test`, { method: 'POST', headers: { 'x-api-key': process.env.TOOL_API_KEY } });
            assert.equal(response.status, 503);
            assert.equal((await response.json()).error, 'persistence_unavailable');
          } finally {
            await new Promise((resolve) => server.close(resolve));
          }
        });
        docker('start', container);
        await waitReady();
        await t.test('reconnection preserves confirmed state and excludes rejected state', async () => {
          assert.equal(await store.ping(), true);
          assert.deepEqual(await store.getStudy('confirmed'), study);
          assert.equal(await store.getStudy('lost'), null);
          assert.equal(await store.getCursor('subscription'), 12);
          assert.equal((await store.findSpec('part', 'diameter')).sourceSeq, 5);
          assert.equal((await store.getSettings('criteria')).version, 1);
          assert.equal((await store.listSettingsHistory('criteria')).length, 1);
          await store.saveStudy({ ...study, id: 'after-recovery', inputEventId: 'event-2' });
          await store.setCursor('subscription', 13);
          assert.equal((await store.saveSettings({ key: 'criteria', doc: { limit: 2 }, expectedVersion: 1 })).durable, true);
          await store.close();
          store = await createStore({ databaseUrl, log: quiet });
          assert.equal(await store.ping(), true);
          assert.equal((await store.getStudy('after-recovery')).id, 'after-recovery');
          assert.equal(await store.getCursor('subscription'), 13);
          assert.equal((await store.getSettings('criteria')).version, 2);
          assert.equal((await store.listSettingsHistory('criteria')).length, 2);
        });
      } finally {
        docker('start', container);
        await waitReady();
        if (pool) await pool.end();
        if (store) await store.close();
        // Names are generated above; no pre-existing database or role is removed.
        sql('ajtool_test', `DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
        sql('ajtool_test', `DROP ROLE IF EXISTS ${role};`);
      }
    });
  }
});
