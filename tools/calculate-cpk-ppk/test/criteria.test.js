// test/criteria.test.js — editable acceptance criteria: validation, precedence,
// the confirmation gate, concurrency, history, and that history is never re-judged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.TOOL_API_KEY = 'tool-test-key';
delete process.env.OIDC_ISSUER;

const { createApp } = await import('../src/platform/app.js');
const { createStore } = await import('../src/platform/store.js');
const { createCoreClient } = await import('../src/platform/core-client.js');
const { createPoller, createPublisher } = await import('../src/platform/poller.js');
const { TOOL, createCapabilityTool } = await import('../src/tool.js');
const { DEFAULTS, validateCriteria, minimumCpkFor, describeChanges, impactOn } = await import('../src/domain/criteria.js');
const { classify } = await import('../src/domain/capability.js');
const { priorityOf, summarize } = await import('../src/domain/priority.js');

const quiet = { info () {}, warn () {}, error () {} };
const H = { 'x-api-key': 'tool-test-key', 'content-type': 'application/json' };

let server; let base; let store;
before(async () => {
  store = await createStore({ log: quiet });
  const core = createCoreClient({ baseUrl: 'http://127.0.0.1:9/api/v1', apiKey: 'k' });
  const publisher = createPublisher({ core, mode: 'shadow', log: quiet });
  const domain = createCapabilityTool({ store, core, publisher, log: quiet });
  const poller = createPoller({ toolId: TOOL.id, consumes: TOOL.consumes, core, store, processEvent: domain.processEvent, log: quiet });
  const app = createApp({ tool: TOOL, config: {}, core, store, poller, publisher, registerRoutes: domain.registerRoutes, log: quiet });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const call = (method, path, body) => fetch(base + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });

// ── Pure rules ──────────────────────────────────────────────────────────────
test('defaults are the usual reference values and validate cleanly', () => {
  const r = validateCriteria(DEFAULTS);
  assert.equal(r.ok, true);
  assert.equal(r.value.minimumCpk, 1.33);
  assert.equal(r.value.marginalFloor, 1.0);
});

test('validation reports every problem, not just the first', () => {
  const r = validateCriteria({ minimumCpk: 'abc', marginalFloor: 5, recommendedSampleSize: 2.5, overrides: { X: 99 } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 3, r.errors.join(' | '));
});

test('the marginal floor must sit below the minimum', () => {
  assert.equal(validateCriteria({ minimumCpk: 1.2, marginalFloor: 1.2 }).ok, false);
  assert.equal(validateCriteria({ minimumCpk: 1.5, marginalFloor: 1.2 }).ok, true);
});

test('precedence: explicit value > characteristic override > default', () => {
  const c = validateCriteria({ ...DEFAULTS, overrides: { 'DIAM-01': 1.67 } }).value;
  assert.deepEqual(minimumCpkFor(c, 'DIAM-01', 1.1), { value: 1.1, source: 'event' });
  assert.deepEqual(minimumCpkFor(c, 'DIAM-01', undefined), { value: 1.67, source: 'characteristic' });
  assert.deepEqual(minimumCpkFor(c, 'OTHER', undefined), { value: 1.33, source: 'default' });
});

test('describeChanges lists fields and per-characteristic exceptions', () => {
  const a = validateCriteria(DEFAULTS).value;
  const b = validateCriteria({ ...DEFAULTS, minimumCpk: 1.5, overrides: { 'DIAM-01': 1.67 } }).value;
  const fields = describeChanges(a, b).map((c) => c.field);
  assert.deepEqual(fields, ['minimumCpk', 'overrides.DIAM-01']);
  assert.deepEqual(describeChanges(a, a), []);
});

test('impact: a stricter minimum would reclassify studies on file, none are touched', () => {
  const study = (id, cpk) => ({ id, status: 'completed', characteristicId: 'C', result: { cpk }, input: {} });
  const before = validateCriteria(DEFAULTS).value;
  const after = validateCriteria({ ...DEFAULTS, minimumCpk: 1.67 }).value;
  const impact = impactOn([study('a', 1.5), study('b', 2.0), study('c', 0.8)], before, after, classify);
  assert.equal(impact.evaluated, 3);
  assert.equal(impact.changed, 1); // only the 1.5 goes capable -> marginal
  assert.equal(impact.newlyBelowTarget, 1);
});

// ── Priority ────────────────────────────────────────────────────────────────
test('priority ranks a non-capable process above a marginal one above a capable one', () => {
  const mk = (status, cpk, publish = 'not_required') => ({ status: 'completed', result: { status, cpk, minimumCpk: 1.33 }, publish: { state: publish }, createdAt: '2026-10-01T00:00:00Z' });
  const bad = priorityOf(mk('not_capable', 0.6, 'awaiting_decision'));
  const mid = priorityOf(mk('marginal', 1.1));
  const ok = priorityOf(mk('capable', 1.8));
  assert.equal(bad.level, 'critical');
  assert.equal(mid.level, 'high');
  assert.equal(ok.level, 'low');
  assert.ok(bad.score > mid.score && mid.score > ok.score);
  assert.match(bad.reason, /decidir/);
});

test('priority: stuck publishes and skipped studies are surfaced, not buried', () => {
  assert.equal(priorityOf({ status: 'completed', result: { status: 'capable', cpk: 2 }, publish: { state: 'retrying' } }).level, 'high');
  assert.equal(priorityOf({ status: 'skipped', publish: {} }).level, 'medium');
  const s = summarize([{ id: '1', status: 'skipped', publish: {}, createdAt: 'x' }, { id: '2', status: 'completed', result: { status: 'capable', cpk: 2 }, publish: {}, createdAt: 'y' }]);
  assert.equal(s.total, 2);
  assert.equal(s.byLevel.medium, 1);
  assert.equal(s.attention.length, 1);
});

// ── HTTP: the confirmation gate ─────────────────────────────────────────────
test('GET /api/settings exposes defaults, bounds, version and who may edit', async () => {
  const body = await (await call('GET', '/api/settings')).json();
  assert.equal(body.version, 0);
  assert.equal(body.isDefault, true);
  assert.equal(body.settings.minimumCpk, 1.33);
  assert.equal(body.canEdit, true);
  assert.ok(body.bounds.minimumCpk);
  assert.equal(body.appliesTo, 'new_studies');
});

test('preview shows changes, deviations and impact — and writes nothing', async () => {
  const res = await call('POST', '/api/settings/preview', { settings: { ...DEFAULTS, minimumCpk: 1.1 } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.changes.length, 1);
  assert.ok(body.deviations.some((d) => /1\.33/.test(d)), 'a minimum under 1.33 must be called out');
  assert.equal((await (await call('GET', '/api/settings')).json()).version, 0);
});

test('preview of an invalid value is a 422 with reasons', async () => {
  const res = await call('POST', '/api/settings/preview', { settings: { minimumCpk: 50 } });
  assert.equal(res.status, 422);
  assert.ok((await res.json()).errors.length);
});

test('PUT without confirm is refused (428) — the server enforces the "are you sure"', async () => {
  const res = await call('PUT', '/api/settings', { settings: { ...DEFAULTS, minimumCpk: 1.5 }, expectedVersion: 0, reason: 'Cliente pide 1.50' });
  assert.equal(res.status, 428);
  assert.equal((await (await call('GET', '/api/settings')).json()).version, 0);
});

test('PUT needs a reason', async () => {
  const res = await call('PUT', '/api/settings', { settings: { ...DEFAULTS, minimumCpk: 1.5 }, expectedVersion: 0, confirm: true, reason: 'ok' });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'reason_required');
});

test('confirmed change applies, bumps the version, and lands in the history with who and why', async () => {
  const res = await call('PUT', '/api/settings', { settings: { ...DEFAULTS, minimumCpk: 1.5, overrides: { 'DIAM-01': 1.67 } }, expectedVersion: 0, confirm: true, reason: 'Cliente exige 1.50 en diámetros' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.applied, true);
  assert.equal(body.version, 1);

  const now = await (await call('GET', '/api/settings')).json();
  assert.equal(now.settings.minimumCpk, 1.5);
  assert.equal(now.settings.overrides['DIAM-01'], 1.67);
  assert.equal(now.isDefault, false);
  assert.equal(now.history.length, 1);
  assert.equal(now.history[0].reason, 'Cliente exige 1.50 en diámetros');
  assert.equal(now.history[0].actor.kind, 'service');
  assert.equal(now.history[0].before.minimumCpk, 1.33);
});

test('a stale version is a 409 conflict: nobody silently overwrites a colleague', async () => {
  const res = await call('PUT', '/api/settings', { settings: { ...DEFAULTS, minimumCpk: 1.4 }, expectedVersion: 0, confirm: true, reason: 'Intento con versión vieja' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'version_conflict');
});

test('a change that changes nothing is reported, not versioned', async () => {
  const res = await call('PUT', '/api/settings', { settings: { ...DEFAULTS, minimumCpk: 1.5, overrides: { 'DIAM-01': 1.67 } }, expectedVersion: 1, confirm: true, reason: 'Sin cambios reales' });
  assert.equal((await res.json()).unchanged, true);
  assert.equal((await (await call('GET', '/api/settings')).json()).version, 1);
});

// ── The criteria actually drive new studies, and old ones keep their snapshot ─
const MEAS = [10.0, 10.1, 9.9, 10.05, 9.95, 10.1, 9.9, 10.0, 10.05, 9.95, 10.1, 9.9, 10.0, 10.05, 9.95, 10.1, 9.9, 10.0, 10.05, 9.95, 10.1, 9.9, 10.0, 10.05, 9.95];

test('new studies are judged under the current criteria; the snapshot is stored with the study', async () => {
  // Same data, same spec — two characteristics, only one has an override.
  const manual = (characteristicId) => call('POST', '/api/studies', { characteristicId, usl: 10.4, lsl: 9.6, measurements: MEAS });
  const a = (await (await manual('DIAM-01')).json()).study;
  const b = (await (await manual('OTHER')).json()).study;
  assert.equal(a.criteria.minimumCpk, 1.67);
  assert.equal(a.criteria.minimumCpkSource, 'characteristic');
  assert.equal(b.criteria.minimumCpk, 1.5);
  assert.equal(b.criteria.minimumCpkSource, 'default');
  assert.equal(a.criteria.version, 1);
  assert.ok(a.priority && a.priority.level);
});

test('an explicit minimumCpk in the request beats any configured value', async () => {
  const res = await call('POST', '/api/studies', { characteristicId: 'DIAM-01', usl: 10.4, lsl: 9.6, measurements: MEAS, minimumCpk: 1.0 });
  const { study } = await res.json();
  assert.equal(study.criteria.minimumCpkSource, 'event');
  assert.equal(study.result.minimumCpk, 1.0);
});

test('changing criteria does not re-judge studies already on file', async () => {
  const before = (await (await call('GET', '/api/studies?limit=50')).json()).studies;
  await call('PUT', '/api/settings', { settings: { ...DEFAULTS, minimumCpk: 2.5 }, expectedVersion: 1, confirm: true, reason: 'Prueba de no retroactividad' });
  const after = (await (await call('GET', '/api/studies?limit=50')).json()).studies;
  const strip = (s) => ({ id: s.id, status: s.result?.status, min: s.result?.minimumCpk, v: s.criteria?.version });
  assert.deepEqual(after.map(strip).sort((x, y) => x.id.localeCompare(y.id)), before.map(strip).sort((x, y) => x.id.localeCompare(y.id)));
});

test('GET /api/studies?sort=priority puts the most urgent first; /api/summary counts them', async () => {
  const { studies } = await (await call('GET', '/api/studies?sort=priority')).json();
  const scores = studies.map((s) => s.priority.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  const summary = await (await call('GET', '/api/summary')).json();
  assert.equal(summary.total, studies.length);
  assert.ok(summary.attention.length <= 5);
});
