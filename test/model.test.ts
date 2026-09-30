import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveModel, applyDemandShock, validateEconomy } from '../src/model.ts';
import { fixtures, fixtureEconomy } from '../src/fixtures.ts';
import { approxEqual, vecApprox } from './helpers.ts';
import { AppError } from '../src/errors.ts';

const fixedNow = () => new Date('2026-01-01T00:00:00Z');

test('two-sector analytic example: closed-form x and balance residual', () => {
  const f = fixtures['two-sector']!;
  const r = solveModel(fixtureEconomy(f), { now: fixedNow, maxRounds: 20 });

  // Analytic inversion of [[0.9,-0.2],[-0.3,0.6]], determinant 0.48.
  // L^-1 = 1/0.48 * [[0.6,0.2],[0.3,0.9]]
  const d = f.finalDemand as number[];
  const expected = [
    (0.6 * d[0]! + 0.2 * d[1]!) / 0.48,
    (0.3 * d[0]! + 0.9 * d[1]!) / 0.48,
  ];
  assert.ok(vecApprox(r.x, expected, 1e-10));

  // Material balance x = A x + d.
  assert.ok(r.diagnostics.residualInf < 1e-9);
  assert.ok(r.diagnostics.relativeResidualInf < 1e-11);

  // National accounting identity: sum value added == sum final demand
  // (both in consistent value units) and dual identity p'd = v'x.
  assert.ok(approxEqual(r.valueAddedTotal, r.finalDemandTotal, 1e-8));
  const pd = r.prices.reduce((s, p, i) => s + p * r.d[i]!, 0);
  const vx = r.valueAddedTotal;
  assert.ok(approxEqual(pd, vx, 1e-8));
});

test('no intermediate inputs: x = d, prices = v, zero rounds beyond 0', () => {
  const f = fixtures['no-intermediate']!;
  const r = solveModel(fixtureEconomy(f), { now: fixedNow, maxRounds: 5 });
  assert.ok(vecApprox(r.x, f.finalDemand as number[]));
  assert.ok(vecApprox(r.prices, f.valueAdded as number[]));
  assert.ok(vecApprox(r.rounds.rounds[0]!, f.finalDemand as number[]));
  for (let k = 1; k < r.rounds.rounds.length; k++) {
    assert.ok(vecApprox(r.rounds.rounds[k]!, [0, 0, 0]));
  }
  assert.ok(r.rounds.reconciliationResidualInf < 1e-12);
  assert.ok(approxEqual(r.diagnostics.spectralRadiusA, 0));
});

test('strongly circular but productive economy solves with small residual', () => {
  const f = fixtures['strong-circular']!;
  const r = solveModel(fixtureEconomy(f), { now: fixedNow, maxRounds: 60 });
  assert.ok(r.diagnostics.spectralRadiusA < 1);
  assert.ok(r.diagnostics.hawkinsSimon);
  assert.ok(r.diagnostics.residualInf < 1e-7);
  for (const xi of r.x) assert.ok(xi > 0);
});

test('unproductive matrix is rejected, never normalized or clipped into validity', () => {
  const f = fixtures.unproductive!;
  assert.throws(
    () => solveModel(fixtureEconomy(f), { now: fixedNow }),
    (err: unknown) => err instanceof AppError && err.code === 'NOT_PRODUCTIVE',
  );
});

test('near-singular matrix reports high condition number and warning flag', () => {
  const f = fixtures['near-singular']!;
  const r = solveModel(fixtureEconomy(f), { now: fixedNow, illConditionedThreshold: 1e6 });
  assert.ok(r.diagnostics.conditionNumberInf > 1e6);
  assert.equal(r.diagnostics.illConditioned, true);
  // Still solves accurately.
  assert.ok(r.diagnostics.residualInf < 1e-6);
});

test('negative coefficients and negative demand are rejected', () => {
  const f = fixtures['two-sector']!;
  assert.throws(
    () => validateEconomy({ ...fixtureEconomy(f), A: [[-0.01, 0.2], [0.3, 0.4]] }),
    (err: unknown) => err instanceof AppError && err.code === 'NON_NEGATIVE_VIOLATION',
  );
  assert.throws(
    () => applyDemandShock(solveModel(fixtureEconomy(f), { now: fixedNow }), [-101, 0]),
    (err: unknown) => err instanceof AppError && err.code === 'NEGATIVE_DEMAND',
  );
});

test('round decomposition remainder reconciles with exact solution', () => {
  const f = fixtures['strong-circular']!;
  const r = solveModel(fixtureEconomy(f), { now: fixedNow, maxRounds: 4 });
  assert.equal(r.rounds.rounds.length, 5);
  assert.ok(r.rounds.reconciliationResidualInf < 1e-9);
  // The truncated tail is genuinely positive and non-trivial for circular A.
  assert.ok(r.rounds.remainder.some((z) => z > 1e-6));
});

test('linear superposition: shock deltas add under frozen A', () => {
  const f = fixtures['two-sector']!;
  const base = solveModel(fixtureEconomy(f), { now: fixedNow });
  const s1 = applyDemandShock(base, [10, 0], { now: fixedNow });
  const s2 = applyDemandShock(base, [0, 20], { now: fixedNow });
  const sBoth = applyDemandShock(base, [10, 20], { now: fixedNow });
  assert.ok(vecApprox(sBoth.shocked.x, base.x.map((x, i) => x + s1.deltaX[i]! + s2.deltaX[i]!), 1e-9));
  // Re-running baseline with baseline demand reproduces baseline.
  const again = applyDemandShock(base, [0, 0], { now: fixedNow });
  assert.ok(vecApprox(again.shocked.x, base.x, 1e-12));
});

test('price dual: (I - A^T) p = v and cost identity p = A^T p + v', () => {
  const f = fixtures['strong-circular']!;
  const r = solveModel(fixtureEconomy(f), { now: fixedNow });
  const Atp = r.A[0]!.map((_, j) => r.A.reduce((sum, row) => sum + row[j]! * r.prices[j]!, 0));
  // Compute A^T p explicitly by columns.
  const AtpCorrect = r.prices.map((_, i) => r.A.reduce((sum, row, rr) => sum + row[i]! * r.prices[rr]!, 0));
  void Atp;
  r.prices.forEach((p, i) => {
    assert.ok(approxEqual(p, AtpCorrect[i]! + r.v[i]!, 1e-9));
  });
});

test('emissions: direct total equals embodied total (no double counting)', () => {
  const f = fixtures['two-sector']!;
  const r = solveModel(fixtureEconomy(f), { now: fixedNow, maxRounds: 30 });
  assert.ok(Math.abs(r.emissions.accountingGap) < 1e-6);
  // Embodied intensity c = e + A^T c
  r.emissions.embodiedIntensity.forEach((c, i) => {
    const upstream = r.A.reduce((sum, row, rr) => sum + row[i]! * r.emissions.embodiedIntensity[rr]!, 0);
    assert.ok(approxEqual(c, r.eDirect[i]! + upstream, 1e-8));
  });
  // Emission rounds + remainder sum to total.
  const roundTotal = r.emissions.emissionRounds
    .flat()
    .concat(r.emissions.emissionRemainder)
    .reduce((s, z) => s + z, 0);
  assert.ok(approxEqual(roundTotal, r.emissions.directTotal, 1e-6));
});

test('permutation invariance: reordered sectors give reordered identical results', () => {
  const a = solveModel(fixtureEconomy(fixtures['two-sector']!), { now: fixedNow });
  const b = solveModel(fixtureEconomy(fixtures['two-sector-reversed']!), { now: fixedNow });
  const orderB = a.sectors.map((s) => b.sectors.indexOf(s));
  const bx = a.sectors.map((_, i) => b.x[orderB[i]!]!);
  assert.ok(vecApprox(bx, a.x, 1e-9));
  const bp = a.sectors.map((_, i) => b.prices[orderB[i]!]!);
  assert.ok(vecApprox(bp, a.prices, 1e-9));
  assert.ok(approxEqual(a.emissions.directTotal, b.emissions.directTotal, 1e-9));
});

