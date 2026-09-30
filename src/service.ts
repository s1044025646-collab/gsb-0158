import { Matrix, Vector } from "./linalg.js";
import {
  compareShocks,
  ModelError,
  roundDecomposition,
  solve,
  SolveResult,
} from "./model.js";
import { AppError, Repository, Scenario } from "./repo.js";

export interface ImportInput {
  key: string;
  title: string;
  note?: string | null;
  /** 部门代码，给定 A 的行/列顺序（行 i 供给部门，列 j 生产部门）。 */
  sectorCodes: string[];
  matrixA: Matrix;
  demand: Vector;
  valueAdded: Vector;
  directEmission: Vector;
  idempotencyKey?: string | null;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function asVector(v: unknown, name: string): Vector {
  if (!Array.isArray(v)) throw new AppError(400, "VALIDATION_ERROR", `${name} 必须为数组`);
  if (!v.every((x) => isNum(x)))
    throw new AppError(400, "VALIDATION_ERROR", `${name} 必须全部为有限数值`);
  return v as Vector;
}

function asMatrix(v: unknown, name: string): Matrix {
  if (!Array.isArray(v) || !v.every((r) => Array.isArray(r)))
    throw new AppError(400, "VALIDATION_ERROR", `${name} 必须为二维数组`);
  const n = v.length;
  for (const row of v) {
    if (row.length !== n)
      throw new AppError(400, "VALIDATION_ERROR", `${name} 必须为方阵（发现行列数不一致）`);
    if (!row.every((x) => isNum(x)))
      throw new AppError(400, "VALIDATION_ERROR", `${name} 必须全部为有限数值`);
  }
  return v as Matrix;
}

export class IoService {
  constructor(private repo: Repository) {}

  /** 登记部门主数据（代码/名称/单位口径）。重复代码更新名称与单位。 */
  registerSectors(sectors: { code: string; name: string; unit: string }[]): { count: number } {
    if (!Array.isArray(sectors) || sectors.length === 0)
      throw new AppError(400, "VALIDATION_ERROR", "sectors 必须为非空数组");
    for (const s of sectors) {
      if (typeof s.code !== "string" || s.code.trim() === "")
        throw new AppError(400, "VALIDATION_ERROR", "部门 code 必须为非空字符串");
      if (typeof s.name !== "string" || s.name.trim() === "")
        throw new AppError(400, "VALIDATION_ERROR", `部门 ${s.code} 的 name 非法`);
      if (typeof s.unit !== "string" || s.unit.trim() === "")
        throw new AppError(400, "VALIDATION_ERROR", `部门 ${s.code} 的 unit 非法`);
    }
    return this.repo.transaction(() => {
      for (const s of sectors) this.repo.upsertSector(s.code, s.name, s.unit);
      return { count: sectors.length };
    });
  }

  private validateCodes(input: ImportInput): void {
    if (typeof input.key !== "string" || input.key.trim() === "")
      throw new AppError(400, "VALIDATION_ERROR", "key 必须为非空字符串");
    if (typeof input.title !== "string" || input.title.trim() === "")
      throw new AppError(400, "VALIDATION_ERROR", "title 必须为非空字符串");
    if (!Array.isArray(input.sectorCodes) || input.sectorCodes.length === 0)
      throw new AppError(400, "VALIDATION_ERROR", "sectorCodes 必须为非空数组");
    if (new Set(input.sectorCodes).size !== input.sectorCodes.length)
      throw new AppError(400, "VALIDATION_ERROR", "sectorCodes 存在重复部门代码");
    const known = this.repo.sectorCodesSet();
    const unknown = input.sectorCodes.filter((c) => !known.has(c));
    if (unknown.length > 0)
      throw new AppError(404, "SECTOR_NOT_FOUND", `部门口径中存在未登记部门: ${unknown.join(", ")}`, {
        unknown,
      });
  }

  /** 导入/另存一个冻结方案版本。重复 idempotencyKey 返回既有方案（幂等）。 */
  importScenario(raw: ImportInput): { scenario: Scenario; replayed: boolean } {
    if (raw.idempotencyKey) {
      const existing = this.repo.findByIdempotency(raw.idempotencyKey);
      if (existing) return { scenario: existing, replayed: true };
    }
    const A = asMatrix(raw.matrixA, "matrixA");
    const demand = asVector(raw.demand, "demand");
    const valueAdded = asVector(raw.valueAdded, "valueAdded");
    const directEmission = asVector(raw.directEmission, "directEmission");
    this.validateCodes({ ...raw, matrixA: A, demand, valueAdded, directEmission });
    const n = raw.sectorCodes.length;
    if (A.length !== n)
      throw new AppError(400, "DIMENSION_MISMATCH", `matrixA 应为 ${n}×${n}，实际 ${A.length}`);
    for (const [name, vec] of [
      ["demand", demand],
      ["valueAdded", valueAdded],
      ["directEmission", directEmission],
    ] as const)
      if (vec.length !== n)
        throw new AppError(400, "DIMENSION_MISMATCH", `${name} 长度应为 ${n}，实际 ${vec.length}`);

    // 导入即求解校验：不可生产/奇异/负系数不允许入库。
    try {
      solve({ A, demand, valueAdded, directEmission });
    } catch (err) {
      throw mapModelError(err);
    }

    const scenario = this.repo.transaction(() =>
      this.repo.insertScenario({
        key: raw.key,
        title: raw.title,
        note: raw.note ?? null,
        sectorCodes: raw.sectorCodes.slice(),
        A,
        demand,
        valueAdded,
        directEmission,
        idempotencyKey: raw.idempotencyKey ?? null,
      }),
    );
    return { scenario, replayed: false };
  }

  private mustScenario(id: number): Scenario {
    const s = this.repo.getScenario(id);
    if (!s) throw new AppError(404, "SCENARIO_NOT_FOUND", `方案 ${id} 不存在`);
    return s;
  }

  solveScenario(scenario: Scenario): SolveResult {
    try {
      return solve({
        A: scenario.A,
        demand: scenario.demand,
        valueAdded: scenario.valueAdded,
        directEmission: scenario.directEmission,
      });
    } catch (err) {
      throw mapModelError(err);
    }
  }

  /** 计算基准报告，clientRequestId 用于计算幂等。 */
  baseline(scenarioId: number, clientRequestId?: string): { report: ReturnType<Repository["insertReport"]>; replayed: boolean } {
    if (clientRequestId) {
      const cached = this.repo.findReportByRequestId(clientRequestId);
      if (cached) return { report: cached, replayed: true };
    }
    const scenario = this.mustScenario(scenarioId);
    const sol = this.solveScenario(scenario);
    const report = this.repo.insertReport({
      scenarioId,
      kind: "baseline",
      clientRequestId: clientRequestId ?? null,
      payload: {
        sectorCodes: scenario.sectorCodes,
        output: sol.x,
        prices: sol.prices,
        valueAddedBySector: sol.valueAddedBySector,
        valueAddedTotal: sol.valueAddedTotal,
        emissions: sol.emissions,
        residual: sol.residual,
        residualNormInf: sol.residualNormInf,
        diagnostics: sol.diagnostics,
      },
    });
    return { report, replayed: false };
  }

  /**
   * 施加需求增减。新需求逐项 = baseline + delta，不得为负。
   * 生成同 key 新版本但完整复制旧技术矩阵 A、增加值、排放（冻结技术），
   * 旧方案与其结果保持不变（历史版本隔离）。
   */
  shock(
    baselineId: number,
    delta: Vector,
    clientRequestId?: string,
    maxRounds = 12,
  ): { report: ReturnType<Repository["insertReport"]>; shockedScenario: Scenario; replayed: boolean } {
    if (clientRequestId) {
      const cached = this.repo.findReportByRequestId(clientRequestId);
      if (cached) {
        const shockedId = (cached.payload as { shockedScenarioId?: number }).shockedScenarioId;
        return {
          report: cached,
          shockedScenario: this.mustScenario(Number(shockedId)),
          replayed: true,
        };
      }
    }
    const d = asVector(delta, "delta");
    const base = this.mustScenario(baselineId);
    if (d.length !== base.demand.length)
      throw new AppError(400, "DIMENSION_MISMATCH", `delta 长度应为 ${base.demand.length}`);
    const newDemand = base.demand.map((v, i) => v + d[i]!);
    if (newDemand.some((v) => v < 0))
      throw new AppError(
        422,
        "NEGATIVE_DEMAND",
        "冲击后最终需求出现负值；需求不得减至负值",
        { newDemand },
      );

    const baseSol = this.solveScenario(base);

    const shocked = this.repo.transaction(() =>
      this.repo.insertScenario({
        key: base.key,
        title: `${base.title} @ shock`,
        note: `demand shock from scenario #${base.id}`,
        sectorCodes: base.sectorCodes.slice(),
        A: base.A.map((r) => r.slice()),
        demand: newDemand,
        valueAdded: base.valueAdded.slice(),
        directEmission: base.directEmission.slice(),
      }),
    );
    const shockSol = this.solveScenario(shocked);
    const cmp = compareShocks(baseSol, shockSol, base.demand, newDemand, base.A, shocked.A);
    const decomp = roundDecomposition(base.A, shockSol.leontiefInverse, newDemand, maxRounds);

    const report = this.repo.insertReport({
      scenarioId: shocked.id,
      kind: "shock",
      clientRequestId: clientRequestId ?? null,
      payload: {
        baselineScenarioId: base.id,
        shockedScenarioId: shocked.id,
        sectorCodes: base.sectorCodes,
        baselineDemand: base.demand,
        shockedDemand: newDemand,
        deltaDemand: cmp.deltaDemand,
        baselineOutput: baseSol.x,
        shockedOutput: shockSol.x,
        deltaOutput: cmp.deltaOutput,
        deltaValueAddedBySector: cmp.deltaValueAddedBySector,
        deltaValueAddedTotal: cmp.deltaValueAddedTotal,
        baselineDirectEmissionTotal: baseSol.emissions.directTotal,
        shockedDirectEmissionTotal: shockSol.emissions.directTotal,
        deltaDirectEmissionTotal: cmp.deltaDirectEmissionTotal,
        directEmissionBySectorBaseline: baseSol.emissions.directBySector,
        directEmissionBySectorShocked: shockSol.emissions.directBySector,
        rounds: decomp.rounds,
        truncated: decomp.truncated,
        remainder: decomp.remainder,
        remainderNormInf: decomp.remainderNormInf,
        sameFrozenA: cmp.sameFrozenA,
        caveat:
          "固定系数静态比较：结果仅在同一冻结技术矩阵下成立，不构成真实市场的因果或时序预测。",
        diagnostics: shockSol.diagnostics,
        residualNormInf: shockSol.residualNormInf,
      },
    });
    return { report, shockedScenario: shocked, replayed: false };
  }

  /** 排放供应链账表（直接 + 各轮间接隐含，余项与精确解对账）。 */
  emissionLedger(scenarioId: number, maxRounds = 12): {
    sectorCodes: string[];
    rounds: { round: number; directOutput: Vector; directEmission: number; cumulativeEmission: number }[];
    truncatedEmissionTotal: number;
    exactEmissionTotal: number;
    remainderEmissionTotal: number;
    totalIntensity: Vector;
  } {
    const s = this.mustScenario(scenarioId);
    const sol = this.solveScenario(s);
    const decomp = roundDecomposition(s.A, sol.leontiefInverse, s.demand, maxRounds);
    let cumulative = 0;
    const rounds = decomp.rounds.map((r, k) => {
      const em = r.reduce((sum, xi, j) => sum + s.directEmission[j]! * xi, 0);
      cumulative += em;
      return { round: k, directOutput: r, directEmission: em, cumulativeEmission: cumulative };
    });
    const remainderEmissionTotal = sol.emissions.directTotal - cumulative;
    return {
      sectorCodes: s.sectorCodes,
      rounds,
      truncatedEmissionTotal: cumulative,
      exactEmissionTotal: sol.emissions.directTotal,
      remainderEmissionTotal,
      totalIntensity: sol.emissions.totalIntensity,
    };
  }
}

export function mapModelError(err: unknown): AppError {
  if (err instanceof ModelError) {
    const status: Record<ModelError["code"], number> = {
      NEGATIVE_COEFFICIENT: 422,
      NON_SQUARE: 400,
      DIMENSION_MISMATCH: 400,
      SINGULAR_MATRIX: 422,
      NOT_PRODUCTIVE: 422,
      NEGATIVE_OUTPUT: 422,
      NEGATIVE_DEMAND: 422,
    };
    return new AppError(status[err.code], err.code, err.message, err.detail);
  }
  if (err instanceof AppError) return err;
  const e = err as Error;
  return new AppError(500, "INTERNAL_ERROR", e.message);
}
