import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
import { container, port, assertTestContainer } from './test-environment.mjs';
export { container };
export const quiet = { info () {}, error () {}, warn () {} };
export const { Pool } = createRequire(new URL('../../../tools/calculate-cpk-ppk/package.json', import.meta.url))('pg');
export function docker (args, check = true) {
  const r = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (check) assert.equal(r.status, 0, r.stderr || r.error?.message);
  return r;
}
export const sql = (db, command, user = 'ajtool_migrator') => docker(['exec', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db, '-Atc', command]).stdout.trim();
export function prepare () {
  const info = JSON.parse(docker(['inspect', container]).stdout)[0];
  assertTestContainer(info);
  const remote = `/tmp/ajtool-hardening-${randomBytes(6).toString('hex')}`;
  docker(['cp', `${root}db`, `${container}:${remote}`]);
  return remote;
}
export async function fixture (tool, remote, { legacy = false } = {}) {
  const db = `hardening_${randomBytes(8).toString('hex')}`;
  const owner = `${db}_owner`;
  const role = `${db}_runtime`;
  const password = randomBytes(20).toString('hex');
  sql('ajtool_test', `CREATE ROLE ${owner} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  sql('ajtool_test', `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  sql('ajtool_test', `CREATE DATABASE ${db} OWNER ${owner}`);
  const url = `postgresql://${role}:${password}@127.0.0.1:${port}/${db}`;
  const ownerUrl = `postgresql://${owner}:${password}@127.0.0.1:${port}/${db}`;
  const runFile = (file, check = true) => docker(['exec', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-v', `runtime_role=${role}`, '-U', owner, '-d', db, '-f', `${remote}/${file}`], check);
  const { createStore } = await import(`../../../tools/${tool}/src/platform/store.js`);
  let store;
  let pool;
  let ownerPool;
  const f = {
    db, owner, role, url, ownerUrl, runFile, createStore,
    async close () {
      if (store) await store.close();
      if (pool) await pool.end();
      if (ownerPool) await ownerPool.end();
      sql('ajtool_test', `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      sql('ajtool_test', `DROP ROLE IF EXISTS ${role}`);
      sql('ajtool_test', `DROP ROLE IF EXISTS ${owner}`);
    }
  };
  try {
    if (legacy) {
      runFile('migrations/001-initial.sql');
      sql(db, "CREATE TABLE public.schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now()); INSERT INTO public.schema_migrations(version) VALUES ('001')", owner);
    }
    runFile('migrate.sql');
    runFile('runtime-role.sql');
    store = await createStore({ databaseUrl: url, recoveryBackoffMs: 0, log: quiet });
    pool = new Pool({ connectionString: url, ssl: false });
    ownerPool = new Pool({ connectionString: ownerUrl, ssl: false });
    pool.on('error', () => {}); ownerPool.on('error', () => {});
    return Object.assign(f, { store, pool, ownerPool });
  } catch (error) { await f.close(); throw error; }
}
export async function eventually (fn, timeout = 10_000) {
  const end = Date.now() + timeout;
  let last;
  do {
    try { return await fn(); } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 75));
  } while (Date.now() < end);
  throw last;
}
export async function waitReady () {
  await eventually(async () => assert.equal(docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'ajtool_migrator', '-d', 'ajtool_test'], false).status, 0));
}
