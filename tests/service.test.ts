import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { AppError, Repository } from "../src/repo.js";
import { IoService } from "../src/service.js";
import { Clock, createDb, migrate } from "../src/db/db.js";
import { twoSectorAnalytic, unproductive } from "../src/fixtures.js";

class FakeClock implements Clock {
  public t = 0;
  now(): Date {
    return new Date(Date.UTC(2026, 0, 1) + this.t++ * 1000);
  }
}

function setup(): { db: DatabaseSync; service: IoService; repo: Repository } {
  const db = createDb(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db, new FakeClock());
  const repo = new Repository(db, new FakeClock());
  const service = new IoService(repo);
  service.registerSectors(twoSectorAnalytic.sectors);
  service.registerSectors(unproductive.sectors);
  return { db, service, repo };
}

function importTwo(service: IoService, idem?: string) {
  const f = twoSectorAnalytic;
  return service.importScenario({
    key: "base",
    title: "两部门",
    sectorCodes: f.sectors.map((s) => s.code),
    matrixA: f.A,
    demand: f.demand,
    valueAdded: f.valueAdded,
    directEmission: f.directEmission,
    idempotencyKey: idem,
  });
}

test("导入产生冻结版本，重复 idempotencyKey 幂等返回同一方案", () => {
  const { service } = setup();
  const a = importTwo(service, "k-1");
  const b = importTwo(service, "k-1");
  assert.equal(a.scenario.id, b.scenario.id);
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, true);
});

test("冲击生成新版本但冻结旧矩阵；旧方案结果保持不变", () => {
  const { service, repo } = setup();
  const { scenario: base } = importTwo(service);
  const baseReport = service.baseline(base.id);
  const baseX = (baseReport.report.payload as any).output.slice();

  const { shockedScenario } = service.shock(base.id, [5, -2]);
  assert.notEqual(shockedScenario.id, base.id);
  assert.equal(shockedScenario.version, base.version + 1);
  // A 完全一致（冻结），需求不同
  assert.deepEqual(shockedScenario.A, base.A);
  assert.deepEqual(shockedScenario.demand, [15, 18]);

  // 旧方案总产出不变（历史版本隔离）
  const again = service.baseline(base.id);
  assert.deepEqual((again.report.payload as any).output, baseX);
});

test("需求减至负值被拒绝且不写入新版本（事务回滚）", () => {
  const { service, repo } = setup();
  const { scenario: base } = importTwo(service);
  const versionsBefore = repo.listScenarios(100, 0, "base").total;
  assert.throws(
    () => service.shock(base.id, [-100, 0]),
    (e: unknown) => e instanceof AppError && e.code === "NEGATIVE_DEMAND",
  );
  const versionsAfter = repo.listScenarios(100, 0, "base").total;
  assert.equal(versionsAfter, versionsBefore);
});

test("计算报告 clientRequestId 幂等：重复提交返回同一报告", () => {
  const { service } = setup();
  const { scenario } = importTwo(service);
  const r1 = service.baseline(scenario.id, "req-1");
  const r2 = service.baseline(scenario.id, "req-1");
  assert.equal(r1.report.id, r2.report.id);
  assert.equal(r2.replayed, true);
  const s1 = service.shock(scenario.id, [1, 1], "req-shock");
  const s2 = service.shock(scenario.id, [1, 1], "req-shock");
  assert.equal(s1.report.id, s2.report.id);
  assert.equal(s2.replayed, true);
});

test("不可生产夹具无法导入（失败路径）", () => {
  const { service } = setup();
  const f = unproductive;
  assert.throws(
    () =>
      service.importScenario({
        key: "bad",
        title: "不可生产",
        sectorCodes: f.sectors.map((s) => s.code),
        matrixA: f.A,
        demand: f.demand,
        valueAdded: f.valueAdded,
        directEmission: f.directEmission,
      }),
    (e: unknown) => e instanceof AppError && e.code === "NOT_PRODUCTIVE",
  );
});

test("部门口径不匹配：未登记部门被拒绝", () => {
  const { service } = setup();
  const f = twoSectorAnalytic;
  assert.throws(
    () =>
      service.importScenario({
        key: "x",
        title: "x",
        sectorCodes: ["AGR", "NOPE"],
        matrixA: f.A,
        demand: f.demand,
        valueAdded: f.valueAdded,
        directEmission: f.directEmission,
      }),
    (e: unknown) => e instanceof AppError && e.code === "SECTOR_NOT_FOUND",
  );
});

test("分页：limit/offset 正确切片并报告 total", () => {
  const { service, repo } = setup();
  for (let i = 0; i < 5; i++) {
    const f = twoSectorAnalytic;
    service.importScenario({
      key: "paged",
      title: `t${i}`,
      sectorCodes: f.sectors.map((s) => s.code),
      matrixA: f.A,
      demand: f.demand,
      valueAdded: f.valueAdded,
      directEmission: f.directEmission,
    });
  }
  const p1 = repo.listScenarios(2, 0, "paged");
  assert.equal(p1.total, 5);
  assert.equal(p1.items.length, 2);
  const p2 = repo.listScenarios(2, 2, "paged");
  assert.equal(p2.items[0]!.version, 3);
});

test("事务回滚：函数抛错时不落库", () => {
  const { repo } = setup();
  const before = repo.listScenarios(100, 0).total;
  assert.throws(() =>
    repo.transaction(() => {
      repo.insertScenario({
        key: "rollback",
        title: "t",
        sectorCodes: ["AGR", "MFG"],
        A: [
          [0, 0],
          [0, 0],
        ],
        demand: [1, 1],
        valueAdded: [1, 1],
        directEmission: [1, 1],
      });
      throw new Error("boom");
    }),
  );
  assert.equal(repo.listScenarios(100, 0, "rollback").total, 0);
  assert.equal(repo.listScenarios(100, 0).total, before);
});

test("排放账表：截断+余项与精确合计对账", () => {
  const { service } = setup();
  const { scenario } = importTwo(service);
  const ledger = service.emissionLedger(scenario.id, 3);
  assert.ok(
    Math.abs(
      ledger.truncatedEmissionTotal + ledger.remainderEmissionTotal - ledger.exactEmissionTotal,
    ) < 1e-7,
  );
});
