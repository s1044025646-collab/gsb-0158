import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './errors.ts';
import type { SolveReport } from './model.ts';

export interface SectorRow {
  id: string;
  name: string;
  unit: string;
  created_at: string;
}

export interface ScenarioRow {
  id: number;
  name: string;
  note: string;
  parent_scenario_id: number | null;
  sectors_json: string;
  created_at: string;
}

export interface ReportRow {
  id: number;
  scenario_id: number;
  label: string;
  demand_json: string;
  delta_json: string | null;
  report_json: string;
  created_at: string;
}

export interface ShockRow {
  id: number;
  base_report_id: number;
  scenario_id: number;
  label: string;
  delta_json: string;
  shocked_report_id: number;
  delta_x_json: string;
  delta_va_json: string;
  delta_emissions_total: number;
  idempotency_key: string | null;
  created_at: string;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     version INTEGER PRIMARY KEY,
     applied_at TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS sectors (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     unit TEXT NOT NULL,
     created_at TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS scenarios (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL UNIQUE,
     note TEXT NOT NULL DEFAULT '',
     parent_scenario_id INTEGER REFERENCES scenarios(id),
     sectors_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS reports (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     scenario_id INTEGER NOT NULL REFERENCES scenarios(id),
     label TEXT NOT NULL,
     demand_json TEXT NOT NULL,
     delta_json TEXT,
     report_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS shocks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     base_report_id INTEGER NOT NULL REFERENCES reports(id),
     scenario_id INTEGER NOT NULL REFERENCES scenarios(id),
     label TEXT NOT NULL,
     delta_json TEXT NOT NULL,
     shocked_report_id INTEGER NOT NULL REFERENCES reports(id),
     delta_x_json TEXT NOT NULL,
     delta_va_json TEXT NOT NULL,
     delta_emissions_total REAL NOT NULL,
     idempotency_key TEXT,
     created_at TEXT NOT NULL
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS shocks_idem_key ON shocks(idempotency_key)
     WHERE idempotency_key IS NOT NULL;`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
     key TEXT PRIMARY KEY,
     response_json TEXT NOT NULL,
     status_code INTEGER NOT NULL,
     created_at TEXT NOT NULL
   );`,
];

export function openDb(filename: string, now: () => Date = () => new Date()): DatabaseSync {
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, now);
  return db;
}

/** Idempotent migrations: safe to run repeatedly on every startup. */
export function migrate(db: DatabaseSync, now: () => Date = () => new Date()): void {
  db.exec(MIGRATIONS[0]!);
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
  const applied = new Set(appliedRows.map((r) => r.version));
  const insert = db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)');
  for (let version = 1; version < MIGRATIONS.length; version++) {
    if (applied.has(version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]!);
      insert.run(version, now().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new AppError('PERSISTENCE', `migration ${version} failed: ${(err as Error).message}`);
    }
  }
}

export const json = {
  parse: <T>(s: string): T => JSON.parse(s) as T,
  stringify: (v: unknown): string => JSON.stringify(v),
};

export interface FrozenScenarioData {
  scenario: ScenarioRow;
  sectors: string[];
  A: number[][];
  d: number[];
  v: number[];
  eDirect: number[];
}

export class Repository {
  constructor(readonly db: DatabaseSync) {}

 transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  upsertSector(id: string, name: string, unit: string, now: () => Date): SectorRow {
    const created_at = now().toISOString();
    this.db
      .prepare(
        `INSERT INTO sectors(id, name, unit, created_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, unit = excluded.unit`,
      )
      .run(id, name, unit, created_at);
    return this.getSector(id)!;
  }

  listSectors(): SectorRow[] {
    return this.db.prepare('SELECT * FROM sectors ORDER BY id').all() as unknown as SectorRow[];
  }

  getSector(id: string): SectorRow | undefined {
    return this.db.prepare('SELECT * FROM sectors WHERE id = ?').get(id) as SectorRow | undefined;
  }

  createScenario(
    name: string,
    sectors: string[],
    note: string,
    now: () => Date,
    parentScenarioId: number | null = null,
  ): number {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO scenarios(name, note, parent_scenario_id, sectors_json, created_at)
           VALUES(?, ?, ?, ?, ?)`,
        )
        .run(name, note, parentScenarioId, json.stringify(sectors), now().toISOString());
      return Number(result.lastInsertRowid);
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) {
        throw new AppError('CONFLICT', `scenario name already exists: ${name}`);
      }
      throw err;
    }
  }

  getScenario(id: number): ScenarioRow | undefined {
    return this.db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id) as ScenarioRow | undefined;
  }

  listScenarios(limit: number, offset: number): { rows: ScenarioRow[]; total: number } {
    const total = Number((this.db.prepare('SELECT COUNT(*) AS c FROM scenarios').get() as { c: number }).c);
    const rows = this.db
      .prepare('SELECT * FROM scenarios ORDER BY id LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as ScenarioRow[];
    return { rows, total };
  }

  /**
   * Snapshot the CURRENT sector catalogue and provided vectors into a frozen
   * scenario. Later catalogue edits never mutate an existing scenario.
   */
  freezeScenario(
    name: string,
    sectorIds: string[],
    payload: { A: number[][]; d: number[]; v: number[]; e: number[] },
    note: string,
    now: () => Date,
  ): number {
    return this.transaction(() => {
      const catalogue = this.listSectors();
      const known = new Set(catalogue.map((s) => s.id));
      for (const id of sectorIds) {
        if (!known.has(id)) throw new AppError('NOT_FOUND', `unknown sector: ${id}`);
      }
      return this.createScenario(name, sectorIds, note, now);
    });
  }

  saveReport(
    scenarioId: number,
    label: string,
    report: SolveReport,
    now: () => Date,
    delta: number[] | null = null,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO reports(scenario_id, label, demand_json, delta_json, report_json, created_at)
         VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scenarioId,
        label,
        json.stringify(report.d),
        delta === null ? null : json.stringify(delta),
        json.stringify(report),
        now().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  getReport(id: number): ReportRow | undefined {
    return this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined;
  }

  listReports(
    scenarioId: number | null,
    limit: number,
    offset: number,
  ): { rows: ReportRow[]; total: number } {
    if (scenarioId === null) {
      const total = Number((this.db.prepare('SELECT COUNT(*) AS c FROM reports').get() as { c: number }).c);
      const rows = this.db
        .prepare('SELECT * FROM reports ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as ReportRow[];
      return { rows, total };
    }
    const total = Number(
      (this.db.prepare('SELECT COUNT(*) AS c FROM reports WHERE scenario_id = ?').get(scenarioId) as { c: number }).c,
    );
    const rows = this.db
      .prepare('SELECT * FROM reports WHERE scenario_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(scenarioId, limit, offset) as unknown as ReportRow[];
    return { rows, total };
  }

  saveShock(row: Omit<ShockRow, 'id' | 'created_at'>, now: () => Date): number {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO shocks(base_report_id, scenario_id, label, delta_json, shocked_report_id,
             delta_x_json, delta_va_json, delta_emissions_total, idempotency_key, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.base_report_id,
          row.scenario_id,
          row.label,
          row.delta_json,
          row.shocked_report_id,
          row.delta_x_json,
          row.delta_va_json,
          row.delta_emissions_total,
          row.idempotency_key,
          now().toISOString(),
        );
      return Number(result.lastInsertRowid);
    } catch (err) {
      if (String((err as Error).message).includes('shocks_idem_key')) {
        throw new AppError('IDEMPOTENCY_REPLAY', 'idempotency key already used');
      }
      throw err;
    }
  }

  findShockByIdempotencyKey(key: string): ShockRow | undefined {
    return this.db
      .prepare('SELECT * FROM shocks WHERE idempotency_key = ?')
      .get(key) as ShockRow | undefined;
  }

  getShock(id: number): ShockRow | undefined {
    return this.db.prepare('SELECT * FROM shocks WHERE id = ?').get(id) as ShockRow | undefined;
  }

  listShocks(limit: number, offset: number): { rows: ShockRow[]; total: number } {
    const total = Number((this.db.prepare('SELECT COUNT(*) AS c FROM shocks').get() as { c: number }).c);
    const rows = this.db
      .prepare('SELECT * FROM shocks ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as ShockRow[];
    return { rows, total };
  }

  /** Store a completed API response for true replay idempotency. */
  storeIdempotentResponse(key: string, statusCode: number, body: unknown, now: () => Date): void {
    this.db
      .prepare(
        `INSERT INTO idempotency_keys(key, response_json, status_code, created_at)
         VALUES(?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`,
      )
      .run(key, json.stringify(body), statusCode, now().toISOString());
  }

  getIdempotentResponse(key: string): { body: unknown; statusCode: number } | undefined {
    const row = this.db
      .prepare('SELECT response_json, status_code FROM idempotency_keys WHERE key = ?')
      .get(key) as { response_json: string; status_code: number } | undefined;
    return row ? { body: json.parse(row.response_json), statusCode: row.status_code } : undefined;
  }
}


