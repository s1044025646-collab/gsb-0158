import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Server } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, createDb, migrate } from "../src/db/db.js";
import { Repository } from "../src/repo.js";
import { IoService } from "../src/service.js";
import { startApp } from "../src/api/http.js";
import { twoSectorAnalytic } from "../src/fixtures.js";

let server: Server;
let base: string;

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function fixtureBody() {
  const f = twoSectorAnalytic;
  return {
    key: "e2e",
    title: "端到端",
    sectorCodes: f.sectors.map((s) => s.code),
    matrixA: f.A,
    demand: f.demand,
    valueAdded: f.valueAdded,
    directEmission: f.directEmission,
  };
}

test("API 全流程：健康检查→部门→导入→基准→冲击→排放→报告分页", async (t) => {
  // 每个用例用独立内存库与端口
  const db = createDb(":memory:");
  migrate(db);
  const repo = new Repository(db);
  const app = await startApp({ service: new IoService(repo), repo });
  server = app.server;
  base = `http://127.0.0.1:${app.port}`;

  try {
  const h = await api("GET", "/health");
  assert.equal(h.status, 200);
  assert.equal(h.json.ok, true);

  const sec = await api("POST", "/api/sectors", { sectors: twoSectorAnalytic.sectors });
  assert.equal(sec.status, 200, JSON.stringify(sec.json));

  const imp = await api("POST", "/api/scenarios", fixtureBody(), { "idempotency-key": "imp-1" });
  assert.equal(imp.status, 201);
  const sid = imp.json.scenario.id;

  // 幂等：同样的 key 头，返回既有方案且 200
  const imp2 = await api("POST", "/api/scenarios", fixtureBody(), { "idempotency-key": "imp-1" });
  assert.equal(imp2.status, 200);
  assert.equal(imp2.json.scenario.id, sid);

  const baseRep = await api("POST", `/api/scenarios/${sid}/baseline`, { clientRequestId: "b1" });
  assert.equal(baseRep.status, 201);
  assert.ok(Math.abs(baseRep.json.payload.output[0] - 15 / 0.69) < 1e-6);
  assert.ok(baseRep.json.payload.diagnostics.condition > 0);

  const shock = await api("POST", `/api/scenarios/${sid}/shock`, { delta: [5, -2], clientRequestId: "sh1" });
  assert.equal(shock.status, 201);
  assert.deepEqual(shock.json.payload.shockedDemand, [15, 18]);
  assert.equal(shock.json.payload.sameFrozenA, true);
  assert.ok(shock.json.payload.remainderNormInf >= 0);
  const newSid = shock.json.shockedScenarioId;

  // 冲击幂等
  const shock2 = await api("POST", `/api/scenarios/${sid}/shock`, { delta: [5, -2], clientRequestId: "sh1" });
  assert.equal(shock2.status, 200);
  assert.equal(shock2.json.shockedScenarioId, newSid);

  const em = await api("GET", `/api/scenarios/${newSid}/emissions?maxRounds=8`);
  assert.equal(em.status, 200);
  assert.ok(
    Math.abs(
      em.json.truncatedEmissionTotal + em.json.remainderEmissionTotal - em.json.exactEmissionTotal,
    ) < 1e-6,
  );

  const reports = await api("GET", `/api/reports?scenarioId=${newSid}&limit=10&offset=0`);
  assert.equal(reports.status, 200);
  assert.ok(reports.json.total >= 1);

  // 失败路径：需求减为负
  const bad = await api("POST", `/api/scenarios/${sid}/shock`, { delta: [-999, 0] });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, "NEGATIVE_DEMAND");

  // 参数校验：limit 越界
  const badPage = await api("GET", "/api/scenarios?limit=9999");
  assert.equal(badPage.status, 400);
  assert.equal(badPage.json.error.code, "VALIDATION_ERROR");

  // 非方阵拒绝
  const badMatrix = await api("POST", "/api/scenarios", { ...fixtureBody(), key: "x", matrixA: [[1, 2]] });
  assert.equal(badMatrix.status, 400);

  // 404
  const nf = await api("POST", "/api/scenarios/9999/baseline", {});
  assert.equal(nf.status, 404);

  } catch (e) {
  t.diagnostic("CAUGHT: " + (e as Error)?.stack);
  throw e;
  } finally {
  server.close();
  db.close();
  }
});

test("重启后持久化：关闭并以同一文件重开，数据与历史版本保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "io-persist-"));
  const dbPath = join(dir, "app.sqlite");
  try {
    {
      const db = openDatabase(dbPath);
      const repo = new Repository(db);
      const service = new IoService(repo);
      service.registerSectors(twoSectorAnalytic.sectors);
      const { scenario } = service.importScenario({
        ...fixtureBody(),
        idempotencyKey: "persist-imp",
      });
      service.baseline(scenario.id, "persist-base");
      service.shock(scenario.id, [1, 0], "persist-shock");
      db.close();
    }
    assert.ok(existsSync(dbPath));
    {
      const db = openDatabase(dbPath);
      const repo = new Repository(db);
      const page = repo.listScenarios(100, 0, "e2e");
      assert.equal(page.total, 2, "基线与冲击两个版本都应保留");
      // 幂等键在重启后仍生效
      const hit = repo.findByIdempotency("persist-imp");
      assert.ok(hit);
      const reports = repo.listReports(100, 0);
      assert.ok(reports.total >= 2);
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
