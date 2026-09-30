import { DatabaseSync } from "node:sqlite";
import { Matrix, Vector } from "./linalg.js";
import { Clock, defaultClock } from "./db/db.js";

export interface Sector {
  id: number;
  code: string;
  name: string;
  unit: string;
  created_at: string;
}

export interface Scenario {
  id: number;
  key: string;
  version: number;
  title: string;
  note: string | null;
  sectorCodes: string[];
  A: Matrix;
  demand: Vector;
  valueAdded: Vector;
  directEmission: Vector;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface Report {
  id: number;
  scenarioId: number;
  kind: string;
  clientRequestId: string | null;
  payload: unknown;
  createdAt: string;
}

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  total: number;
}

function parseScenarioRow(r: Record<string, unknown>): Scenario {
  return {
    id: Number(r.id),
    key: String(r.key),
    version: Number(r.version),
    title: String(r.title),
    note: r.note == null ? null : String(r.note),
    sectorCodes: JSON.parse(String(r.sector_codes)) as string[],
    A: JSON.parse(String(r.matrix_a)) as Matrix,
    demand: JSON.parse(String(r.demand)) as Vector,
    valueAdded: JSON.parse(String(r.value_added)) as Vector,
    directEmission: JSON.parse(String(r.direct_emission)) as Vector,
    idempotencyKey: r.idempotency_key == null ? null : String(r.idempotency_key),
    createdAt: String(r.created_at),
  };
}

function parseReportRow(r: Record<string, unknown>): Report {
  return {
    id: Number(r.id),
    scenarioId: Number(r.scenario_id),
    kind: String(r.kind),
    clientRequestId: r.client_request_id == null ? null : String(r.client_request_id),
    payload: JSON.parse(String(r.payload)),
    createdAt: String(r.created_at),
  };
}

export class Repository {
  constructor(
    private db: DatabaseSync,
    private clock: Clock = defaultClock,
  ) {}

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---------- sectors ----------
  upsertSector(code: string, name: string, unit: string): void {
    const stmt = this.db.prepare(
      `INSERT INTO sectors(code, name, unit, created_at)
       VALUES(?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, unit=excluded.unit`,
    );
    stmt.run(code, name, unit, this.clock.now().toISOString());
  }

  listSectors(): Sector[] {
    return (this.db.prepare("SELECT * FROM sectors ORDER BY id ASC").all() as Record<string, unknown>[]).map(
      (r) => ({
        id: Number(r.id),
        code: String(r.code),
        name: String(r.name),
        unit: String(r.unit),
        created_at: String(r.created_at),
      }),
    );
  }

  sectorCodesSet(): Set<string> {
    return new Set(this.listSectors().map((s) => s.code));
  }

  // ---------- scenarios ----------
  findByIdempotency(key: string): Scenario | null {
    const r = this.db
      .prepare("SELECT * FROM scenarios WHERE idempotency_key = ?")
      .get(key) as Record<string, unknown> | undefined;
    return r ? parseScenarioRow(r) : null;
  }

  latestVersion(key: string): number {
    const r = this.db
      .prepare("SELECT COALESCE(MAX(version),0) AS v FROM scenarios WHERE key = ?")
      .get(key) as { v: number | bigint };
    return Number(r.v);
  }

  insertScenario(input: {
    key: string;
    title: string;
    note?: string | null;
    sectorCodes: string[];
    A: Matrix;
    demand: Vector;
    valueAdded: Vector;
    directEmission: Vector;
    idempotencyKey?: string | null;
  }): Scenario {
    const version = this.latestVersion(input.key) + 1;
    const stmt = this.db.prepare(
      `INSERT INTO scenarios
        (key, version, title, note, sector_codes, matrix_a, demand, value_added, direct_emission, idempotency_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const info = stmt.run(
      input.key,
      version,
      input.title,
      input.note ?? null,
      JSON.stringify(input.sectorCodes),
      JSON.stringify(input.A),
      JSON.stringify(input.demand),
      JSON.stringify(input.valueAdded),
      JSON.stringify(input.directEmission),
      input.idempotencyKey ?? null,
      this.clock.now().toISOString(),
    );
    return this.getScenario(Number(info.lastInsertRowid))!;
  }

  getScenario(id: number): Scenario | null {
    const r = this.db.prepare("SELECT * FROM scenarios WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? parseScenarioRow(r) : null;
  }

  getScenarioVersion(key: string, version: number): Scenario | null {
    const r = this.db
      .prepare("SELECT * FROM scenarios WHERE key = ? AND version = ?")
      .get(key, version) as Record<string, unknown> | undefined;
    return r ? parseScenarioRow(r) : null;
  }

  listScenarios(limit: number, offset: number, key?: string): Page<Scenario> {
    const where = key ? "WHERE key = ?" : "";
    const args = key ? [key] : [];
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS c FROM scenarios ${where}`).get(...args) as { c: number | bigint }).c,
    );
    const rows = this.db
      .prepare(`SELECT * FROM scenarios ${where} ORDER BY key ASC, version ASC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as Record<string, unknown>[];
    return { items: rows.map(parseScenarioRow), limit, offset, total };
  }

  // ---------- reports ----------
  findReportByRequestId(clientRequestId: string): Report | null {
    const r = this.db
      .prepare("SELECT * FROM reports WHERE client_request_id = ?")
      .get(clientRequestId) as Record<string, unknown> | undefined;
    return r ? parseReportRow(r) : null;
  }

  insertReport(input: {
    scenarioId: number;
    kind: string;
    clientRequestId?: string | null;
    payload: unknown;
  }): Report {
    const stmt = this.db.prepare(
      `INSERT INTO reports(scenario_id, kind, client_request_id, payload, created_at)
       VALUES (?,?,?,?,?)`,
    );
    const info = stmt.run(
      input.scenarioId,
      input.kind,
      input.clientRequestId ?? null,
      JSON.stringify(input.payload),
      this.clock.now().toISOString(),
    );
    const r = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(Number(info.lastInsertRowid)) as
      | Record<string, unknown>
      | undefined;
    return parseReportRow(r!);
  }

  listReports(limit: number, offset: number, scenarioId?: number): Page<Report> {
    const where = scenarioId != null ? "WHERE scenario_id = ?" : "";
    const args = scenarioId != null ? [scenarioId] : [];
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS c FROM reports ${where}`).get(...args) as { c: number | bigint }).c,
    );
    const rows = this.db
      .prepare(`SELECT * FROM reports ${where} ORDER BY id ASC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as Record<string, unknown>[];
    return { items: rows.map(parseReportRow), limit, offset, total };
  }
}
