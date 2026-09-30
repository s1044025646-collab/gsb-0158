import type { DatabaseSync } from 'node:sqlite';
import { AppError, type ErrorCode } from './errors.ts';
import {
  applyDemandShock,
  solveModel,
  validateEconomy,
  type EconomyInput,
  type SolveOptions,
  type SolveReport,
} from './model.ts';
import { Repository, json, type ReportRow } from './db.ts';

export interface ImportPayload {
  sectors: Array<{ id: string; name?: string; unit?: string }>;
  /** Row-major technical coefficients keyed by sector id: A[i][j]. */
  rows?: Array<{ from: string; to?: string; values?: number[]; row?: number[] }>;
  /** Alternative full matrix form keyed by sector order: matrix[i][j]. */
  matrix?: number[][];
  finalDemand: number[] | Record<string, number>;
  valueAdded: number[] | Record<string, number>;
  directEmissions: number[] | Record<string, number>;
  scenarioName: string;
  note?: string;
  label?: string;
}

export interface PageParams {
  limit: number;
  offset: number;
}

export function paginate(query: URLSearchParams): PageParams {
  const limitRaw = Number(query.get('limit') ?? '50');
  const offsetRaw = Number(query.get('offset') ?? '0');
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 500) {
    throw new AppError('VALIDATION', 'limit must be an integer between 1 and 500');
  }
  if (!Number.isInteger(offsetRaw) || offsetRaw < 0) {
    throw new AppError('VALIDATION', 'offset must be a non-negative integer');
  }
  return { limit: limitRaw, offset: offsetRaw };
}

function vectorBySectors(value: number[] | Record<string, number>, sectors: string[], name: string): number[] {
  if (Array.isArray(value)) {
    if (value.length !== sectors.length) {
      throw new AppError('SECTOR_MISMATCH', `${name} length ${value.length} != sectors ${sectors.length}`);
    }
    return value.slice();
  }
  return sectors.map((id) => {
    const v = value[id];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new AppError('SECTOR_MISMATCH', `${name} missing sector: ${id}`);
    }
    return v;
  });
}

export class EconomyService {
  readonly repo: Repository;

  constructor(
    readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.repo = new Repository(db);
  }

  importScenario(payload: ImportPayload, options: SolveOptions = {}): {
    scenarioId: number;
    baseReportId: number;
    report: SolveReport;
  } {
    const sectorIds = payload.sectors.map((s) => s.id);
    if (sectorIds.length === 0) throw new AppError('VALIDATION', 'at least one sector required');
    const n = sectorIds.length;

    let A: number[][];
    if (payload.matrix) {
      A = payload.matrix.map((r) => r.slice());
    } else {
      const byId = new Map<string, number[]>();
      for (const r of payload.rows ?? []) {
        byId.set(r.from, (r.values ?? r.row ?? []).slice());
      }
      A = sectorIds.map((id) => {
        const row = byId.get(id);
        if (!row) throw new AppError('SECTOR_MISMATCH', `matrix row missing for sector: ${id}`);
        if (row.length !== n) {
          throw new AppError('SECTOR_MISMATCH', `row ${id} length ${row.length} != sectors ${n}`);
        }
        return row;
      });
    }

    const d = vectorBySectors(payload.finalDemand, sectorIds, 'finalDemand');
    const v = vectorBySectors(payload.valueAdded, sectorIds, 'valueAdded');
    const e = vectorBySectors(payload.directEmissions, sectorIds, 'directEmissions');

    const input: EconomyInput = { sectors: sectorIds, A, d, v, eDirect: e };
    validateEconomy(input);

    return this.repo.transaction(() => {
      for (const s of payload.sectors) {
        this.repo.upsertSector(s.id, s.name ?? s.id, s.unit ?? 'unit', this.now);
      }
      const scenarioId = this.repo.createScenario(
        payload.scenarioName,
        sectorIds,
        payload.note ?? '',
        this.now,
      );
      const report = solveModel(input, { now: this.now, ...options });
      const baseReportId = this.repo.saveReport(
        scenarioId,
        payload.label ?? 'baseline',
        report,
        this.now,
      );
      return { scenarioId, baseReportId, report };
    });
  }

  loadBaselineReport(reportId: number): { scenarioId: number; base: SolveReport } {
    const row = this.repo.getReport(reportId);
    if (!row) throw new AppError('NOT_FOUND', `report not found: ${reportId}`);
    const base = json.parse<SolveReport>(row.report_json);
    return { scenarioId: row.scenario_id, base };
  }

  shock(
    baseReportId: number,
    delta: number[] | Record<string, number>,
    label: string,
    idempotencyKey: string | null = null,
  ): {
    shockId: number;
    shockedReportId: number;
    base: SolveReport;
    shocked: SolveReport;
    deltaX: number[];
    deltaVA: number[];
    deltaEmissionsTotal: number;
    replayed: boolean;
  } {
    if (idempotencyKey) {
      const existing = this.repo.findShockByIdempotencyKey(idempotencyKey);
      if (existing) {
        const shockedRow = this.repo.getReport(existing.shocked_report_id)!;
        const baseRow = this.repo.getReport(existing.base_report_id)!;
        return {
          shockId: existing.id,
          shockedReportId: existing.shocked_report_id,
          base: json.parse<SolveReport>(baseRow.report_json),
          shocked: json.parse<SolveReport>(shockedRow.report_json),
          deltaX: json.parse<number[]>(existing.delta_x_json),
          deltaVA: json.parse<number[]>(existing.delta_va_json),
          deltaEmissionsTotal: existing.delta_emissions_total,
          replayed: true,
        };
      }
    }

    const { scenarioId, base } = this.loadBaselineReport(baseReportId);
    const deltaVec = vectorBySectors(delta, base.sectors, 'delta');
    const result = applyDemandShock(base, deltaVec, { now: this.now });

    const persisted = this.repo.transaction(() => {
      const shockedReportId = this.repo.saveReport(
        scenarioId,
        label,
        result.shocked,
        this.now,
        deltaVec,
      );
      const shockId = this.repo.saveShock(
        {
          base_report_id: baseReportId,
          scenario_id: scenarioId,
          label,
          delta_json: json.stringify(deltaVec),
          shocked_report_id: shockedReportId,
          delta_x_json: json.stringify(result.deltaX),
          delta_va_json: json.stringify(result.deltaVA),
          delta_emissions_total: result.deltaEmissionsTotal,
          idempotency_key: idempotencyKey,
        },
        this.now,
      );
      return { shockId, shockedReportId };
    });

    return {
      shockId: persisted.shockId,
      shockedReportId: persisted.shockedReportId,
      base,
      shocked: result.shocked,
      deltaX: result.deltaX,
      deltaVA: result.deltaVA,
      deltaEmissionsTotal: result.deltaEmissionsTotal,
      replayed: false,
    };
  }

 getReport(reportId: number): ReportRow {
    const row = this.repo.getReport(reportId);
    if (!row) throw new AppError('NOT_FOUND', `report not found: ${reportId}`);
    return row;
  }
}

export function toApiError(err: unknown): { status: number; code: ErrorCode; message: string; details?: unknown } {
  if (err instanceof AppError) {
    return { status: err.httpStatus, code: err.code, message: err.message, details: err.details };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, code: 'PERSISTENCE', message };
}
