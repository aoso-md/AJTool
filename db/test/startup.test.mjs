import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepare, fixture, sql, root, docker, container, waitReady, eventually } from './helpers/isolated-postgres.mjs';
import { runStartup } from './helpers/startup-process.mjs';
import { MIGRATIONS } from '../../tools/calculate-cpk-ppk/src/platform/postgres-contract.js';

test('Startup error implementations remain identical', () => {
  assert.equal(readFileSync(`${root}tools/calculate-cpk-ppk/src/platform/startup-error.js`, 'utf8'),
    readFileSync(`${root}tools/run-msa-analysis/src/platform/startup-error.js`, 'utf8'));
});

test('Real startup and CI gate fail closed before HTTP/poller initialization', async (t) => {
  const remote = prepare();
  for (const tool of ['calculate-cpk-ppk', 'run-msa-analysis']) {
    await t.test(tool, async (t) => {
      const f = await fixture(tool, remote);
      const mutation = (name, before, after, reason) => ({ name, before, after, reason });
      const cases = [
        { name: 'required URL missing', url: '', reason: 'database_url_missing' },
        { name: 'unreachable PostgreSQL', url: f.url.replace(/:\d+\//, ':1/'), reason: 'database_unavailable' },
        { name: 'invalid credentials', url: f.url.replace(/:[^:@]+@/, ':invalid-synthetic-password@'), reason: 'database_authentication_failed' },
        { name: 'wrong database', url: f.url.replace(/\/[^/]+$/, '/ajtool_missing_database'), reason: 'database_not_found' },
        mutation('missing migration', "DELETE FROM schema_migrations WHERE version='002'",
          `INSERT INTO schema_migrations(version,checksum) VALUES ('002','${MIGRATIONS['002']}')`, 'database_migration_invalid'),
        mutation('corrupted schema', 'ALTER TABLE studies RENAME COLUMN doc TO broken_doc',
          'ALTER TABLE studies RENAME COLUMN broken_doc TO doc', 'database_schema_incompatible'),
        mutation('invalid checksum', "UPDATE schema_migrations SET checksum='invalid' WHERE version='002'",
          `UPDATE schema_migrations SET checksum='${MIGRATIONS['002']}' WHERE version='002'`, 'database_migration_invalid'),
        mutation('unsupported version', `INSERT INTO schema_migrations(version,checksum) VALUES ('999','invalid')`,
          "DELETE FROM schema_migrations WHERE version='999'", 'database_migration_invalid'),
        mutation('insufficient privileges', `REVOKE INSERT ON studies FROM ${f.role}`,
          `GRANT INSERT ON studies TO ${f.role}`, 'database_privileges_invalid'),
        mutation('unsafe runtime role', `ALTER ROLE ${f.role} CREATEDB`,
          `ALTER ROLE ${f.role} NOCREATEDB`, 'database_role_unsafe')
      ];
      try {
        await t.test('healthy migrated service starts and CI gate exits zero', async () => {
          assert.equal((await runStartup(tool, f.url, { healthy: true })).listening, true);
          assert.equal((await runStartup(tool, f.url, { gate: true })).code, 0);
        });
        await t.test('a transient outage does not exit a healthy server; requests recover without ready', async () => {
          await runStartup(tool, f.url, { healthy: true, exercise: async ({ child, base }) => {
            const headers = { 'x-api-key': 'startup-local-test-only' };
            try {
              docker(['stop', '-t', '1', container]);
              assert.equal((await fetch(`${base}/api/studies`, { headers })).status, 503);
              assert.equal(child.exitCode, null);
            } finally { docker(['start', container]); await waitReady(); }
            await eventually(async () => assert.equal((await fetch(`${base}/api/studies`, { headers })).status, 200));
            assert.equal(child.exitCode, null);
            const now = new Date().toISOString();
            await f.store.saveStudy({ id: 'recovered', tool: tool === 'calculate-cpk-ppk' ? 'calculate_cpk_ppk' : 'run_msa_analysis',
              status: 'completed', createdAt: now, updatedAt: now });
            assert.equal((await f.store.getStudy('recovered')).id, 'recovered');
            sql(f.db, "DELETE FROM studies WHERE id='recovered'", f.owner);
          } });
        });
        for (const c of cases) await t.test(c.name, async () => {
          try {
            if (c.before) sql(f.db, c.before);
            for (const gate of [false, true]) {
              const r = await runStartup(tool, c.url ?? f.url, { gate });
              assert.equal(r.code, 1, r.stderr);
              assert.equal(r.listening, false);
              assert.match(r.stderr, new RegExp(`STARTUP_CONFIGURATION_FAILURE \\[${c.reason}\\]`));
              assert.doesNotMatch(r.stdout, /listening|http:\/\//i);
              assert.ok(!r.stderr.includes(new URL(f.url).password));
            }
            assert.equal(sql(f.db, 'SELECT count(*) FROM studies'), '0');
            assert.equal(sql(f.db, 'SELECT count(*) FROM consumer_cursors'), '0');
          } finally { if (c.after) sql(f.db, c.after); }
          assert.equal((await runStartup(tool, f.url, { gate: true })).code, 0, 'temporary state restored');
        });
      } finally { await f.close(); }
    });
  }
});
