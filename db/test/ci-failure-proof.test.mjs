import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { root } from './helpers/isolated-postgres.mjs';

for (const [fixture, reason] of [
  ['incompatible-schema', 'database_schema_incompatible'],
  ['missing-migration', 'database_migration_invalid'],
  ['insufficient-permissions', 'database_privileges_invalid']
]) test(`entire CI command exits nonzero and cleans up: ${fixture}`, { timeout: 60_000 }, async () => {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['db/test/run-postgres-tests.mjs', `--negative-fixture=${fixture}`], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AJTOOL_TEST_EVIDENCE: resolve(process.env.AJTOOL_TEST_EVIDENCE || `${root}docs/durability-fix-evidence`, `negative-${fixture}`) }
    });
    let output = '';
    child.stdout.on('data', (s) => { output += s; });
    child.stderr.on('data', (s) => { output += s; });
    child.once('error', reject);
    child.once('exit', (code) => resolveResult({ code, output }));
  });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, new RegExp(`STARTUP_CONFIGURATION_FAILURE \\[${reason}\\]`));
  assert.doesNotMatch(result.output, /POSTGRESQL_CI_GATE_PASSED/);
  // The final line is emitted only by successful removal in the runner's finally.
  assert.match(result.output.trim().split(/\r?\n/).at(-1), /^ajtool-durability-ci-[a-f0-9]+$/);
});
