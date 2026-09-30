import { test } from "node:test";
import assert from "node:assert/strict";
import { inverse, matVec, spectralRadiusNonNeg, transpose } from "../src/linalg.js";
import { compareShocks, ModelError, roundDecomposition, solve } from "../src/model.js";
import {
  nearSingular,
  noIntermediate,
  reorderFixture,
  stronglyCyclicProductive,
  twoSectorAnalytic,
  unproductive,
} from "../src/fixtures.js";

const TOL = 1e-7;

test("两部门解析例：总产出与手算值一致", () => {
  const f = twoSectorAnalytic;
  const r = solve({ A: f.A, demand: f.demand, valueAdded: f.valueAdded, directEmission: f.directEmission });
  assert.ok(Math.abs(r.x[0]! - 15 / 0.69) < TOL, `x0=${r.x[0]}`);
  assert.ok(Math.abs(r.x[1]! - 17 / 0.69) < TOL, `x1=${r.x[1]}`);
  // Leontief 逆
  const L = inverse([
    [0.8, -0.3],
    [-0.1, 0.9],
  ]);
  assert.ok(Math.abs(L[0]![0]! - 0.9 / 0.69) < TOL);
  assert.ok(Math.abs(r.residualNormInf) < 1e-9);
});

test("平衡残差 x-(Ax+d)≈0", () => {
  const f = stronglyCyclicProductive;
  const r = solve(f);
  const Ax = matVec(f.A, r.x);
  r.x.forEach((xi, i) => assert.ok(Math.abs(xi - Ax[i]! - f.demand[i]!) < 1e-7));
});

test("无中间投入：x=d，p=v，排放=e'd", () => {
  const f = noIntermediate;
  const r = solve(f);
  assert.deepEqual(r.x, f.demand);
  assert.deepEqual(r.prices, f.valueAdded);
  const expectEm = f.directEmission[0]! * f.demand[0]! + f.directEmission[1]! * f.demand[1]!;
  assert.ok(Math.abs(r.emissions.directTotal - expectEm) < TOL);
  assert.ok(Math.abs(r.emissions.embodiedInDemand - expectEm) < TOL);
});

test("强循环但可生产：ρ(A)=0.9<1，产出为正", () => {
  const f = stronglyCyclicProductive;
  assert.ok(Math.abs(spectralRadiusNonNeg(f.A) - 0.9) < 1e-6);
  const r = solve(f);
  assert.ok(r.x.every((v) => v > 0));
  assert.equal(r.diagnostics.productive, true);
});

test("不可生产：ρ(A)>1 抛 NOT_PRODUCTIVE", () => {
  const f = unproductive;
  assert.throws(
    () => solve(f),
    (e: unknown) => e instanceof ModelError && e.code === "NOT_PRODUCTIVE",
  );
});

test("近奇异：可解但条件数大、标记病态", () => {
  const f = nearSingular;
  const r = solve(f);
  assert.ok(r.diagnostics.condition > 1e8, `κ=${r.diagnostics.condition}`);
  assert.equal(r.diagnostics.illConditioned, true);
  // x0 = 1/1e-9 = 1e9
  assert.ok(Math.abs(r.x[0]! - 1e9) / 1e9 < 1e-6);
});

test("奇异矩阵：I-A 不可逆抛 SINGULAR_MATRIX", () => {
  // A 使 I-A 奇异：A=[[1,0],[0,0]]
  assert.throws(
    () =>
      solve({
        A: [
          [1, 0],
          [0, 0],
        ],
        demand: [1, 1],
        valueAdded: [0.1, 1],
        directEmission: [1, 1],
      }),
    (e: unknown) => e instanceof ModelError,
  );
});

test("负系数被拒绝（不做归一化/截断）", () => {
  assert.throws(
    () =>
      solve({
        A: [
          [-0.1, 0.2],
          [0.1, 0.1],
        ],
        demand: [1, 1],
        valueAdded: [1, 1],
        directEmission: [1, 1],
      }),
    (e: unknown) => e instanceof ModelError && e.code === "NEGATIVE_COEFFICIENT",
  );
});

test("轮次分解：截断+余项=精确解，且 round k = A^k d", () => {
  const f = twoSectorAnalytic;
  const r = solve(f);
  const dec = roundDecomposition(f.A, r.leontiefInverse, f.demand, 5);
  assert.equal(dec.rounds.length, 6);
  assert.deepEqual(dec.rounds[0], f.demand);
  // round1 = A d
  const ad = matVec(f.A, f.demand);
  assert.ok(Math.abs(dec.rounds[1]![0]! - ad[0]!) < TOL);
  dec.truncated.forEach((t, i) => {
    assert.ok(Math.abs(t + dec.remainder[i]! - r.x[i]!) < 1e-8);
  });
  // 增加轮数余项单调趋小
  const dec20 = roundDecomposition(f.A, r.leontiefInverse, f.demand, 20);
  assert.ok(dec20.remainderNormInf < dec.remainderNormInf);
});

test("线性叠加：L(d1+d2)=Ld1+Ld2（叠加冲击差量等于分别冲击之和）", () => {
  const f = twoSectorAnalytic;
  const s0 = solve(f);
  const f1 = { ...f, demand: [f.demand[0]! + 5, f.demand[1]!] };
  const f2 = { ...f, demand: [f.demand[0]!, f.demand[1]! - 2] };
  const f12 = { ...f, demand: [f.demand[0]! + 5, f.demand[1]! - 2] };
  const s1 = solve(f1);
  const s2 = solve(f2);
  const s12 = solve(f12);
  const cmpA = compareShocks(s0, s1, f.demand, f1.demand, f.A, f1.A);
  const cmpB = compareShocks(s0, s2, f.demand, f2.demand, f.A, f2.A);
  s12.x.forEach((v, i) => {
    assert.ok(Math.abs(v - (s0.x[i]! + cmpA.deltaOutput[i]! + cmpB.deltaOutput[i]!)) < 1e-7);
  });
});

test("价格对偶：(I-A')p=v，且 p'x = v'x（增加值=最终需求支出恒等）", () => {
  const f = twoSectorAnalytic;
  const r = solve(f);
  const MT = transpose([
    [0.8, -0.3],
    [-0.1, 0.9],
  ]);
  const lhs = matVec(MT, r.prices);
  lhs.forEach((v, i) => assert.ok(Math.abs(v - f.valueAdded[i]!) < 1e-9));
  // p'd == v'x（GDP 收入面/支出面一致）
  const pd = r.prices[0]! * f.demand[0]! + r.prices[1]! * f.demand[1]!;
  assert.ok(Math.abs(pd - r.valueAddedTotal) < 1e-6);
});

test("排放：直接合计=e'x；完全强度满足 g=e+A'g（不重复计量）", () => {
  const f = stronglyCyclicProductive;
  const r = solve(f);
  const expect = f.directEmission.reduce((s, e, j) => s + e * r.x[j]!, 0);
  assert.ok(Math.abs(r.emissions.directTotal - expect) < 1e-7);
  // g = e + A' g
  const At = transpose(f.A);
  const g = r.emissions.totalIntensity;
  const Atg = matVec(At, g);
  g.forEach((gi, i) => assert.ok(Math.abs(gi - (f.directEmission[i]! + Atg[i]!)) < 1e-7));
  assert.ok(Math.abs(r.emissions.embodiedInDemand - expect) < 1e-6);
});

test("排列不变：部门换序后结果按序一致", () => {
  const f = twoSectorAnalytic;
  const g = reorderFixture(f, ["MFG", "AGR"]);
  const rf = solve(f);
  const rg = solve(g);
  // g 的顺序是 MFG,AGR
  assert.ok(Math.abs(rg.x[0]! - rf.x[1]!) < 1e-8);
  assert.ok(Math.abs(rg.x[1]! - rf.x[0]!) < 1e-8);
  assert.ok(Math.abs(rg.prices[0]! - rf.prices[1]!) < 1e-8);
  assert.ok(Math.abs(rg.emissions.directTotal - rf.emissions.directTotal) < 1e-8);
});
