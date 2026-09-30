// Minimal dense linear algebra used by the Leontief solver.
// All matrices are row-major: m[row][col].

export function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

export function cloneMatrix(m: number[][]): number[][] {
  return m.map((row) => row.slice());
}

export function matVec(m: number[][], v: number[]): number[] {
  const n = m.length;
  const out = zeros(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const row = m[i]!;
    for (let j = 0; j < n; j++) sum += row[j]! * v[j]!;
    out[i] = sum;
  }
  return out;
}

export function vecSub(a: number[], b: number[]): number[] {
  return a.map((v, i) => v - b[i]!);
}

export function vecAdd(a: number[], b: number[]): number[] {
  return a.map((v, i) => v + b[i]!);
}

export function scaleVec(v: number[], s: number): number[] {
  return v.map((x) => x * s);
}

export function normInf(v: number[]): number {
  return v.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
}

export function norm1(v: number[]): number {
  return v.reduce((s, x) => s + Math.abs(x), 0);
}

export function infinityNorm(m: number[][]): number {
  return m.reduce((best, row) => Math.max(best, norm1(row)), 0);
}

export function oneNorm(m: number[][]): number {
  const n = m.length;
  let best = 0;
  for (let j = 0; j < n; j++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.abs(m[i]![j]!);
    best = Math.max(best, sum);
  }
  return best;
}

/**
 * Solve A x = b with Gaussian elimination and partial pivoting.
 * Throws when a pivot is below `singularTol` (relative).
 * Returns the solution; the caller is responsible for residual/condition diagnostics.
 */
export function solveLinear(
  aIn: number[][],
  bIn: number[],
  singularTol = 1e-12,
): number[] {
  const n = aIn.length;
  const a = cloneMatrix(aIn);
  const b = bIn.slice();

  const scale = infinityNorm(a);
  const tol = singularTol * Math.max(scale, 1);

  for (let k = 0; k < n; k++) {
    let pivot = k;
    let pivotAbs = Math.abs(a[k]![k]!);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(a[i]![k]!);
      if (v > pivotAbs) {
        pivotAbs = v;
        pivot = i;
      }
    }
    if (pivotAbs <= tol) {
      throw new Error(`SINGULAR: pivot ${pivotAbs.toExponential(3)} at column ${k}`);
    }
    if (pivot !== k) {
      const tmpRow = a[k]!;
      a[k] = a[pivot]!;
      a[pivot] = tmpRow;
      const tmpB = b[k]!;
      b[k] = b[pivot]!;
      b[pivot] = tmpB;
    }
    const pivotRow = a[k]!;
    const pivotVal = pivotRow[k]!;
    for (let i = k + 1; i < n; i++) {
      const factor = a[i]![k]! / pivotVal;
      if (factor === 0) continue;
      const row = a[i]!;
      row[k] = 0;
      for (let j = k + 1; j < n; j++) row[j] = row[j]! - factor * pivotRow[j]!;
      b[i] = b[i]! - factor * b[k]!;
    }
  }

  const x = zeros(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i]!;
    const row = a[i]!;
    for (let j = i + 1; j < n; j++) sum -= row[j]! * x[j]!;
    x[i] = sum / row[i]!;
  }
  return x;
}

/** Invert a square matrix by solving against identity columns. */
export function invert(m: number[][], singularTol = 1e-12): number[][] {
  const n = m.length;
  const cols: number[][] = [];
  for (let j = 0; j < n; j++) {
    const e = zeros(n);
    e[j] = 1;
    cols.push(solveLinear(m, e, singularTol));
  }
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = zeros(n);
    for (let j = 0; j < n; j++) row[j] = cols[j]![i]!;
    out.push(row);
  }
  return out;
}

/**
 * Condition-number estimate via explicit inverse:
 * kappa_inf(L) = ||L||_inf * ||L^-1||_inf.
 * Only used for small IO matrices; diagnostics, not production numerics at scale.
 */
export function conditionNumberInf(m: number[][], singularTol = 1e-12): number {
  const inv = invert(m, singularTol);
  return infinityNorm(m) * infinityNorm(inv);
}

/**
 * Spectral radius estimate of a non-negative matrix by power iteration
 * (Perron-Frobenius). Used for the productivity check rho(A) < 1.
 */
export function spectralRadius(
  a: number[][],
  iterations = 2000,
  tol = 1e-12,
): number {
  const n = a.length;
  let v = new Array<number>(n).fill(1 / n);
  let lambda = 0;
  for (let iter = 0; iter < iterations; iter++) {
    const w = matVec(a, v);
    const norm = norm1(w);
    if (norm === 0) return 0;
    const vn = scaleVec(w, 1 / norm);
    const nextLambda = norm;
    if (iter > 4 && Math.abs(nextLambda - lambda) <= tol * Math.max(1, nextLambda)) {
      lambda = nextLambda;
      v = vn;
      break;
    }
    lambda = nextLambda;
    v = vn;
  }
  // Refine: Rayleigh-like ratio using A v
  const av = matVec(a, v);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += v[i]! * av[i]!;
    den += v[i]! * v[i]!;
  }
  void lambda;
  return den === 0 ? 0 : num / den;
}

/**
 * Hawkins-Simon style viability check for an open Leontief economy:
 * every principal leading minor of I - A is positive, assuming A >= 0.
 * A non-negative productive A also satisfies rho(A) < 1; both are reported.
 */
export function hawkinsSimon(IminusA: number[][]): boolean {
  const n = IminusA.length;
  const m = cloneMatrix(IminusA);
  for (let k = 0; k < n; k++) {
    // For Hawkins-Simon on leading principal minors we must NOT reorder;
    // check the diagonal element of the un-pivoted (but previously eliminated) matrix.
    const diag = m[k]![k]!;
    if (!(diag > 0)) return false;
    const pivotVal = m[k]![k]!;
    for (let i = k + 1; i < n; i++) {
      const factor = m[i]![k]! / pivotVal;
      const row = m[i]!;
      for (let j = k; j < n; j++) row[j] = row[j]! - factor * m[k]![j]!;
    }
  }
  return true;
}

export function identityMatrix(n: number): number[][] {
  const m: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = zeros(n);
    row[i] = 1;
    m.push(row);
  }
  return m;
}

export function leontiefMatrix(a: number[][]): number[][] {
  const n = a.length;
  return identityMatrix(n).map((row, i) => row.map((v, j) => v - a[i]![j]!));
}

export function transpose(m: number[][]): number[][] {
  const n = m.length;
  const out: number[][] = [];
  for (let j = 0; j < n; j++) {
    const row = zeros(n);
    for (let i = 0; i < n; i++) row[i] = m[i]![j]!;
    out.push(row);
  }
  return out;
}
