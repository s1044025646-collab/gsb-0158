import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, type Repository } from '../src/db.ts';
import type { DatabaseSync } from 'node:sqlite';
import { EconomyService } from '../src/service.ts';
import { fixtures } from '../src/fixtures.ts';
import type { ImportPayload } from '../src/service.ts';

let counter = 0;

export interface TestHarness {
  dir: string;
  dbPath: string;
  db: DatabaseSync;
  repo: Repository;
  service: EconomyService;
  importFixture: (name?: keyof typeof fixtures | string, overrides?: Partial<ImportPayload>) => {
    scenarioId: number;
    baseReportId: number;
  };
  cleanup: () => void;
}

/** All temp data stays inside the project directory tree. */
export function createHarness(now: () => Date = () => new Date('2026-01-01T00:00:00Z')): TestHarness {
  const root = resolve('data/test-runs');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, `case-${process.pid}-${counter++}-`));
  const dbPath = join(dir, 'test.sqlite');
  const db = openDb(dbPath, now);
  const service = new EconomyService(db, now);

  return {
    dir,
    dbPath,
    db,
    repo: service.repo,
    service,
    importFixture(name = 'two-sector', overrides = {}) {
      const payload = { ...(fixtures[name] ?? fixtures['two-sector']!), ...overrides };
      const result = service.importScenario(payload);
      return { scenarioId: result.scenarioId, baseReportId: result.baseReportId };
    },
    cleanup() {
      try {
        db.close();
      } catch {
        // already closed (restart-persistence test closes explicitly)
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function approxEqual(a: number, b: number, tol = 1e-8): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

export function vecApprox(a: number[], b: number[], tol = 1e-8): boolean {
  return a.length === b.length && a.every((v, i) => approxEqual(v, b[i]!, tol));
}

export function fixedClock(): () => Date {
  let t = Date.parse('2026-01-01T00:00:00Z');
  return () => new Date((t += 1000));
}

export { tmpdir };
