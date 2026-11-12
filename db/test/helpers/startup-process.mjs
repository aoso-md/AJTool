import { spawn } from 'node:child_process';
import net from 'node:net';
import { root } from './isolated-postgres.mjs';

export async function runStartup (tool, databaseUrl, { gate = false, healthy = false, exercise, environment = {} } = {}) {
  const reserve = net.createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const child = spawn(process.execPath, [gate ? 'db/test/check-database.mjs' : `tools/${tool}/src/server.js`], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl, DATABASE_REQUIRED: 'true',
      ISOTOOLS_API_URL: '', ISOTOOLS_API_KEY: '', POLL_ENABLED: 'false', CORE_PUBLISH: 'shadow',
      OIDC_ISSUER: '', TOOL_API_KEY: 'startup-local-test-only', UI_DIST_DIR: '', ...environment }
  });
  let stdout = ''; let stderr = ''; let listening = false;
  child.stdout.on('data', (s) => { stdout += s; });
  child.stderr.on('data', (s) => { stderr += s; });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const end = Date.now() + 15_000;
  try {
    while (child.exitCode == null && Date.now() < end) {
      if (!gate) {
        let response;
        try {
          response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(150) });
        } catch {}
        if (response) listening = true;
        if (healthy && response?.ok) {
          if (exercise) await exercise({ child, base: `http://127.0.0.1:${port}` });
          child.kill(); await exited;
          return { code: 0, stdout, stderr, listening };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (child.exitCode == null) throw new Error('Startup child exceeded 15 seconds');
    const code = await exited;
    // A closed port after exit alone cannot prove absence of initialization.
    // Also reject the server's startup banner in the assertions.
    return { code, stdout, stderr, listening };
  } finally {
    if (child.exitCode == null) { child.kill(); await exited; }
  }
}
