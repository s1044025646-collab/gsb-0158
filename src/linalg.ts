/**
 * 稠密线性代数工具（纯 TypeScript，无第三方依赖）。
 *
 * 约定：
 * - Matrix 为行主序二维数组，A[i][j] 表示“第 i 行、第 j 列”。
 * - 对技术系数矩阵 A 的经济含义见 model.ts，行列方向在该文件中固定。
 */

export type Vector = number[];
export type Matrix = number[][];

export function zeros(n: number): Matrix {
  return Array.from({ length: n }, () => new Array<number>(n).fill(0));
}

export function cloneMatrix(A: Matrix): Matrix {
  return A.map((row) => row.slice());
}

export function dim(A: Matrix): { n: number; m: number } {
  const n = A.length;
  const m = n === 0 ? 0 : A[0]!.length;
  return { n, m };
}

export function matMul(A: Matrix, B: Matrix): Matrix {
  const { n, m } = dim(A);
  const p = B[0]!.length;
  const C = Array.from({ length: n }, () => new Array<number>(p).fill(0));
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < m; k++) {
      const aik = A[i]![k]!;
      for (let j = 0; j < p; j++) {
        C[i]![j]! += aik * B[k]![j]!;
      }
    }
  }
  return C;
}

export function matVec(A: Matrix, x: Vector): Vector {
  const n = A.length;
  const m = A[0]!.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < m; j++) s += A[i]![j]! * x[j]!;
    y[i] = s;
  }
  return y;
}

export function vecSub(a: Vector, b: Vector): Vector {
  return a.map((v, i) => v - b[i]!);
}

export function vecAdd(a: Vector, b: Vector): Vector {
  return a.map((v, i) => v + b[i]!);
}
export function vecScale(a: Vector, s: number): Vector {
  return a.map((v) => v * s);
}

export function identity(n: number): Matrix {
  const I = zeros(n);
  for (let i = 0; i < n; i++) I[i]![i] = 1;
  return I;
}

export function transpose(A: Matrix): Matrix {
  const { n, m } = dim(A);
  const T = Array.from({ length: m }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) T[j]![i] = A[i]![j]!;
  return T;
}

/**
 * 带部分选主元的 LU 分解。返回 L、U 与行置换向量 piv。
 * det 可由 U 对角元乘积乘以置换符号得到。
 */
export interface LU {
  L: Matrix;
  U: Matrix;
  piv: number[];
  sign: number;
}

export function luDecompose(input: Matrix, singularTol = 1e-12): LU {
  const n = input.length;
  const U = cloneMatrix(input);
  const L = identity(n);
  const piv = Array.from({ length: n }, (_, i) => i);
  let sign = 1;
  for (let k = 0; k < n; k++) {
    let maxRow = k;
    let maxVal = Math.abs(U[k]![k]!);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(U[i]![k]!);
      if (v > maxVal) {
        maxVal = v;
        maxRow = i;
      }
    }
    if (maxVal <= singularTol) {
      // 保留分解过程但标记为奇异（通过 L/U 调用方结合 det 判断）。
      continue;
    }
    if (maxRow !== k) {
      const tmpU = U[k]!;
      U[k] = U[maxRow]!;
      U[maxRow] = tmpU;
      for (let j = 0; j < k; j++) {
        const tmpL = L[k]![j]!;
        L[k]![j] = L[maxRow]![j]!;
        L[maxRow]![j] = tmpL;
      }
      const tmpP = piv[k]!;
      piv[k] = piv[maxRow]!;
      piv[maxRow] = tmpP;
      sign = -sign;
    }
    const pivot = U[k]![k]!;
    for (let i = k + 1; i < n; i++) {
      const factor = U[i]![k]! / pivot;
      L[i]![k] = factor;
      U[i]![k] = 0;
      for (let j = k + 1; j < n; j++) {
        U[i]![j] = U[i]![j]! - factor * U[k]![j]!;
      }
    }
  }
  return { L, U, piv, sign };
}

export function luDeterminant(lu: LU): number {
  let d = lu.sign;
  for (let i = 0; i < lu.U.length; i++) d *= lu.U[i]![i]!;
  return d;
}

function forwardSolve(L: Matrix, b: Vector): Vector {
  const n = L.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let j = 0; j < i; j++) s -= L[i]![j]! * y[j]!;
    y[i] = s / L[i]![i]!;
  }
  return y;
}

function backSolve(U: Matrix, y: Vector): Vector {
  const n = U.length;
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let j = i + 1; j < n; j++) s -= U[i]![j]! * x[j]!;
    const d = U[i]![i]!;
    if (d === 0) throw new Error("SINGULAR_MATRIX");
    x[i] = s / d;
  }
  return x;
}

/** 求解 M x = b，使用已完成选主元的 LU（b 按 piv 重排）。 */
export function luSolve(lu: LU, b: Vector): Vector {
  const pb = lu.piv.map((r) => b[r]!);
  return backSolve(lu.U, forwardSolve(lu.L, pb));
}

/** 求逆：逐列求解。奇异时抛 SINGULAR_MATRIX。 */
export function inverse(M: Matrix, singularTol = 1e-12): Matrix {
  const n = M.length;
  const lu = luDecompose(M, singularTol);
  const cols: Matrix = Array.from({ length: n }, () => new Array<number>(n));
  for (let j = 0; j < n; j++) {
    const e = new Array<number>(n).fill(0);
    e[j] = 1;
    const col = luSolve(lu, e);
    for (let i = 0; i < n; i++) cols[i]![j] = col[i]!;
  }
  return cols;
}

/** 1-范数条件数 κ1(M) = ||M||1 * ||M^-1||1（也计算 inf 范数取较大者，更稳健）。 */
export function conditionNumber(M: Matrix, singularTol = 1e-12): number {
  const Minv = inverse(M, singularTol);
  return norm1(M) * norm1(Minv);
}

export function norm1(M: Matrix): number {
  let best = 0;
  const n = M.length;
  const m = M[0]!.length;
  for (let j = 0; j < m; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.abs(M[i]![j]!);
    if (s > best) best = s;
  }
  return best;
}

export function normInf(M: Matrix): number {
  let best = 0;
  for (const row of M) {
    const s = row.reduce((acc, v) => acc + Math.abs(v), 0);
    if (s > best) best = s;
  }
  return best;
}

export function vecNormInf(x: Vector): number {
  return x.reduce((acc, v) => Math.max(acc, Math.abs(v)), 0);
}

/**
 * 非负矩阵的谱半径 ρ(A)，采用幂迭代（A 非负时收敛到 Perron 根）。
 * 用于判定可生产性（Hawkins–Simon / ρ(A) < 1）。
 */
export function spectralRadiusNonNeg(A: Matrix, maxIter = 2000, tol = 1e-12): number {
  const n = A.length;
  let v = new Array<number>(n).fill(1 / n);
  let lambda = 0;
  for (let iter = 0; iter < maxIter; iter++) {
    const w = matVec(A, v);
    let nrm = 0;
    for (const x of w) nrm = Math.max(nrm, Math.abs(x));
    if (nrm === 0) return 0;
    const vn = w.map((x) => x / nrm);
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(vn[i]! - v[i]!));
    v = vn;
    lambda = nrm;
    if (diff < tol) break;
  }
  return lambda;
}

/** 逐元素检查非负（允许极小负误差由调用方决定，此处严格判定）。 */
export function hasNegative(A: Matrix, tol = -0): { ok: boolean; index?: [number, number]; value?: number } {
  for (let i = 0; i < A.length; i++)
    for (let j = 0; j < A[i]!.length; j++)
      if (A[i]![j]! < tol) return { ok: false, index: [i, j], value: A[i]![j] };
  return { ok: true };
}
