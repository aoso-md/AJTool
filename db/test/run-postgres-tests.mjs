// One local/CI command. Owns only its randomly named, labelled test container.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('PostgreSQL CI requires Node.js 22');
const root = fileURLToPath(new URL('../../', import.meta.url));
const mutations = {
  'incompatible-schema': (f) => 'ALTER TABLE studies RENAME COLUMN doc TO broken_doc',
  'missing-migration': (f) => "DELETE FROM schema_migrations WHERE version='002'",
  'insufficient-permissions': (f) => `REVOKE INSERT ON studies FROM ${f.role}`
};
const negative = process.argv[2]?.replace(/^--negative-fixture=/, '');
if (negative && !Object.hasOwn(mutations, negative)) throw new Error('Unknown negative test fixture');
const name = `ajtool-durability-ci-${randomBytes(8).toString('hex')}`;
const evidence = resolvePath(root, process.env.AJTOOL_TEST_EVIDENCE || 'docs/durability-fix-evidence');
mkdirSync(evidence, { recursive: true });
let created = false;
async function run (command, args, { env = process.env, log, quiet = false } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (s) => {
      output += s;
      if (!quiet) process.stdout.write(s);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      try { if (log) writeFileSync(resolvePath(evidence, log), output); }
      catch (error) { reject(error); return; }
      if (code !== 0) reject(new Error(`${command} ${args[0]} failed (exit ${code})`));
      else resolve(output);
    });
  });
}
try {
  // Fix the allocated host port for this container's lifetime: Docker may
  // assign a different port after stop/start if the binding is left empty.
  const reserve = net.createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  await run('docker', ['run', '--detach', '--name', name, '--label', 'ajtool.durability-test=true',
    '--publish', `127.0.0.1:${port}:5432`, '--env', 'POSTGRES_USER=ajtool_migrator',
    '--env', 'POSTGRES_PASSWORD=ajtool-ci-synthetic-only', '--env', 'POSTGRES_DB=ajtool_test', 'postgres:16']);
  created = true;
  const info = JSON.parse(await run('docker', ['inspect', name], { quiet: true }))[0];
  process.env.AJTOOL_TEST_CONTAINER = name;
  process.env.AJTOOL_TEST_PORT = info.NetworkSettings.Ports['5432/tcp'][0].HostPort;
  process.env.AJTOOL_PROBES_OUTPUT = resolvePath(evidence, 'closure-probes.json');
  delete process.env.DATABASE_URL;
  const { waitReady, prepare, fixture, sql } = await import('./helpers/isolated-postgres.mjs');
  await waitReady();
  const remote = prepare();
  // Migrate from scratch and validate a restricted runtime before running suites.
  const f = await fixture('calculate-cpk-ppk', remote);
  try {
    if (negative) sql(f.db, mutations[negative](f));
    await run(process.execPath, ['db/test/check-database.mjs'], {
      env: { ...process.env, DATABASE_URL: f.url }, log: 'closure-initialization.txt'
    });
  } finally { await f.close(); }
  for (const [file, log] of [
    ['db/test/durability.test.mjs', 'closure-postgres-original.txt'],
    ['db/test/durability-hardening.test.mjs', 'closure-postgres-hardening.txt'],
    ['db/test/startup.test.mjs', 'closure-startup.txt']
  ]) await run(process.execPath, ['--test', file], { log });
  await run(process.execPath, ['db/review/durability-probes.mjs'], { log: 'closure-probes.txt' });
  await run(process.execPath, ['--test', 'db/test/ci-failure-proof.test.mjs'], { log: 'closure-failure-proof.txt' });
  console.log('POSTGRESQL_CI_GATE_PASSED');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (created) await run('docker', ['rm', '--force', '--volumes', name]);
}
