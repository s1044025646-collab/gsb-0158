import { AppError } from './errors.ts';
import {
  conditionNumberInf,
  hawkinsSimon,
  identityMatrix,
  leontiefMatrix,
  matVec,
  normInf,
  scaleVec,
  solveLinear,
  spectralRadius,
  transpose,
  vecAdd,
  vecSub,
  zeros,
} from './linalg.ts';

export const EPS = 1e-12;

export interface EconomyInput {
  /** Ordered sector ids; column/row j refers to sectors[j]. */
  sectors: string[];
  /**
   * Technical coefficient matrix, row-major.
   * A[i][j] = units of sector i output consumed as intermediate input
   * to produce ONE unit of sector j gross output (column j = recipe of j).
   * Unit: input-unit_i / output-unit_j. A >= 0.
   */
  A: number[][];
  /** Final demand vector d (same units as gross output x), d >= 0. */
  d: number[];
  /** Value-added per unit of gross output by producing sector j, v >= 0. */
  v: number[];
  /**
   * DIRECT emissions intensity by producing sector: emissions per unit
   * of sector j gross output. Direct-only — never mix with embodied/upstream
   * intensity, or emissions would be double counted.
   */
  eDirect: number[];
}

export interface RoundDecomposition {
  /** rounds[k] = A^k d, k = 0..maxRounds. Round 0 is the direct final-demand pull. */
  rounds: number[][];
  /** Exact remainder: x - sum(rounds), reconciled against the exact solution. */
  remainder: number[];
  /** Sum of all listed rounds plus remainder (equals x to round-off). */
  reconstructed: number[];
  reconciliationResidualInf: number;
}

export interface EmissionReport {
  /** Direct emissions by producing sector: eDirect[i] * x[i]. */
  directBySector: number[];
  directTotal: number;
  /**
   * Embodied (total) emissions intensity per unit of FINAL demand:
   * c = (I - A^T)^-1 eDirect. Includes upstream, so c*d must not be added
   * to eDirect*x — they are two accounting views of the same total.
   */
  embodiedIntensity: number[];
  /** Emissions embodied in final demand by demand sector: c[i] * d[i]. */
  embodiedByDemandSector: number[];
  embodiedTotal: number;
  /**
   * Supply-chain round decomposition of emissions attributable to final demand:
   * emissionRounds[k] = (A^k d) .* eDirect  (emissions physically generated in round k).
   */
  emissionRounds: number[][];
  emissionRemainder: number[];
  /** Difference between the two accounting totals; must be ~ round-off. */
  accountingGap: number;
}

export interface SolveReport {
  sectors: string[];
  A: number[][];
  d: number[];
  v: number[];
  eDirect: number[];
  /** Gross output x solving (I - A) x = d. */
  x: number[];
  /** Intermediate use A x. */
  intermediate: number[];
  /** Value added by sector v[i] * x[i]. */
  valueAdded: number[];
  valueAddedTotal: number;
  finalDemandTotal: number;
  grossOutputTotal: number;
  /** Dual prices p solving (I - A^T) p = v: price per unit output given VA cost. */
  prices: number[];
  rounds: RoundDecomposition;
  emissions: EmissionReport;
  diagnostics: {
    residualInf: number;
    relativeResidualInf: number;
    conditionNumberInf: number;
    spectralRadiusA: number;
    columnSums: number[];
    rowSums: number[];
    hawkinsSimon: boolean;
    illConditioned: boolean;
    illConditionedThreshold: number;
  };
  solvedAt: string;
}

export interface SolveOptions {
  maxRounds?: number;
  illConditionedThreshold?: number;
  /** Injected clock for reproducible tests/demos. */
  now?: () => Date;
}

function assertFiniteVector(name: string, v: number[], n: number): void {
  if (!Array.isArray(v) || v.length !== n) {
    throw new AppError('VALIDATION', `${name} must be an array of length ${n}`);
  }
  for (let i = 0; i < n; i++) {
    const value = v[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new AppError('VALIDATION', `${name}[${i}] must be a finite number`);
    }
  }
}

export function validateEconomy(input: EconomyInput): void {
  const { sectors, A, d, v, eDirect } = input;
  if (!Array.isArray(sectors) || sectors.length === 0) {
    throw new AppError('VALIDATION', 'sectors must be a non-empty array');
  }
  const seen = new Set<string>();
  sectors.forEach((s, i) => {
    if (typeof s !== 'string' || s.trim() === '') {
      throw new AppError('VALIDATION', `sectors[${i}] must be a non-empty string`);
    }
    if (seen.has(s)) {
      throw new AppError('DUPLICATE_SECTOR', `duplicate sector id: ${s}`);
    }
    seen.add(s);
  });
  const n = sectors.length;
  if (!Array.isArray(A) || A.length !== n || A.some((row) => !Array.isArray(row) || row.length !== n)) {
    throw new AppError('VALIDATION', `A must be a ${n}x${n} matrix aligned with sectors`);
  }
  A.forEach((row, i) =>
    row.forEach((value, j) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new AppError('VALIDATION', `A[${i}][${j}] must be a finite number`);
      }
      if (value < -EPS) {
        throw new AppError(
          'NON_NEGATIVE_VIOLATION',
          `technical coefficient A[${i}][${j}] = ${value} is negative`,
          { i, j, value },
        );
      }
    }),
  );
  assertFiniteVector('d', d, n);
  assertFiniteVector('v', v, n);
  assertFiniteVector('eDirect', eDirect, n);
  for (const [name, vec] of [
    ['d', d],
    ['v', v],
    ['eDirect', eDirect],
  ] as const) {
    vec.forEach((value, i) => {
      if (value < -EPS) {
        throw new AppError(
          name === 'd' ? 'NEGATIVE_DEMAND' : 'NON_NEGATIVE_VIOLATION',
          `${name}[${i}] = ${value} is negative`,
          { i, value },
        );
      }
    });
  }
}

function checkProductivity(A: number[][], L: number[][]): {
  rho: number;
  hawkins: boolean;
} {
  const rho = spectralRadius(A);
  const hawkins = hawkinsSimon(L);
  if (rho >= 1 - 1e-9 || !hawkins) {
    throw new AppError(
      'NOT_PRODUCTIVE',
      `economy is not productive: rho(A)=${rho.toPrecision(6)}, hawkinsSimon=${hawkins}`,
      { spectralRadius: rho, hawkinsSimon: hawkins },
    );
  }
  return { rho, hawkins };
}

export function decomposeRounds(x: number[], A: number[][], d: number[], maxRounds: number): RoundDecomposition {
  const n = d.length;
  const rounds: number[][] = [d.slice()];
  let current = d.slice();
  for (let k = 1; k <= maxRounds; k++) {
    current = matVec(A, current);
    rounds.push(current.slice());
  }
  const listedSum = rounds.reduce((acc, r) => vecAdd(acc, r), zeros(n));
  // Exact remainder — never "truncate into validity": the tail is computed from
  // the exact solution so truncated rounds + remainder reconcile exactly.
  const remainder = vecSub(x, listedSum);
  const reconstructed = vecAdd(listedSum, remainder);
  const reconciliationResidualInf = normInf(vecSub(reconstructed, x));
  return { rounds, remainder, reconstructed, reconciliationResidualInf };
}

export function solveModel(input: EconomyInput, options: SolveOptions = {}): SolveReport {
  validateEconomy(input);
  const { sectors, A, d, v, eDirect } = input;
  const n = sectors.length;
  const maxRounds = options.maxRounds ?? 12;
  const illThreshold = options.illConditionedThreshold ?? 1e10;

  // Snap tiny negative noise that validation tolerates (-EPS..0) to zero,
  // but never alter genuine negative coefficients: validateEconomy rejects those.
  const cleanA = A.map((row) => row.map((value) => (value < 0 && value >= -EPS ? 0 : value)));

  const L = leontiefMatrix(cleanA);
  const { rho, hawkins } = checkProductivity(cleanA, L);

  let x: number[];
  try {
    x = solveLinear(L, d);
  } catch (err) {
    throw new AppError(
      'SINGULAR_MATRIX',
      `Leontief matrix is singular to working precision: ${(err as Error).message}`,
    );
  }

  const LT = transpose(L);
  const prices = solveLinear(LT, v);
  const embodiedIntensity = solveLinear(LT, eDirect);

  const intermediate = matVec(cleanA, x);
  const residual = vecSub(vecSub(x, intermediate), d);
  const residualInf = normInf(residual);
  const scale = Math.max(normInf(x), normInf(d), 1);
  const relativeResidualInf = residualInf / scale;

  let kappa: number;
  try {
    kappa = conditionNumberInf(L);
  } catch {
    kappa = Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(kappa)) {
    throw new AppError('SINGULAR_MATRIX', 'Leontief matrix inverse does not exist');
  }
  const illConditioned = kappa > illThreshold;

  const rounds = decomposeRounds(x, cleanA, d, maxRounds);

  const valueAdded = v.map((vi, i) => vi * x[i]!);
  const directBySector = eDirect.map((ei, i) => ei * x[i]!);
  const embodiedByDemandSector = embodiedIntensity.map((ci, i) => ci * d[i]!);

  const emissionRounds = rounds.rounds.map((r) => r.map((rk, i) => eDirect[i]! * rk));
  const emissionRemainder = rounds.remainder.map((rk, i) => eDirect[i]! * rk);

  const directTotal = directBySector.reduce((s, z) => s + z, 0);
  const embodiedTotal = embodiedByDemandSector.reduce((s, z) => s + z, 0);

  const columnSums = cleanA.reduce((acc, row) => acc.map((s, j) => s + row[j]!), zeros(n));
  const rowSums = cleanA.map((row) => row.reduce((s, z) => s + z, 0));

  const now = options.now ?? (() => new Date());

  return {
    sectors,
    A: cleanA,
    d: d.slice(),
    v: v.slice(),
    eDirect: eDirect.slice(),
    x,
    intermediate,
    valueAdded,
    valueAddedTotal: valueAdded.reduce((s, z) => s + z, 0),
    finalDemandTotal: d.reduce((s, z) => s + z, 0),
    grossOutputTotal: x.reduce((s, z) => s + z, 0),
    prices,
    rounds,
    emissions: {
      directBySector,
      directTotal,
      embodiedIntensity,
      embodiedByDemandSector,
      embodiedTotal,
      emissionRounds,
      emissionRemainder,
      accountingGap: directTotal - embodiedTotal,
    },
    diagnostics: {
      residualInf,
      relativeResidualInf,
      conditionNumberInf: kappa,
      spectralRadiusA: rho,
      columnSums,
      rowSums,
      hawkinsSimon: hawkins,
      illConditioned,
      illConditionedThreshold: illThreshold,
    },
    solvedAt: now().toISOString(),
  };
}

/**
 * Apply a demand delta on the SAME frozen technology matrix.
 * Throws if any final-demand component would become negative; the model
 * never produces "effective" results by clipping negative demand.
 */
export function applyDemandShock(
  base: SolveReport,
  delta: number[],
  options: SolveOptions = {},
): { shocked: SolveReport; deltaX: number[]; deltaVA: number[]; deltaEmissionsTotal: number } {
  const n = base.sectors.length;
  if (!Array.isArray(delta) || delta.length !== n) {
    throw new AppError('VALIDATION', `demand delta must be an array of length ${n}`);
  }
  const d2 = base.d.map((di, i) => {
    const change = delta[i]!;
    if (typeof change !== 'number' || !Number.isFinite(change)) {
      throw new AppError('VALIDATION', `delta[${i}] must be a finite number`);
    }
    const next = di + change;
    if (next < -EPS) {
      throw new AppError(
        'NEGATIVE_DEMAND',
        `demand for sector ${base.sectors[i]} would become ${next}; final demand cannot go negative`,
        { sector: base.sectors[i], current: di, delta: change, resulting: next },
      );
    }
    return Math.max(0, next);
  });
  const shocked = solveModel(
    { sectors: base.sectors, A: base.A, d: d2, v: base.v, eDirect: base.eDirect },
    {
      maxRounds: base.rounds.rounds.length - 1,
      illConditionedThreshold: base.diagnostics.illConditionedThreshold,
      now: options.now,
    },
  );
  return {
    shocked,
    deltaX: vecSub(shocked.x, base.x),
    deltaVA: vecSub(shocked.valueAdded, base.valueAdded),
    deltaEmissionsTotal: shocked.emissions.directTotal - base.emissions.directTotal,
  };
}

/** Analytical cross-check helpers used by tests. */
export const _internals = { identityMatrix, scaleVec, zeros };
