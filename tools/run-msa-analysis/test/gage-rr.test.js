// test/gage-rr.test.js — AIAG average & range, against values computed by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGageRR, verdictFor } from '../src/domain/gage-rr.js';

const close = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ~${expected} (±${tol}), got ${actual}`);

const obs = (rows) => rows.map(([partId, operatorId, trial, value]) => ({ partId, operatorId, trial, value }));

// Tight gauge, well separated parts (the old demo/acceptable-case.json data).
//   Ranges per (appraiser, part) all 0.001 -> R-double-bar 0.001 -> EV = 0.001 · 0.8862 = 0.0008862
//   Appraiser means A 10.1055, B 10.1075 -> X-diff 0.002
//   AV = sqrt( (0.002·0.7071)^2 − 0.0008862^2 / (2·2) ) = 0.0013432
//   GRR = sqrt(EV^2 + AV^2) = 0.0016092
//   Part means 10.0115, 10.2015 -> Rp 0.19 -> PV = 0.19 · 0.7071 = 0.134349
//   TV = 0.134359 -> %GRR = 1.20 · ndc = floor(1.41 · 0.134349 / 0.0016092) = 117
const tight = obs([
  ['P1', 'A', 1, 10.01], ['P1', 'A', 2, 10.011], ['P1', 'B', 1, 10.012], ['P1', 'B', 2, 10.013],
  ['P2', 'A', 1, 10.2], ['P2', 'A', 2, 10.201], ['P2', 'B', 1, 10.202], ['P2', 'B', 2, 10.203]
]);

// Noisy gauge, parts barely distinguishable (the old demo/not-acceptable-case.json data).
//   Ranges A: .11, .12 · B: .14, .23 -> R-double-bar .15 -> EV = .132930
//   Appraiser means 5.0275, 5.0225 -> X-diff .005 -> (.005·.7071)^2 − .13293^2/4 < 0 -> AV = 0
//   Part means 5.0425, 5.0075 -> Rp .035 -> PV = .024749 · TV = .135213
//   %GRR = 98.31 · ndc = 0
const noisy = obs([
  ['P1', 'A', 1, 5.01], ['P1', 'A', 2, 5.12], ['P1', 'B', 1, 4.95], ['P1', 'B', 2, 5.09],
  ['P2', 'A', 1, 5.05], ['P2', 'A', 2, 4.93], ['P2', 'B', 1, 5.14], ['P2', 'B', 2, 4.91]
]);

test('tight gauge: matches the hand calculation and is acceptable', () => {
  const { ok, result } = analyzeGageRR(tight);
  assert.equal(ok, true);
  close(result.repeatability, 0.0008862, 1e-6, 'EV');
  close(result.reproducibility, 0.0013432, 1e-6, 'AV');
  close(result.grr, 0.0016092, 1e-6, 'GRR');
  close(result.partVariation, 0.134349, 1e-5, 'PV');
  close(result.gageRRPercent, 1.2, 0.01, '%GRR');
  assert.equal(result.ndc, 117);
  assert.equal(result.verdict, 'acceptable');
  assert.deepEqual([result.parts, result.appraisers, result.trials], [2, 2, 2]);
});

test('noisy gauge: unacceptable, and a negative AV is floored to 0 with a warning', () => {
  const { ok, result, warnings } = analyzeGageRR(noisy);
  assert.equal(ok, true);
  close(result.repeatability, 0.13293, 1e-5, 'EV');
  assert.equal(result.reproducibility, 0);
  close(result.gageRRPercent, 98.31, 0.05, '%GRR');
  assert.equal(result.ndc, 0);
  assert.equal(result.verdict, 'unacceptable');
  assert.ok(warnings.some((w) => /negativa/.test(w)));
});

test('3 appraisers × 3 trials × 3 parts uses K1=.5908, K2=.5231, K3=.5231', () => {
  // Each appraiser reads every part as part value + appraiser offset, ± 0.01 across trials.
  const rows = [];
  const partValue = { P1: 10, P2: 11, P3: 12 };
  const offset = { A: 0, B: 0.02, C: 0.04 };
  for (const p of Object.keys(partValue)) {
    for (const a of Object.keys(offset)) {
      [-0.01, 0, 0.01].forEach((d, i) => rows.push([p, a, i + 1, partValue[p] + offset[a] + d]));
    }
  }
  const { ok, result } = analyzeGageRR(obs(rows));
  assert.equal(ok, true);
  // R = 0.02 everywhere -> EV = 0.02 · 0.5908 = 0.011816
  close(result.repeatability, 0.011816, 1e-6, 'EV');
  // X-diff = 0.04 -> AV = sqrt( (0.04·0.5231)^2 − 0.011816^2/(3·3) ) = sqrt(0.00043781 − 0.00001551) = 0.020550
  close(result.reproducibility, 0.02055, 1e-5, 'AV');
  // Rp = 2 -> PV = 2 · 0.5231 = 1.0462
  close(result.partVariation, 1.0462, 1e-4, 'PV');
});

test('verdict thresholds (AIAG), including the ndc >= 5 requirement', () => {
  assert.equal(verdictFor(9.99, 5), 'acceptable');
  assert.equal(verdictFor(9.99, 4), 'marginal', 'ndc below 5 downgrades');
  assert.equal(verdictFor(10, 12), 'marginal');
  assert.equal(verdictFor(30, 12), 'marginal');
  assert.equal(verdictFor(30.01, 12), 'unacceptable');
});

test('rejects designs outside the AIAG constant tables', () => {
  const one = obs([['P1', 'A', 1, 1], ['P1', 'A', 2, 1.1], ['P2', 'A', 1, 2], ['P2', 'A', 2, 2.1]]);
  assert.match(analyzeGageRR(one).errors.join(' '), /2 o 3 operadores/);

  const rows = [];
  for (let p = 1; p <= 11; p += 1) for (const a of ['A', 'B']) for (const t of [1, 2]) rows.push([`P${p}`, a, t, p + t / 100]);
  assert.match(analyzeGageRR(obs(rows)).errors.join(' '), /2 a 10 piezas/);
});

test('rejects unbalanced studies and duplicate readings', () => {
  const unbalanced = tight.slice(0, 7);
  assert.match(analyzeGageRR(unbalanced).errors.join(' '), /balanceado/);
  const dup = [...tight, { partId: 'P1', operatorId: 'A', trial: 1, value: 10.02 }];
  assert.match(analyzeGageRR(dup).errors.join(' '), /duplicada/);
});

test('identical repeats (EV = 0) are refused: it is a resolution problem, not a perfect gauge', () => {
  const flat = obs([
    ['P1', 'A', 1, 1], ['P1', 'A', 2, 1], ['P1', 'B', 1, 1], ['P1', 'B', 2, 1],
    ['P2', 'A', 1, 2], ['P2', 'A', 2, 2], ['P2', 'B', 1, 2], ['P2', 'B', 2, 2]
  ]);
  const r = analyzeGageRR(flat);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /resolución/);
});

test('field-level errors are reported per row', () => {
  const r = analyzeGageRR([{ partId: 'P1', operatorId: '', trial: 1, value: 'x' }]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /operador/.test(e)));
  assert.ok(r.errors.some((e) => /numérica/.test(e)));
});
