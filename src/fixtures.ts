/**
 * 虚构经济部门数据（不连接任何真实数据库）。
 * 提供多个用于演示与测试的装置：
 * - twoSectorAnalytic：两部门、手算可核验的解析例。
 * - noIntermediate：无中间投入（A=0）。
 * - stronglyCyclicProductive：强循环但列和<1、可生产。
 * - unproductive：ρ(A)>=1，不可生产。
 * - nearSingular：I-A 近奇异（条件数大）。
 * 同时提供“部门顺序变更”排列工具。
 */
import { Matrix, Vector } from "./linalg.js";

export interface SectorMeta {
  code: string;
  name: string;
  unit: string;
}

export interface Fixture {
  sectors: SectorMeta[];
  A: Matrix;
  demand: Vector;
  valueAdded: Vector;
  directEmission: Vector;
}

/**
 * 两部门解析例（行=投入来源，列=生产部门）：
 *   A = [[0.2, 0.3],[0.1, 0.1]]
 *   I-A = [[0.8,-0.3],[-0.1,0.9]], det = 0.72-0.03=0.69
 *   L = 1/0.69 [[0.9,0.3],[0.1,0.8]]
 *   d=[10;20]
 *   x = 1/0.69 [0.9*10+0.3*20; 0.1*10+0.8*20]
 *     = 1/0.69 [15;17] = [21.7391;24.6377]
 */
export const twoSectorAnalytic: Fixture = {
  sectors: [
    { code: "AGR", name: "农业", unit: "万元" },
    { code: "MFG", name: "制造业", unit: "万元" },
  ],
  A: [
    [0.2, 0.3],
    [0.1, 0.1],
  ],
  demand: [10, 20],
  valueAdded: [0.7, 0.6],
  directEmission: [0.5, 1.2],
};

export const noIntermediate: Fixture = {
  sectors: [
    { code: "S1", name: "部门一", unit: "万元" },
    { code: "S2", name: "部门二", unit: "万元" },
  ],
  A: [
    [0, 0],
    [0, 0],
  ],
  demand: [5, 7],
  valueAdded: [1, 1],
  directEmission: [0.2, 0.4],
};

/** 强循环（每个部门都大量互相消耗），但列和 0.9<1，仍可生产。 */
export const stronglyCyclicProductive: Fixture = {
  sectors: [
    { code: "E", name: "能源", unit: "万元" },
    { code: "T", name: "运输", unit: "万元" },
    { code: "M", name: "材料", unit: "万元" },
  ],
  A: [
    [0.3, 0.3, 0.3],
    [0.3, 0.3, 0.3],
    [0.3, 0.3, 0.3],
  ],
  demand: [1, 1, 1],
  valueAdded: [0.1, 0.1, 0.1],
  directEmission: [2, 0.5, 1],
};

/** 不可生产：列和 1.2>1，ρ(A)>1。 */
export const unproductive: Fixture = {
  sectors: [
    { code: "U1", name: "失衡一", unit: "万元" },
    { code: "U2", name: "失衡二", unit: "万元" },
  ],
  A: [
    [0.6, 0.6],
    [0.6, 0.6],
  ],
  demand: [1, 1],
  valueAdded: [0.1, 0.1],
  directEmission: [1, 1],
};

/**
 * 近奇异：I-A 对角接近 0.01，条件数很大但仍可逆、可生产。
 * I-A=diag(1e-9,0.5)，κ≈5e8（超过病态阈值 1e8），谱半径 0.999999999<1 仍可生产。
 */
export const nearSingular: Fixture = {
  sectors: [
    { code: "N1", name: "近奇异一", unit: "万元" },
    { code: "N2", name: "近奇异二", unit: "万元" },
  ],
  A: [
    [0.999999999, 0],
    [0, 0.5],
  ],
  demand: [1, 1],
  valueAdded: [0.000000001, 0.5],
  directEmission: [0.3, 0.3],
};

/** 按新顺序（部门代码数组）对部门向量与 A 的行列同步重排。 */
export function reorderFixture(f: Fixture, newOrder: string[]): Fixture {
  const idx = newOrder.map((c) => {
    const i = f.sectors.findIndex((s) => s.code === c);
    if (i < 0) throw new Error(`未知部门 ${c}`);
    return i;
  });
  const perm = <T>(v: T[]): T[] => idx.map((i) => v[i]!);
  const A2: Matrix = idx.map((i) => perm(f.A[i]!));
  return {
    sectors: perm(f.sectors),
    A: A2,
    demand: perm(f.demand),
    valueAdded: perm(f.valueAdded),
    directEmission: perm(f.directEmission),
  };
}

export const ALL_FIXTURES: Record<string, Fixture> = {
  two: twoSectorAnalytic,
  none: noIntermediate,
  cyclic: stronglyCyclicProductive,
  unproductive,
  singular: nearSingular,
};
