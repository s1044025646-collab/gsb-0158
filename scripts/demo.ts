/**
 * 可重复的端到端演示：
 * - 使用独立临时数据库 data/demo.sqlite（每次重建），不污染默认库；
 * - 直接调用服务层（与 HTTP/CLI 走同一套逻辑），打印关键操作前后状态；
 * - 覆盖正常路径与失败路径（不可生产、负需求）。
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../src/db/db.js";
import { Repository, AppError } from "../src/repo.js";
import { IoService } from "../src/service.js";
import { twoSectorAnalytic, unproductive, reorderFixture } from "../src/fixtures.js";

const dbPath = resolve("data/demo.sqlite");
for (const ext of ["", "-wal", "-shm"]) {
  const p = dbPath + ext;
  if (existsSync(p)) rmSync(p, { force: true });
}

const db = openDatabase(dbPath);
const repo = new Repository(db);
const service = new IoService(repo);

const line = (s: string): void => console.log("\n=== " + s + " ===");
const f = twoSectorAnalytic;

line("1. 登记部门口径");
service.registerSectors(f.sectors);
console.log(repo.listSectors().map((s) => `${s.code}(${s.unit})`).join(", "));

line("2. 导入两部门解析矩阵（冻结为方案 v1）");
const { scenario: s1 } = service.importScenario({
  key: "demo",
  title: "两部门解析例",
  sectorCodes: f.sectors.map((x) => x.code),
  matrixA: f.A,
  demand: f.demand,
  valueAdded: f.valueAdded,
  directEmission: f.directEmission,
});
console.log(`scenario #${s1.id} v${s1.version}`);

line("3. 基准解：总产出/价格对偶/增加值/排放/诊断");
const base = service.baseline(s1.id);
const bp = base.report.payload as any;
console.log("x        =", bp.output.map((x: number) => +x.toFixed(6)));
console.log("手算参照 = [21.739130, 24.637681]");
console.log("价格 p   =", bp.prices.map((x: number) => +x.toFixed(6)));
console.log("增加值合计 =", bp.valueAddedTotal.toFixed(6));
console.log("直接排放 e'x =", bp.emissions.directTotal.toFixed(6));
console.log("隐含排放 g'd =", bp.emissions.embodiedInDemand.toFixed(6));
console.log(
  `诊断: ρ=${bp.diagnostics.spectralRadius.toFixed(4)} κ=${bp.diagnostics.condition.toExponential(2)} 残差∞=${bp.residualNormInf.toExponential(2)}`,
);

line("4. 需求冲击 [+5,-2]（同一冻结技术矩阵，生成 v2）");
const sh = service.shock(s1.id, [5, -2]);
const sp = sh.report.payload as any;
console.log("新需求 =", sp.shockedDemand);
console.log("Δ产出 =", sp.deltaOutput.map((x: number) => +x.toFixed(6)));
console.log("Δ增加值 =", sp.deltaValueAddedTotal.toFixed(6));
console.log("Δ直接排放 =", sp.deltaDirectEmissionTotal.toFixed(6));
console.log(`截断轮数=${sp.rounds.length} 余项∞范=${sp.remainderNormInf.toExponential(2)} 同冻结矩阵=${sp.sameFrozenA}`);

line("5. 历史版本隔离：v1 旧矩阵与基准结果不变");
const again = service.baseline(s1.id);
console.log("v1 总产出仍为 =", (again.report.payload as any).output.map((x: number) => +x.toFixed(6)));
console.log("当前 demo 方案版本数 =", repo.listScenarios(100, 0, "demo").total);

line("6. 供应链排放账表（直接 + 各轮间接，余项对账）");
const ledger = service.emissionLedger(sh.shockedScenario.id, 5);
for (const r of ledger.rounds.slice(0, 4))
  console.log(`round ${r.round}: 该轮=${r.directEmission.toFixed(6)} 累计=${r.cumulativeEmission.toFixed(6)}`);
console.log(`截断=${ledger.truncatedEmissionTotal.toFixed(6)} 精确=${ledger.exactEmissionTotal.toFixed(6)} 余项=${ledger.remainderEmissionTotal.toExponential(2)}`);
writeFileSync(resolve("data/demo-ledger.json"), JSON.stringify(ledger, null, 2));
console.log("账表已导出 data/demo-ledger.json");

line("7. 排列不变：部门换序导入，结果按序一致");
const g = reorderFixture(f, ["MFG", "AGR"]);
service.registerSectors(g.sectors);
const { scenario: sPerm } = service.importScenario({
  key: "demo-perm",
  title: "换序",
  sectorCodes: g.sectors.map((x) => x.code),
  matrixA: g.A,
  demand: g.demand,
  valueAdded: g.valueAdded,
  directEmission: g.directEmission,
});
const pp = service.baseline(sPerm.id).report.payload as any;
console.log("换序后 x =", pp.output.map((x: number) => +x.toFixed(6)), "（首位对应 MFG，应等于原 x 的第2位）");

line("8. 失败路径：不可生产矩阵被拒绝");
try {
  service.registerSectors(unproductive.sectors);
  service.importScenario({
    key: "bad",
    title: "不可生产",
    sectorCodes: unproductive.sectors.map((x) => x.code),
    matrixA: unproductive.A,
    demand: unproductive.demand,
    valueAdded: unproductive.valueAdded,
    directEmission: unproductive.directEmission,
  });
} catch (e) {
  console.log(`已拒绝 [${(e as AppError).code}] ${(e as AppError).message}`);
}

line("9. 失败路径：需求减至负值被拒绝且不落库");
const before = repo.listScenarios(100, 0, "demo").total;
try {
  service.shock(s1.id, [-999, 0]);
} catch (e) {
  console.log(`已拒绝 [${(e as AppError).code}] ${(e as AppError).message}`);
}
console.log(`demo 版本数 ${before} -> ${repo.listScenarios(100, 0, "demo").total}（无新增）`);

db.close();
console.log("\n演示完成。数据库文件:", dbPath);
process.exit(0);
