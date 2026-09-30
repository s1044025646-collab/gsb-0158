import type { ImportPayload } from './service.ts';
import type { EconomyInput } from './model.ts';

export function fixtureEconomy(payload: ImportPayload): EconomyInput {
  if (!payload.matrix) throw new Error('built-in fixtures use matrix form');
  return {
    sectors: payload.sectors.map((s) => s.id),
    A: payload.matrix.map((r) => r.slice()),
    d: payload.finalDemand as number[],
    v: payload.valueAdded as number[],
    eDirect: payload.directEmissions as number[],
  };
}

// All figures below are FICTITIOUS, unit-consistent teaching data.
// A[i][j]: units of sector i consumed per unit of sector j output.

export const twoSectorFixture: ImportPayload = {
  scenarioName: 'fixture-two-sector',
  note: 'Analytic two-sector example: agriculture and manufacturing',
  sectors: [
    { id: 'AG', name: 'Agriculture', unit: 'tonne' },
    { id: 'MF', name: 'Manufacturing', unit: 'piece' },
  ],
  matrix: [
    [0.1, 0.2],
    [0.3, 0.4],
  ],
  finalDemand: [100, 200],
  // Value-added coefficients satisfy column consistency: v_j = 1 - sum_i A[i][j]
  // (column 0: 1 - 0.1 - 0.3 = 0.6; column 1: 1 - 0.2 - 0.4 = 0.4).
  valueAdded: [0.6, 0.4],
  directEmissions: [2, 5],
};

export const noIntermediateFixture: ImportPayload = {
  scenarioName: 'fixture-no-intermediate',
  note: 'No intermediate inputs: A = 0, x = d exactly',
  sectors: [
    { id: 'S1', name: 'Services A', unit: 'hour' },
    { id: 'S2', name: 'Services B', unit: 'hour' },
    { id: 'S3', name: 'Services C', unit: 'hour' },
  ],
  matrix: [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ],
  finalDemand: [10, 20, 30],
  valueAdded: [1, 1, 1],
  directEmissions: [0.1, 0.2, 0.3],
};

export const stronglyCircularFixture: ImportPayload = {
  scenarioName: 'fixture-strong-circular',
  note: 'Dense circular flows; column sums high but strictly below 1',
  sectors: [
    { id: 'E', name: 'Energy', unit: 'TJ' },
    { id: 'M', name: 'Materials', unit: 'tonne' },
    { id: 'T', name: 'Transport', unit: 'tonne-km' },
  ],
  matrix: [
    [0.3, 0.25, 0.2],
    [0.25, 0.3, 0.2],
    [0.2, 0.2, 0.3],
  ],
  finalDemand: [50, 60, 70],
  valueAdded: [0.25, 0.25, 0.3],
  directEmissions: [8, 3, 4],
};

// Unproductive: column 0 sums to 1.05 => rho(A) > 1. Import MUST fail;
// CLI/API report NOT_PRODUCTIVE and the transaction rolls back.
export const unproductiveFixture: ImportPayload = {
  scenarioName: 'fixture-unproductive',
  note: 'Intentionally unproductive matrix for failure-path tests',
  sectors: [
    { id: 'X', name: 'X', unit: 'u' },
    { id: 'Y', name: 'Y', unit: 'u' },
  ],
  matrix: [
    [0.6, 0.55],
    [0.45, 0.5],
  ],
  finalDemand: [10, 10],
  valueAdded: [0.1, 0.1],
  directEmissions: [1, 1],
};

// Near-singular but still productive: I - A has a small eigenvalue.
// A = a * ones(2) with a just under 0.5 => eigenvalues 2a (small gap to 1) and 0.
export const nearSingularFixture: ImportPayload = {
  scenarioName: 'fixture-near-singular',
  note: 'Nearly singular Leontief matrix: condition diagnostics must be reported',
  sectors: [
    { id: 'N1', name: 'Near One', unit: 'u' },
    { id: 'N2', name: 'Near Two', unit: 'u' },
  ],
  matrix: [
    [0.4999999, 0.4999999],
    [0.4999999, 0.4999999],
  ],
  finalDemand: [100, 100],
  valueAdded: [0.0000002, 0.0000002],
  directEmissions: [1, 1],
};

// Same economy as twoSectorFixture but with reversed sector order;
// results must be invariant after reordering (permutation test).
export const reversedTwoSectorFixture: ImportPayload = {
  scenarioName: 'fixture-two-sector-reversed',
  note: 'Sector order reversed vs fixture-two-sector',
  sectors: [
    { id: 'MF', name: 'Manufacturing', unit: 'piece' },
    { id: 'AG', name: 'Agriculture', unit: 'tonne' },
  ],
  matrix: [
    // Original A rows/cols in order [AG,MF]: [[0.1,0.2],[0.3,0.4]].
    // Permuted to order [MF,AG] (row = input source, column = producer recipe).
    [0.4, 0.3],
    [0.2, 0.1],
  ],
  finalDemand: [200, 100],
  valueAdded: [0.4, 0.6],
  directEmissions: [5, 2],
};

export const fixtures: Record<string, ImportPayload> = {
  'two-sector': twoSectorFixture,
  'no-intermediate': noIntermediateFixture,
  'strong-circular': stronglyCircularFixture,
  unproductive: unproductiveFixture,
  'near-singular': nearSingularFixture,
  'two-sector-reversed': reversedTwoSectorFixture,
};
