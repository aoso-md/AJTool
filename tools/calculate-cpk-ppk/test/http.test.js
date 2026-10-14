// test/http.test.js — the HTTP surface against the platform checklist
// (plantillas/integracion/sso/README.md §7 and docker/README.md §5).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// auth/index.js reads TOOL_API_KEY at import time, so it must be set first —
// hence dynamic imports below instead of static ones.
process.env.TOOL_API_KEY = 'tool-test-key';
delete process.env.OIDC_ISSUER;

const { createApp } = await import('../src/platform/app.js');
const { createStore } = await import('../src/platform/store.js');
const { createCoreClient } = await import('../src/platform/core-client.js');
const { createPoller, createPublisher } = await import('../src/platform/poller.js');
const toolModule = await import('../src/tool.js');
const { TOOL } = toolModule;
const factory = toolModule.createCapabilityTool || toolModule.createMsaTool;

const quiet = { info () {}, warn () {}, error () {} };
const KEY = 'tool-test-key';
const CORE_SECRET = 'core-secret-that-must-never-leak';

let server;
let base;

before(async () => {
  const ui = mkdtempSync(path.join(tmpdir(), 'ui-'));
  writeFileSync(path.join(ui, 'index.html'), '<!doctype html><div id="root"></div>');
  mkdirSync(path.join(ui, 'assets'));
  writeFileSync(path.join(ui, 'assets', 'app.js'), 'console.log(1)');

  const store = await createStore({ log: quiet });
  const core = createCoreClient({ baseUrl: 'http://127.0.0.1:9/api/v1', apiKey: CORE_SECRET });
  const publisher = createPublisher({ core, mode: 'shadow', log: quiet });
  const domain = factory({ store, core, publisher, log: quiet });
  const poller = createPoller({ toolId: TOOL.id, consumes: TOOL.consumes, core, store, processEvent: domain.processEvent, log: quiet });
  const app = createApp({ tool: TOOL, config: { uiDistDir: ui }, core, store, poller, publisher, registerRoutes: domain.registerRoutes, log: quiet });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' });

test('/health answers 200 with no credentials (dashboard probe and container healthcheck)', async () => {
  const res = await get('/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.tool, TOOL.id);
});

test('/ready answers with no credentials and reports honest state', async () => {
  const res = await get('/ready');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.persistence.durable, false);
  assert.equal(body.publish, 'shadow');
});

test('/api without credentials is a 401 JSON — never a 302 to the IdP', async () => {
  const res = await get('/api/status');
  assert.equal(res.status, 401);
  assert.match(res.headers.get('content-type'), /json/);
  assert.equal((await res.json()).error, 'authentication_required');
});

test('/api with the machine-plane key works, and never echoes the core key', async () => {
  const res = await get('/api/status', { 'x-api-key': KEY });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(CORE_SECRET), 'ISOTOOLS_API_KEY must never appear in a response');
  const body = JSON.parse(text);
  assert.equal(body.tool.id, TOOL.id);
  assert.deepEqual(body.tool.consumes, TOOL.consumes);
  assert.equal(body.core.configured, true);
});

test('/auth/me in open mode says so (drives the "SSO desactivado" banner)', async () => {
  const res = await get('/auth/me');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.authenticated, false);
  assert.equal(body.mode, 'open');
});

test('unknown /api route is JSON 404, not the SPA shell', async () => {
  const res = await get('/api/does-not-exist', { 'x-api-key': KEY });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /json/);
});

test('malformed JSON is a 400, not a crash', async () => {
  const res = await fetch(base + '/api/studies', { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(res.status, 400);
});

test('the SPA is served from the same origin, deep links included', async () => {
  for (const p of ['/', '/estudios/abc']) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.match(await res.text(), /id="root"/);
  }
  const asset = await get('/assets/app.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control'), /immutable/);
});
