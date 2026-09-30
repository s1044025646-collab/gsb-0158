/**
 * 开放式 Leontief 固定系数模型。
 *
 * 部门编号 0..n-1，顺序由外部部门表决定。
 *
 * 技术系数矩阵 A（n×n）行列方向（务必固定）：
 *   A[i][j] = 生产“第 j 部门一单位总产出”所消耗的“第 i 部门产品”数量。
 *   即行 i = 供给/投入来源部门，列 j = 生产/消耗部门。
 *
 * 数量平衡（货币或实物口径一致，单位随部门表）：
 *   x = A x + d
 *   x : 总产出向量（每部门单位/期）
 *   d : 最终需求向量（同单位/期）
 *   A x: 中间使用
 *   Leontief 逆 L = (I - A)^-1 = I + A + A^2 + ...
 *
 * 价格对偶（行价格视角）：
 *   p' = p' A + v'  等价于  (I - A') p = v
 *   v[j] = 每单位 j 产出的增加值（要素成本）系数
 *   p[j] = j 产品的均衡价格/单位成本
 *
 * 排放：
 *   e[j] = 每单位 j 总产出的“直接”排放强度（范围1式口径）。
 *   直接排放总量 = e' x。
 *   完全（含上游）强度 = e' L（列 j 表示一单位 j 最终产品的全部隐含排放）。
 *   绝不与已含上游的强度再次相乘，避免重复计量。
 */

import {
  Matrix,
  Vector,
  conditionNumber,
  identity,
  inverse,
  luDecompose,
  luDeterminant,
  luSolve,
  matVec,
  spectralRadiusNonNeg,
  transpose,
  vecNormInf,
  vecSub,
  vecAdd,
} from "./linalg.js";

export const DEFAULT_COND_WARN = 1e8;
export const SINGULAR_DET_TOL = 1e-12;

export interface ModelInput {
  /** 技术系数 A[i][j]：j 生产消耗 i。 */
  A: Matrix;
  /** 最终需求 d。 */
  demand: Vector;
  /** 单位总产出增加值系数 v。 */
  valueAdded: Vector;
  /** 单位总产出直接排放强度 e（不得是已含上游口径）。 */
  directEmission: Vector;
}

export interface Diagnostics {
  nonNegative: boolean;
  /** I-A 的行列式绝对值。 */
  detAbs: number;
  /** 谱半径 ρ(A)。 */
  spectralRadius: number;
  /** 可生产：ρ(A) < 1 且 (I-A) 可逆、x 非负。 */
  productive: boolean;
  /** 1-范数条件数 κ(I-A)。 */
  condition: number;
  illConditioned: boolean;
  singular: boolean;
}

export interface RoundDecomposition {
  /** rounds[k] 为第 k 轮（k=0 为直接需求）各部门产出向量。 */
  rounds: Vector[];
  /** 截断到 rounds 之和。 */
  truncated: Vector;
  /** 精确解 - 截断和，即被省略轮次的余项。 */
  remainder: Vector;
  /** ||remainder||∞。 */
  remainderNormInf: number;
}

export interface EmissionResult {
  /** 分部门直接排放 e_j * x_j。 */
  directBySector: Vector;
  /** 直接排放合计 e'x。 */
  directTotal: number;
  /** 完全强度（含上游）g' = e' L，按部门列给出。 */
  totalIntensity: Vector;
  /** 最终需求隐含排放 g'd（与 e'x 在平衡下相等）。 */
  embodiedInDemand: number;
}

export interface SolveResult {
  x: Vector;
  leontiefInverse: Matrix;
  prices: Vector;
  valueAddedBySector: Vector;
  valueAddedTotal: number;
  emissions: EmissionResult;
  residual: Vector;
  residualNormInf: number;
  diagnostics: Diagnostics;
}

export class ModelError extends Error {
  constructor(
    public code:
      | "NEGATIVE_COEFFICIENT"
      | "NON_SQUARE"
      | "DIMENSION_MISMATCH"
      | "SINGULAR_MATRIX"
      | "NOT_PRODUCTIVE"
      | "NEGATIVE_OUTPUT"
      | "NEGATIVE_DEMAND",
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

function validateShape(input: ModelInput, n: number): void {
  if (input.A.length !== n || input.A.some((r) => r.length !== n))
    throw new ModelError("NON_SQUARE", `技术系数矩阵必须为 ${n}×${n} 方阵`);
  for (const [name, v] of [
    ["demand", input.demand],
    ["valueAdded", input.valueAdded],
    ["directEmission", input.directEmission],
  ] as const) {
    if (v.length !== n)
      throw new ModelError("DIMENSION_MISMATCH", `${name} 长度应为 ${n}，实际 ${v.length}`);
  }
}

/**
 * Neumann 轮次分解：x = d + A d + A^2 d + ...
 * round 0 = d（直接需求），round k = A^k d（第 k 轮间接投入）。
 * 余项 = 精确解 - 截断和，保证与精确解严格对账。
 */
export function roundDecomposition(A: Matrix, L: Matrix, d: Vector, maxRounds: number): RoundDecomposition {
  const n = d.length;
  const rounds: Vector[] = [];
  const truncated = new Array<number>(n).fill(0);
  let current = d.slice();
  for (let k = 0; k <= maxRounds; k++) {
    rounds.push(current.slice());
    for (let i = 0; i < n; i++) truncated[i]! += current[i]!;
    if (k < maxRounds) current = matVec(A, current);
  }
  const exact = matVec(L, d);
  const remainder = vecSub(exact, truncated);
  return {
    rounds,
    truncated,
    remainder,
    remainderNormInf: vecNormInf(remainder),
  };
}

export interface SolveOptions {
  condWarn?: number;
  singularTol?: number;
}

/**
 * 求解数量模型与价格对偶。
 * 不做“归一化系数”或“截断负产出”这类制造有效结果的处理：
 * 系数为负、矩阵奇异、不可生产或产出为负都直接给出明确错误/诊断。
 */
export function solve(input: ModelInput, opts: SolveOptions = {}): SolveResult {
  const condWarn = opts.condWarn ?? DEFAULT_COND_WARN;
  const tol = opts.singularTol ?? SINGULAR_DET_TOL;
  const n = input.A.length;
  validateShape(input, n);

  if (input.A.some((row, i) => row.some((v, j) => v < -tol))) {
    const hit = (() => {
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) if (input.A[i]![j]! < -tol) return [i, j, input.A[i]![j]] as const;
      return [0, 0, 0] as const;
    })();
    throw new ModelError(
      "NEGATIVE_COEFFICIENT",
      `技术系数必须非负，发现 A[${hit[0]}][${hit[1]}]=${hit[2]}`,
    );
  }
  if (input.demand.some((v) => v < -tol))
    throw new ModelError("NEGATIVE_DEMAND", "最终需求不得为负");
  if (input.valueAdded.some((v) => v < -tol))
    throw new ModelError("NEGATIVE_COEFFICIENT", "增加值系数必须非负");
  if (input.directEmission.some((v) => v < -tol))
    throw new ModelError("NEGATIVE_COEFFICIENT", "直接排放强度必须非负");

  const I = identity(n);
  const M = I.map((row, i) => row.map((v, j) => v - input.A[i]![j]!));

  const lu = luDecompose(M, tol);
  const det = luDeterminant(lu);
  const detAbs = Math.abs(det);
  const singular = detAbs <= tol;

  let L: Matrix;
  let x: Vector;
  let cond = Infinity;
  if (singular) {
    throw new ModelError("SINGULAR_MATRIX", `(I-A) 奇异，|det|=${detAbs.toExponential(3)}，总产出不唯一`);
  }
  L = inverse(M, tol);
  x = luSolve(lu, input.demand);
  cond = conditionNumber(M, tol);

  const rho = spectralRadiusNonNeg(input.A);
  const productive = rho < 1 && x.every((v) => v >= -tol);
  if (!productive) {
    if (rho >= 1)
      throw new ModelError(
        "NOT_PRODUCTIVE",
        `模型不可生产：谱半径 ρ(A)=${rho.toFixed(6)} ≥ 1（Hawkins–Simon 条件不满足）`,
        { spectralRadius: rho },
      );
    throw new ModelError("NEGATIVE_OUTPUT", "解出负总产出，给定需求在该技术下不可行", { x });
  }

  // 价格对偶：(I - A') p = v
  const MT = transpose(M);
  const luT = luDecompose(MT, tol);
  const prices = luSolve(luT, input.valueAdded);

  const valueAddedBySector = input.valueAdded.map((v, j) => v * x[j]!);
  const valueAddedTotal = valueAddedBySector.reduce((a, b) => a + b, 0);

  // 排放：严格区分直接强度与完全强度。
  const directBySector = input.directEmission.map((e, j) => e * x[j]!);
  const directTotal = directBySector.reduce((a, b) => a + b, 0);
  const Lt = transpose(L);
  const totalIntensity = matVec(Lt, input.directEmission); // g' = e' L
  const embodiedInDemand = totalIntensity.reduce((s, g, j) => s + g * input.demand[j]!, 0);

  // 数量平衡残差 r = x - (Ax + d)
  const residual = vecSub(x, vecAdd(matVec(input.A, x), input.demand));

  return {
    x,
    leontiefInverse: L,
    prices,
    valueAddedBySector,
    valueAddedTotal,
    emissions: {
      directBySector,
      directTotal,
      totalIntensity,
      embodiedInDemand,
    },
    residual,
    residualNormInf: vecNormInf(residual),
    diagnostics: {
      nonNegative: true,
      detAbs,
      spectralRadius: rho,
      productive,
      condition: cond,
      illConditioned: cond >= condWarn,
      singular,
    },
  };
}

/**
 * 两个方案的比较结果。必须使用同一冻结技术矩阵（调用方负责保证 A 相同）。
 * 这里只做线性代数层面的差量；静态固定系数乘数不作为市场因果预测。
 */
export interface ShockComparison {
  baseline: SolveResult;
  shocked: SolveResult;
  deltaDemand: Vector;
  deltaOutput: Vector;
  deltaValueAddedBySector: Vector;
  deltaValueAddedTotal: number;
  deltaDirectEmissionTotal: number;
  sameFrozenA: boolean;
}

export function compareShocks(baseline: SolveResult, shocked: SolveResult, d0: Vector, d1: Vector, A0: Matrix, A1: Matrix): ShockComparison {
  const deltaDemand = vecSub(d1, d0);
  const sameFrozenA = JSON.stringify(A0) === JSON.stringify(A1);
  return {
    baseline,
    shocked,
    deltaDemand,
    deltaOutput: vecSub(shocked.x, baseline.x),
    deltaValueAddedBySector: vecSub(shocked.valueAddedBySector, baseline.valueAddedBySector),
    deltaValueAddedTotal: shocked.valueAddedTotal - baseline.valueAddedTotal,
    deltaDirectEmissionTotal: shocked.emissions.directTotal - baseline.emissions.directTotal,
    sameFrozenA,
  };
}

export { roundDecomposition as decompose };
