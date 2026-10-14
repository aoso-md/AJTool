// test/capability.test.js — the math, against values computed by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCapability, classify, upperTail } from '../src/domain/capability.js';

const close = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ~${expected} (±${tol}), got ${actual}`);

test('normal tail probabilities', () => {
  close(upperTail(0), 0.5, 1e-7, 'P(Z>0)');
  close(upperTail(1.959964), 0.025, 1e-6, 'P(Z>1.96)');
  close(upperTail(3), 0.0013499, 1e-6, 'P(Z>3)');
  close(upperTail(-1), 0.8413447, 1e-6, 'P(Z>-1)');
});

// Data [10, 12, 10, 12]:
//   mean 11 · moving ranges 2,2,2 -> MR-bar 2 -> sigma within = 2 / 1.128 = 1.773050
//   sample sd = sqrt( (1+1+1+1) / 3 ) = 1.154701
test('centred process, spec 5..17: Cp = Cpk = 1.128, Pp = Ppk = sqrt(3)', () => {
  const { ok, result } = analyzeCapability({ measurements: [10, 12, 10, 12], usl: 17, lsl: 5 });
  assert.equal(ok, true);
  close(result.mean, 11, 1e-9, 'mean');
  close(result.sigmaWithin, 1.77305, 1e-5, 'sigma within');
  close(result.sigmaOverall, 1.154701, 1e-6, 'sigma overall');
  close(result.cp, 1.128, 1e-4, 'cp');      // 12 / (6 · 1.77305)
  close(result.cpk, 1.128, 1e-4, 'cpk');
  close(result.pp, Math.sqrt(3), 1e-4, 'pp'); // 12 / (6 · 1.154701)
  close(result.ppk, Math.sqrt(3), 1e-4, 'ppk');
  close(result.sigmaLevel, 3.384, 1e-3, 'sigma level = 3·Cpk');
  // 1.128 < 1.33 but >= 1.0
  assert.equal(result.status, 'marginal');
  assert.equal(result.belowTarget, true);
});

test('same data, spec 8..14: not capable, ~9 375 ppm expected out of spec', () => {
  const { result } = analyzeCapability({ measurements: [10, 12, 10, 12], usl: 14, lsl: 8 });
  close(result.cpk, 0.564, 1e-3, 'cpk');    // 3 / (3 · 1.77305)
  close(result.ppk, 0.866, 1e-3, 'ppk');    // 3 / (3 · 1.154701)
  // 2 · P(Z > 3 / 1.154701 = 2.598076) = 2 · 0.0046876
  close(result.ppmDefects, 9375.2, 2, 'ppm');
  assert.equal(result.status, 'not_capable');
});

test('off-centre: Cpk takes the worse side, and never exceeds Cp', () => {
  // mean 11, sigma within 1.77305, spec 5..13: Cpu = 2/5.31915 = 0.376, Cpl = 6/5.31915 = 1.128
  const { result } = analyzeCapability({ measurements: [10, 12, 10, 12], usl: 13, lsl: 5 });
  close(result.cpk, 0.376, 1e-3, 'cpk');
  assert.ok(result.cpk <= result.cp);
});

test('a capable process is not escalated', () => {
  const { result } = analyzeCapability({ measurements: [10, 10.1, 10, 10.1], usl: 11, lsl: 9 });
  assert.equal(result.status, 'capable');
  assert.equal(result.belowTarget, false);
});

test('a drifting process: Ppk sees the drift, Cpk does not (that is the point of having both)', () => {
  // Small steps between consecutive parts, large overall spread.
  const drift = [10.0, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9];
  const { result } = analyzeCapability({ measurements: drift, usl: 11.5, lsl: 9.5 });
  assert.ok(result.cpk > result.ppk, `cpk ${result.cpk} should exceed ppk ${result.ppk} on a drifting process`);
});

test('minimumCpk overrides the 1.33 default', () => {
  const { result } = analyzeCapability({ measurements: [10, 12, 10, 12], usl: 17, lsl: 5, minimumCpk: 1.0 });
  assert.equal(result.minimumCpk, 1.0);
  assert.equal(result.status, 'capable');
  assert.equal(result.belowTarget, false);
});

test('classification boundaries', () => {
  assert.equal(classify(1.33, 1.33), 'capable');
  assert.equal(classify(1.329, 1.33), 'marginal');
  assert.equal(classify(1.0, 1.33), 'marginal');
  assert.equal(classify(0.999, 1.33), 'not_capable');
});

test('invalid input is rejected with reasons, never computed', () => {
  assert.equal(analyzeCapability({ measurements: [1], usl: 2, lsl: 0 }).ok, false);
  assert.equal(analyzeCapability({ measurements: [1, 2], usl: 0, lsl: 2 }).ok, false);
  assert.equal(analyzeCapability({ measurements: [1, 'x'], usl: 3, lsl: 0 }).ok, false);
  assert.equal(analyzeCapability({ measurements: [1, 2] }).ok, false);
  const flat = analyzeCapability({ measurements: [5, 5, 5], usl: 6, lsl: 4 });
  assert.equal(flat.ok, false);
  assert.match(flat.errors[0], /variación/);
});

test('small samples and out-of-spec readings come with warnings', () => {
  const { warnings } = analyzeCapability({ measurements: [10, 12, 10, 12], usl: 11.5, lsl: 5 });
  assert.ok(warnings.some((w) => /25/.test(w)));
  assert.ok(warnings.some((w) => /fuera de especificación/.test(w)));
});
