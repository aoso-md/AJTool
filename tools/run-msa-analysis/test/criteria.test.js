// test/criteria.test.js — editable MSA acceptance criteria: validation, the
// confirmation gate, concurrency, history, and that history is never re-judged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.TOOL_API_KEY = 'tool-test-key';
delete process.env.OIDC_ISSUER;

const { createApp } = await import('../src/platform/app.js');
const { createStore } = await import('../src/platform/store.js');
const { createCoreClient } = await import('../src/platform/core-client.js');
const { createPoller, createPublisher } = await import('../src/platform/poller.js');
const { TOOL, createMsaTool, validatedData } = await import('../src/tool.js');
const { DEFAULTS, validateCriteria, describeChanges, impactOn } = await import('../src/domain/criteria.js');
const { verdictFor, analyzeGageRR } = await import('../src/domain/gage-rr.js');
const { priorityOf, summarize } = await import('../src/domain/priority.js');

const quiet = { info () {}, warn () {}, error () {} };
const H = { 'x-api-key': 'tool-test-key', 'content-type': 'application/json' };

const obs = (rows) => rows.map(([partId, operatorId, trial, value]) => ({ partId, operatorId, trial, value }));
// Tight gauge: %GRR 1.20, ndc 117 (hand-computed in gage-rr.test.js).
const tight = obs([
  ['P1', 'A', 1, 10.01], ['P1', 'A', 2, 10.011], ['P1', 'B', 1, 10.012], ['P1', 'B', 2, 10.013],
  ['P2', 'A', 1, 10.2], ['P2', 'A', 2, 10.201], ['P2', 'B', 1, 10.202], ['P2', 'B', 2, 10.203]
]);

let server; let base;
before(async () => {
  const store = await createStore({ log: quiet });
  const core = createCoreClient({ baseUrl: 'http://127.0.0.1:9/api/v1', apiKey: 'k' });
  const publisher = createPublisher({ core, mode: 'shadow', log: quiet });
  const domain = createMsaTool({ store, publisher, log: quiet });
  const poller = createPoller({ toolId: TOOL.id, consumes: TOOL.consumes, core, store, processEvent: domain.processEvent, log: quiet });
  const app = createApp({ tool: TOOL, config: {}, core, store, poller, publisher, registerRoutes: domain.registerRoutes, log: quiet });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));
const call = (method, path, body) => fetch(base + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });

// ── Pure rules ──────────────────────────────────────────────────────────────
test('defaults are the AIAG guideline', () => {
  assert.deepEqual(DEFAULTS, { grrAcceptable: 10, grrMarginal: 30, minNdc: 5 });
  assert.equal(verdictFor(9.99, 5), 'acceptable');
  assert.equal(verdictFor(10, 5), 'marginal');
  assert.equal(verdictFor(30, 5), 'marginal');
  assert.equal(verdictFor(30.01, 5), 'unacceptable');
  assert.equal(verdictFor(5, 4), 'marginal', 'ndc below the minimum downgrades an otherwise acceptable system');
});

test('the thresholds really move the verdict', () => {
  assert.equal(verdictFor(12, 8, { grrAcceptable: 15, grrMarginal: 30, minNdc: 5 }), 'acceptable');
  assert.equal(verdictFor(12, 8, { grrAcceptable: 10, grrMarginal: 11, minNdc: 5 }), 'unacceptable');
  assert.equal(verdictFor(5, 6, { grrAcceptable: 10, grrMarginal: 30, minNdc: 8 }), 'marginal');
});

test('validation: types, bounds, and acceptable < marginal', () => {
  assert.equal(validateCriteria(DEFAULTS).ok, true);
  assert.equal(validateCriteria({ ...DEFAULTS, grrAcceptable: 'x' }).ok, false);
  assert.equal(validateCriteria({ ...DEFAULTS, grrAcceptable: 40 }).ok, false);
  assert.equal(validateCriteria({ ...DEFAULTS, minNdc: 4.5 }).ok, false);
  assert.equal(validateCriteria({ grrAcceptable: 25, grrMarginal: 20, minNdc: 5 }).ok, false);
  assert.ok(validateCriteria({ grrAcceptable: 'x', grrMarginal: 99, minNdc: 1 }).errors.length >= 3);
});

test('the analysis stamps the thresholds it used into the result', () => {
  const { result } = analyzeGageRR(tight, { grrAcceptable: 1, grrMarginal: 30, minNdc: 5 });
  assert.deepEqual(result.criteria, { grrAcceptable: 1, grrMarginal: 30, minNdc: 5 });
  assert.equal(result.verdict, 'marginal'); // 1.20% is not below 1%
});

test('impact: a stricter threshold would reclassify studies on file', () => {
  const study = (id, grr) => ({ id, status: 'completed', gaugeId: id, result: { gageRRPercent: grr, ndc: 9 } });
  const before = validateCriteria(DEFAULTS).value;
  const after = validateCriteria({ ...DEFAULTS, grrAcceptable: 5 }).value;
  const impact = impactOn([study('a', 7), study('b', 3), study('c', 40)], before, after, verdictFor);
  assert.equal(impact.evaluated, 3);
  assert.equal(impact.changed, 1);
  assert.equal(impact.noLongerAcceptable, 1);
  assert.deepEqual(describeChanges(before, after).map((c) => c.field), ['grrAcceptable']);
});

// ── Priority ────────────────────────────────────────────────────────────────
test('priority: unacceptable > marginal > pending (older = more urgent) > acceptable', () => {
  const NOW = Date.parse('2026-10-10T00:00:00Z');
  const done = (verdict, grr) => ({ status: 'completed', result: { verdict, gageRRPercent: grr, ndc: 3 }, publish: { state: 'published' }, createdAt: '2026-10-09T00:00:00Z' });
  const pending = (created) => ({ status: 'pending', publish: { state: 'awaiting_capture' }, createdAt: created });
  assert.equal(priorityOf(done('unacceptable', 55), NOW).level, 'critical');
  assert.equal(priorityOf(done('marginal', 18), NOW).level, 'high');
  assert.equal(priorityOf(done('acceptable', 4), NOW).level, 'low');
  const fresh = priorityOf(pending('2026-10-10T00:00:00Z'), NOW);
  const old = priorityOf(pending('2026-10-01T00:00:00Z'), NOW);
  assert.equal(fresh.level, 'medium');
  assert.equal(old.level, 'high');
  assert.ok(old.score > fresh.score);
  assert.match(old.reason, /9 días/);
});

test('summary counts urgency and reports the oldest pending gauge', () => {
  const NOW = Date.parse('2026-10-10T00:00:00Z');
  const s = summarize([
    { id: 'a', status: 'pending', gaugeId: 'G-1', publish: {}, createdAt: '2026-10-05T00:00:00Z' },
    { id: 'b', status: 'completed', gaugeId: 'G-2', result: { verdict: 'acceptable', gageRRPercent: 3, ndc: 20 }, publish: {}, createdAt: '2026-10-09T00:00:00Z' }
  ], NOW);
  assert.equal(s.pending, 1);
  assert.equal(s.oldestPendingDays, 5);
  assert.equal(s.attention[0].label, 'G-1');
});

// ── HTTP: the confirmation gate ─────────────────────────────────────────────
test('GET /api/settings exposes defaults, bounds, version and who may edit', async () => {
  const body = await (await call('GET', '/api/settings')).json();
  assert.equal(body.version, 0);
  assert.deepEqual(body.settings, DEFAULTS);
  assert.equal(body.canEdit, true);
  assert.ok(body.bounds.grrAcceptable);
});

test('preview flags values that depart from AIAG, and writes nothing', async () => {
  const res = await call('POST', '/api/settings/preview', { settings: { grrAcceptable: 15, grrMarginal: 35, minNdc: 4 } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.changes.length, 3);
  assert.equal(body.deviations.length, 3);
  assert.equal((await (await call('GET', '/api/settings')).json()).version, 0);
});

test('PUT without confirm is refused (428); without a reason it is a 422', async () => {
  const settings = { ...DEFAULTS, grrAcceptable: 12 };
  assert.equal((await call('PUT', '/api/settings', { settings, expectedVersion: 0, reason: 'Criterio de planta' })).status, 428);
  const noReason = await call('PUT', '/api/settings', { settings, expectedVersion: 0, confirm: true, reason: 'x' });
  assert.equal(noReason.status, 422);
  assert.equal((await (await call('GET', '/api/settings')).json()).version, 0);
});

test('confirmed change applies and the history records who, why, and before/after', async () => {
  const res = await call('PUT', '/api/settings', { settings: { ...DEFAULTS, grrAcceptable: 12 }, expectedVersion: 0, confirm: true, reason: 'Procedimiento de planta MET-004 rev. 3' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).version, 1);
  const now = await (await call('GET', '/api/settings')).json();
  assert.equal(now.settings.grrAcceptable, 12);
  assert.equal(now.history[0].reason, 'Procedimiento de planta MET-004 rev. 3');
  assert.equal(now.history[0].before.grrAcceptable, 10);
  assert.equal(now.history[0].after.grrAcceptable, 12);
});

test('a stale version is a 409 conflict', async () => {
  const res = await call('PUT', '/api/settings', { settings: { ...DEFAULTS, grrAcceptable: 8 }, expectedVersion: 0, confirm: true, reason: 'Versión vieja a propósito' });
  assert.equal(res.status, 409);
});

// ── The criteria drive new studies and travel with the published event ──────
test('a new study is judged under the current criteria and keeps the snapshot', async () => {
  // %GRR 1.2: acceptable under 12, marginal if the limit were 1.
  const res = await call('POST', '/api/studies', { gaugeId: 'GAUGE-X', observations: tight });
  const { study } = await res.json();
  assert.equal(study.result.verdict, 'acceptable');
  assert.equal(study.criteria.version, 1);
  assert.equal(study.criteria.grrAcceptable, 12);
  assert.deepEqual(study.result.criteria, { grrAcceptable: 12, grrMarginal: 30, minNdc: 5 });
  assert.ok(study.priority);
  const data = validatedData(study);
  assert.deepEqual(data.acceptanceCriteria, { grrAcceptable: 12, grrMarginal: 30, minNdc: 5 });
  assert.equal(data.criteriaVersion, 1);
});

test('changing criteria later does not re-judge studies already on file', async () => {
  const strip = (s) => ({ id: s.id, verdict: s.result?.verdict, v: s.criteria?.version });
  const before = (await (await call('GET', '/api/studies')).json()).studies.map(strip);
  await call('PUT', '/api/settings', { settings: { ...DEFAULTS, grrAcceptable: 1 }, expectedVersion: 1, confirm: true, reason: 'Endurecer criterio de prueba' });
  const after = (await (await call('GET', '/api/studies')).json()).studies.map(strip);
  assert.deepEqual(after, before);
  // ...but the next study is judged by the new rule.
  const { study } = await (await call('POST', '/api/studies', { gaugeId: 'GAUGE-Y', observations: tight })).json();
  assert.equal(study.result.verdict, 'marginal');
  assert.equal(study.criteria.version, 2);
});

test('GET /api/studies?sort=priority orders by urgency; /api/summary agrees', async () => {
  const { studies } = await (await call('GET', '/api/studies?sort=priority')).json();
  const scores = studies.map((s) => s.priority.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.equal((await (await call('GET', '/api/summary')).json()).total, studies.length);
});
