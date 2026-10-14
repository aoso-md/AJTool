"use strict";

/* =====================================================================
   Quality Tools Workspace — test suite
   ---------------------------------------------------------------------
   Zero dependencies, zero setup. From the repo root:

     node test/run-tests.js

   Covers three layers:
     1. MATH      — hand-computed expected values, so a wrong formula
                    fails here rather than in front of a customer.
     2. CONTRACT  — every demo file produces the verdict and the official
                    event the docs promise (docs/OFFICIAL-EXTERNAL-ADMIN-CONTRACT.md).
     3. HTTP      — each server really boots, serves /, /health, /events,
                    /reports, and enforces x-api-key.

   No database required: with DATABASE_URL unset the services run their
   in-memory history tier, which is exactly what these tests exercise.
   Exit code 0 = everything passed, 1 = something failed (so CI can gate
   on it).
   ===================================================================== */

const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CPK_DIR = path.join(ROOT, "tools", "calculate-cpk-ppk");
const MSA_DIR = path.join(ROOT, "tools", "run-msa-analysis");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === "function") {
      throw new Error("use testAsync for async tests: " + name);
    }
    passed++;
    console.log("  ✓ " + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log("  ✗ " + name);
    console.log("      " + err.message);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log("  ✗ " + name);
    console.log("      " + err.message);
  }
}

function section(title) {
  console.log("\n" + title);
  console.log("-".repeat(title.length));
}

function loadDemo(dir, file) {
  return JSON.parse(fs.readFileSync(path.join(dir, "demo", file), "utf8"));
}

/* Assert a number matches to a tolerance — capability math is floating
   point, so exact equality would be a flaky test, not a strict one. */
function close(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    (label || "value") + ": expected ~" + expected + " (±" + tolerance + "), got " + actual
  );
}

/* =====================================================================
   1. MATH
   ===================================================================== */

function mathTests() {
  section("1. Math — hand-computed expectations");

  const { handle: cpkHandle } = require(path.join(CPK_DIR, "src", "handler.js"));
  const { handle: msaHandle } = require(path.join(MSA_DIR, "src", "handler.js"));

  test("Cpk: perfectly centred process gives Cp == Cpk", () => {
    // measurements 9,10,11 -> mean 10, sample sd = 1 exactly.
    // spec 4..16 -> Cp = (16-4)/(6*1) = 2
    // centred, so Cpu = (16-10)/3 = 2, Cpl = (10-4)/3 = 2 -> Cpk = 2
    const res = cpkHandle({
      type: "MEASUREMENTS_CAPTURED",
      payload: { measurements: [9, 10, 11], lsl: 4, usl: 16, target: 10 }
    });
    assert.strictEqual(res.ok, true, "expected a completed run");
    close(res.result.mean, 10, 1e-9, "mean");
    close(res.result.standardDeviation, 1, 1e-9, "standardDeviation");
    close(res.result.cp, 2, 1e-6, "cp");
    close(res.result.cpk, 2, 1e-6, "cpk");
    assert.strictEqual(res.result.verdict, "capable");
  });

  test("Cpk: off-centre process takes the worse of the two sides", () => {
    // mean 10, sd 1, spec 4..13 -> Cp = 9/6 = 1.5
    // Cpu = (13-10)/3 = 1, Cpl = (10-4)/3 = 2 -> Cpk = 1 (the worse side)
    const res = cpkHandle({
      type: "MEASUREMENTS_CAPTURED",
      payload: { measurements: [9, 10, 11], lsl: 4, usl: 13, target: 10 }
    });
    close(res.result.cp, 1.5, 1e-6, "cp");
    close(res.result.cpk, 1, 1e-6, "cpk");
    assert.ok(res.result.cpk < res.result.cp, "Cpk must never exceed Cp");
  });

  test("Cpk: default minimum is 1.33 when the event omits it", () => {
    const res = cpkHandle({
      type: "MEASUREMENTS_CAPTURED",
      payload: { measurements: [9, 10, 11], lsl: 4, usl: 13, target: 10 }
    });
    assert.strictEqual(res.result.minimumCpk, 1.33);
    // Cpk 1.0 < 1.33 -> below target
    assert.strictEqual(res.result.verdict, "below-target");
  });

  test("Cpk: an explicit minimumCpk overrides the default", () => {
    const res = cpkHandle({
      type: "MEASUREMENTS_CAPTURED",
      payload: { measurements: [9, 10, 11], lsl: 4, usl: 13, target: 10, minimumCpk: 0.8 }
    });
    assert.strictEqual(res.result.minimumCpk, 0.8);
    assert.strictEqual(res.result.verdict, "capable", "Cpk 1.0 clears a 0.8 bar");
  });

  test("MSA: identical repeated readings give Gage R&R of 0%", () => {
    // Zero spread within each part/operator group and zero operator
    // difference -> repeatability 0, reproducibility 0 -> Gage R&R 0%.
    const res = msaHandle({
      type: "MSA_STUDY_REQUESTED",
      payload: {
        studyId: "T-1", deviceId: "DEV-1",
        observations: [
          { partId: "P1", operatorId: "A", trial: 1, value: 1 },
          { partId: "P1", operatorId: "A", trial: 2, value: 1 },
          { partId: "P1", operatorId: "B", trial: 1, value: 1 },
          { partId: "P1", operatorId: "B", trial: 2, value: 1 },
          { partId: "P2", operatorId: "A", trial: 1, value: 5 },
          { partId: "P2", operatorId: "A", trial: 2, value: 5 },
          { partId: "P2", operatorId: "B", trial: 1, value: 5 },
          { partId: "P2", operatorId: "B", trial: 2, value: 5 }
        ]
      }
    });
    assert.strictEqual(res.ok, true);
    close(res.result.repeatability, 0, 1e-9, "repeatability");
    close(res.result.reproducibility, 0, 1e-9, "reproducibility");
    close(res.result.gageRRPercent, 0, 1e-9, "gageRRPercent");
  });

  test("MSA: operator bias shows up as reproducibility, not repeatability", () => {
    // Each operator is perfectly repeatable, but B reads 1.0 higher than
    // A on every part. That is pure reproducibility error.
    const res = msaHandle({
      type: "MSA_STUDY_REQUESTED",
      payload: {
        studyId: "T-2", deviceId: "DEV-2",
        observations: [
          { partId: "P1", operatorId: "A", trial: 1, value: 10 },
          { partId: "P1", operatorId: "A", trial: 2, value: 10 },
          { partId: "P1", operatorId: "B", trial: 1, value: 11 },
          { partId: "P1", operatorId: "B", trial: 2, value: 11 },
          { partId: "P2", operatorId: "A", trial: 1, value: 20 },
          { partId: "P2", operatorId: "A", trial: 2, value: 20 },
          { partId: "P2", operatorId: "B", trial: 1, value: 21 },
          { partId: "P2", operatorId: "B", trial: 2, value: 21 }
        ]
      }
    });
    close(res.result.repeatability, 0, 1e-9, "repeatability should be zero");
    assert.ok(res.result.reproducibility > 0, "reproducibility should be positive");
  });
}

/* =====================================================================
   2. CONTRACT — demo files must behave as documented
   ===================================================================== */

function contractTests() {
  section("2. Contract — demo cases and official events");

  const { handle: cpkHandle } = require(path.join(CPK_DIR, "src", "handler.js"));
  const { handle: msaHandle } = require(path.join(MSA_DIR, "src", "handler.js"));

  const officialOf = (res, type) =>
    (res.emittedEvents || []).find((e) => e.type === type);

  test("cpk/capable-case -> capable, no CAPABILITY_BELOW_TARGET emitted", () => {
    const res = cpkHandle(loadDemo(CPK_DIR, "capable-case.json"));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result.verdict, "capable");
    assert.ok(res.result.cpk >= res.result.minimumCpk, "cpk should clear the minimum");
    assert.strictEqual(
      officialOf(res, "CAPABILITY_BELOW_TARGET"), undefined,
      "a capable process must not raise the below-target event"
    );
  });

  test("cpk/below-target-case -> below-target + official CAPABILITY_BELOW_TARGET", () => {
    const res = cpkHandle(loadDemo(CPK_DIR, "below-target-case.json"));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result.verdict, "below-target");
    const evt = officialOf(res, "CAPABILITY_BELOW_TARGET");
    assert.ok(evt, "CAPABILITY_BELOW_TARGET must be emitted");
    assert.strictEqual(evt.official, true, "CAPABILITY_BELOW_TARGET is confirmed by [EXTERNAL_ADMIN]");
  });

  test("cpk: CAPABILITY_ANALYSIS_COMPLETED is emitted but flagged NOT official", () => {
    const res = cpkHandle(loadDemo(CPK_DIR, "capable-case.json"));
    const evt = officialOf(res, "CAPABILITY_ANALYSIS_COMPLETED");
    assert.ok(evt, "the proposed completion event should still be emitted locally");
    assert.strictEqual(evt.official, false, "not part of the confirmed contract yet");
  });

  test("cpk/missing-specs-case -> validation error, nothing emitted", () => {
    const res = cpkHandle(loadDemo(CPK_DIR, "missing-specs-case.json"));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, "validation-error");
    assert.deepStrictEqual(res.emittedEvents, [], "a rejected event must not emit anything");
    assert.ok(res.details.length > 0, "the caller must be told what is missing");
  });

  test("cpk: a foreign event type is rejected, not guessed at", () => {
    const res = cpkHandle({ type: "SOMETHING_ELSE", payload: {} });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, "validation-error");
  });

  test("cpk: identical measurements are rejected (sd = 0, Cpk undefined)", () => {
    const res = cpkHandle({
      type: "MEASUREMENTS_CAPTURED",
      payload: { measurements: [5, 5, 5, 5], lsl: 4, usl: 6, target: 5 }
    });
    assert.strictEqual(res.ok, false, "must not divide by zero and report a fake Cpk");
  });

  test("msa/acceptable-case -> acceptable + official MSA_VALIDATED", () => {
    const res = msaHandle(loadDemo(MSA_DIR, "acceptable-case.json"));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result.verdict, "acceptable");
    assert.ok(res.result.gageRRPercent <= 10, "acceptable requires Gage R&R <= 10%");
    assert.ok(res.result.ndc >= 5, "acceptable requires NDC >= 5");
    const evt = officialOf(res, "MSA_VALIDATED");
    assert.ok(evt, "MSA_VALIDATED must be emitted");
    assert.strictEqual(evt.official, true, "MSA_VALIDATED is confirmed by [EXTERNAL_ADMIN]");
  });

  test("msa/not-acceptable-case -> not-acceptable + MSA_NOT_ACCEPTABLE (not official)", () => {
    const res = msaHandle(loadDemo(MSA_DIR, "not-acceptable-case.json"));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result.verdict, "not-acceptable");
    const evt = officialOf(res, "MSA_NOT_ACCEPTABLE");
    assert.ok(evt, "MSA_NOT_ACCEPTABLE must be emitted");
    assert.strictEqual(
      evt.official, false,
      "still NOT confirmed by [EXTERNAL_ADMIN] — see docs/OPEN-QUESTIONS-FOR-EXTERNAL-ADMIN.md"
    );
    assert.strictEqual(
      officialOf(res, "MSA_VALIDATED"), undefined,
      "a failed study must never emit MSA_VALIDATED"
    );
  });

  test("msa/incomplete-device-case -> warning, no invented result", () => {
    const res = msaHandle(loadDemo(MSA_DIR, "incomplete-device-case.json"));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, "warning");
    assert.deepStrictEqual(res.emittedEvents, []);
  });

  test("msa: NEW_DEVICE_REGISTERED with observations is the official input path", () => {
    const res = msaHandle({
      type: "NEW_DEVICE_REGISTERED",
      payload: {
        deviceId: "CAL-999",
        observations: [
          { partId: "P1", operatorId: "A", trial: 1, value: 1 },
          { partId: "P1", operatorId: "A", trial: 2, value: 1 },
          { partId: "P2", operatorId: "A", trial: 1, value: 9 },
          { partId: "P2", operatorId: "A", trial: 2, value: 9 }
        ]
      }
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.compatibilityPath, true, "should flag the NEW_DEVICE_REGISTERED path");
    assert.strictEqual(res.result.studyId, "MSA-CAL-999", "studyId is derived when absent");
  });
}

/* =====================================================================
   3. HTTP — the servers actually run
   ===================================================================== */

const TEST_KEY = "test-key-do-not-use-in-production";

function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt() {
      const req = http.get({ host: "127.0.0.1", port, path: "/health" }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) return reject(new Error("server never became healthy on port " + port));
        setTimeout(attempt, 120);
      });
    })();
  });
}

function request(port, method, path, body, key) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (key) headers["x-api-key"] = key;

    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { /* HTML or empty is fine */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function startServer(entry, port) {
  const child = spawn(process.execPath, [entry], {
    env: Object.assign({}, process.env, {
      PORT: String(port),
      INBOUND_API_KEY: TEST_KEY,
      DATABASE_URL: "" // force the in-memory tier — tests need no database
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function httpTestsFor(label, entry, port, sampleEvent, expectVerdict) {
  section("3. HTTP — " + label);

  const child = startServer(entry, port);
  try {
    await waitForHealth(port, 8000);

    await testAsync("GET / serves the frontend (200, not 404)", async () => {
      const res = await request(port, "GET", "/");
      assert.strictEqual(res.status, 200, "a bare URL must never look 'offline'");
      assert.ok(res.raw.length > 0, "expected a body");
    });

    await testAsync("GET /health is open (no key) and reports persistence", async () => {
      const res = await request(port, "GET", "/health");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.inboundAuthRequired, true, "INBOUND_API_KEY was set for this test");
      assert.ok(res.body.persistence, "health must state the persistence tier");
      assert.strictEqual(
        res.body.persistence.durable, false,
        "no DATABASE_URL in tests, so it must honestly say not durable"
      );
    });

    await testAsync("POST /events without a key is rejected with 401", async () => {
      const res = await request(port, "POST", "/events", sampleEvent, null);
      assert.strictEqual(res.status, 401);
    });

    await testAsync("POST /events with the wrong key is rejected with 401", async () => {
      const res = await request(port, "POST", "/events", sampleEvent, "wrong-key");
      assert.strictEqual(res.status, 401);
    });

    await testAsync("POST /events with the right key returns the analysis", async () => {
      const res = await request(port, "POST", "/events", sampleEvent, TEST_KEY);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.result.verdict, expectVerdict);
    });

    await testAsync("invalid JSON is a clean 400, not a crash", async () => {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1", port, method: "POST", path: "/events",
          headers: { "Content-Type": "application/json", "x-api-key": TEST_KEY }
        }, (r) => {
          let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => resolve({ status: r.statusCode }));
        });
        req.on("error", reject);
        req.write("{ this is not json");
        req.end();
      });
      assert.strictEqual(res.status, 400);
    });

    await testAsync("GET /reports shows the call that just ran", async () => {
      const res = await request(port, "GET", "/reports", null, TEST_KEY);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.servedFrom, "memory", "no database in tests");
      assert.ok(res.body.count >= 1, "the POST above should have been recorded");
      const row = res.body.invocations[0];
      assert.strictEqual(row.verdict, expectVerdict);
      assert.strictEqual(row.ok, true);
    });

    await testAsync("GET /reports without a key is rejected with 401", async () => {
      const res = await request(port, "GET", "/reports", null, null);
      assert.strictEqual(res.status, 401, "history carries payload data, so it must be protected");
    });

    await testAsync("a rejected call is recorded too (audit evidence)", async () => {
      await request(port, "POST", "/events", { type: "NOT_A_REAL_EVENT", payload: {} }, TEST_KEY);
      const res = await request(port, "GET", "/reports", null, TEST_KEY);
      const row = res.body.invocations[0];
      assert.strictEqual(row.ok, false, "the rejection should be the newest entry");
      assert.strictEqual(row.event_type, "NOT_A_REAL_EVENT");
    });

    await testAsync("unknown route returns 404 with the route list", async () => {
      const res = await request(port, "GET", "/nope", null, TEST_KEY);
      assert.strictEqual(res.status, 404);
      assert.ok(Array.isArray(res.body.knownRoutes));
    });
  } finally {
    child.kill();
  }
}

/* =====================================================================
   run
   ===================================================================== */

(async function main() {
  console.log("Quality Tools Workspace — test suite");
  console.log("node " + process.version + "\n");

  mathTests();
  contractTests();

  await httpTestsFor(
    "calculate_cpk_ppk",
    path.join(CPK_DIR, "src", "server.js"),
    18081,
    loadDemo(CPK_DIR, "below-target-case.json"),
    "below-target"
  );

  await httpTestsFor(
    "run_msa_analysis",
    path.join(MSA_DIR, "src", "server.js"),
    18082,
    loadDemo(MSA_DIR, "acceptable-case.json"),
    "acceptable"
  );

  console.log("\n" + "=".repeat(46));
  console.log(passed + " passed, " + failed + " failed");
  console.log("=".repeat(46));

  if (failed) {
    console.log("\nFailures:");
    for (const f of failures) console.log("  ✗ " + f.name + "\n    " + f.err.message);
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error("\ntest runner crashed:", err);
  process.exit(1);
});
