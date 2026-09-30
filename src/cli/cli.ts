#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../db/db.js";
import { Repository } from "../repo.js";
import { ImportInput, IoService, mapModelError } from "../service.js";
import { ALL_FIXTURES, Fixture } from "../fixtures.js";
import { Vector } from "../linalg.js";

function dbPath(): string {
  return process.env.IO_DB_PATH ?? resolve("data/app.sqlite");
}

function fmtVec(v: number[], digits = 4): string {
  return "[" + v.map((x) => x.toFixed(digits)).join(", ") + "]";
}

function readJsonFile(path: string): any {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function help(): void {
  console.log(`io-cli - 开放式 Leontief 投入产出与需求冲击评估

用法:
  io-cli init
      打开/迁移数据库（可重复执行）。

  io-cli sectors
      列出已登记部门。

  io-cli load-fixture <name> <key> [title] [--idem KEY]
      导入内置虚构矩阵。name = ${Object.keys(ALL_FIXTURES).join("|")}

  io-cli import <file.json> [--idem KEY]
      从 JSON 导入方案。文件需含 key,title,sectorCodes,matrixA,demand,valueAdded,directEmission。

  io-cli scenarios [--key K] [--limit N] [--offset N]
      分页列出方案版本。

  io-cli baseline <scenarioId> [--idem KEY]
      计算基准：总产出、价格对偶、增加值、排放与诊断。

  io-cli shock <scenarioId> <deltaJSON> [--max-rounds K] [--idem KEY]
      施加需求增减，例如 "[5,-2]"；不得使任一需求为负。

  io-cli emissions <scenarioId> [--max-rounds K]
      导出供应链排放账表（直接+各轮间接，余项对账）。

  io-cli export <report|ledger> <scenarioId> <outFile> [--max-rounds K]
      导出计算账表到项目内 JSON 文件。

  io-cli check-sectors <file.json>
      仅校验导入文件的部门口径是否都已登记。

通用环境变量:
  IO_DB_PATH   指定 SQLite 文件（默认 data/app.sqlite）
`);
}

function argFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * 解析向量参数。标准 JSON "[5,-2]" 可用；
 * 在 PowerShell 中逗号可能被 shell 剥离为 "[5 -2]" 或 "5 -2"，这里兼容空白分隔。
 */
function parseVectorArg(raw: string): Vector {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.every((x) => typeof x === "number")) return v as Vector;
  } catch {
    // fall through
  }
  const cleaned = raw.replace(/[\[\]]/g, "").trim();
  const parts = cleaned.split(/[\s,]+/).filter((s) => s.length > 0);
  const v = parts.map(Number);
  if (v.some((x) => !Number.isFinite(x)))
    throw new Error(`无法把 "${raw}" 解析为数值向量`);
  return v;
}

function loadFixtureToInput(name: string, key: string, title: string): ImportInput & { fixture: Fixture } {
  const f = ALL_FIXTURES[name];
  if (!f) throw new Error(`未知夹具 ${name}`);
  return {
    key,
    title: title || `fixture:${name}`,
    sectorCodes: f.sectors.map((s) => s.code),
    matrixA: f.A,
    demand: f.demand,
    valueAdded: f.valueAdded,
    directEmission: f.directEmission,
    fixture: f,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") return help();

  const db = openDatabase(dbPath());
  const repo = new Repository(db);
  const service = new IoService(repo);

  try {
    switch (cmd) {
      case "init": {
        console.log(`[before] 数据库: ${dbPath()}`);
        openDatabase(dbPath()).close();
        console.log(`[after] 迁移完成（可重复执行），部门数=${repo.listSectors().length}`);
        break;
      }
      case "sectors": {
        const rows = repo.listSectors();
        console.log(`部门数=${rows.length}`);
        for (const s of rows) console.log(`  ${s.code}\t${s.name}\t(${s.unit})`);
        break;
      }
      case "load-fixture": {
        const [, name, key, title] = args;
        const raw = loadFixtureToInput(name!, key!, title ?? "");
        const before = repo.latestVersion(key!);
        console.log(`[before] key=${key} 最新版本=${before}，部门=${raw.sectorCodes.join("/")}`);
        service.registerSectors(raw.fixture.sectors);
        const { scenario, replayed } = service.importScenario({
          ...raw,
          idempotencyKey: argFlag(args, "--idem"),
        });
        console.log(
          `[after] ${replayed ? "幂等命中既有" : "已创建"}方案 id=${scenario.id} version=${scenario.version}`,
        );
        break;
      }
      case "import": {
        const file = args[1]!;
        const body = readJsonFile(file);
        const before = repo.latestVersion(body.key);
        console.log(`[before] key=${body.key} 最新版本=${before}`);
        const { scenario, replayed } = service.importScenario({
          ...body,
          idempotencyKey: argFlag(args, "--idem") ?? body.idempotencyKey,
        });
        console.log(
          `[after] ${replayed ? "幂等命中既有" : "已创建"}方案 id=${scenario.id} version=${scenario.version}，部门数=${scenario.sectorCodes.length}`,
        );
        break;
      }
      case "check-sectors": {
        const body = readJsonFile(args[1]!);
        const known = repo.sectorCodesSet();
        const missing = (body.sectorCodes as string[]).filter((c) => !known.has(c));
        if (missing.length > 0) {
          console.log(`[校验失败] 未登记部门: ${missing.join(", ")}`);
          process.exitCode = 2;
        } else {
          console.log(`[校验通过] ${body.sectorCodes.length} 个部门口径全部已登记`);
        }
        break;
      }
      case "scenarios": {
        const limit = Number(argFlag(args, "--limit") ?? "20");
        const offset = Number(argFlag(args, "--offset") ?? "0");
        const key = argFlag(args, "--key");
        const page = repo.listScenarios(limit, offset, key);
        console.log(`方案总数=${page.total} limit=${limit} offset=${offset}`);
        for (const s of page.items)
          console.log(`  #${s.id} ${s.key} v${s.version} "${s.title}" 部门=[${s.sectorCodes.join(",")}]`);
        break;
      }
      case "baseline": {
        const id = Number(args[1]);
        const before = repo.listReports(1, 0, id).total;
        console.log(`[before] 方案#${id} 既有报告数=${before}`);
        const { report, replayed } = service.baseline(id, argFlag(args, "--idem"));
        const p = report.payload as any;
        console.log(`[after] ${replayed ? "幂等命中既有" : "新生成"}报告 id=${report.id}`);
        console.log(`  部门        : ${p.sectorCodes.join(" | ")}`);
        console.log(`  总产出 x    : ${fmtVec(p.output)}`);
        console.log(`  价格对偶 p  : ${fmtVec(p.prices)}`);
        console.log(`  增加值合计  : ${p.valueAddedTotal.toFixed(6)}`);
        console.log(`  直接排放合计: ${p.emissions.directTotal.toFixed(6)}`);
        console.log(`  隐含排放g'd : ${p.emissions.embodiedInDemand.toFixed(6)}`);
        console.log(
          `  诊断        : ρ=${p.diagnostics.spectralRadius.toFixed(6)} κ=${p.diagnostics.condition.toExponential(3)} |det|=${p.diagnostics.detAbs.toExponential(3)} 病态=${p.diagnostics.illConditioned}`,
        );
        console.log(`  平衡残差∞范 : ${p.residualNormInf.toExponential(3)}`);
        break;
      }
      case "shock": {
        const id = Number(args[1]);
        const delta = parseVectorArg(args[2]!);
        const maxRounds = Number(argFlag(args, "--max-rounds") ?? "12");
        const before = repo.latestVersion(repo.getScenario(id)!.key);
        console.log(`[before] 基线方案#${id} key 最新版本=${before}，需求增量=${JSON.stringify(delta)}`);
        const { report, shockedScenario, replayed } = service.shock(
          id,
          delta,
          argFlag(args, "--idem"),
          maxRounds,
        );
        const p = report.payload as any;
        console.log(
          `[after] ${replayed ? "幂等命中既有" : "已生成"}冲击: 新方案#${shockedScenario.id} v${shockedScenario.version} 报告id=${report.id}`,
        );
        console.log(`  新需求      : ${fmtVec(p.shockedDemand)}`);
        console.log(`  Δ产出       : ${fmtVec(p.deltaOutput)}`);
        console.log(`  Δ增加值合计 : ${p.deltaValueAddedTotal.toFixed(6)}`);
        console.log(`  Δ直接排放   : ${p.deltaDirectEmissionTotal.toFixed(6)}`);
        console.log(`  截断余项∞范 : ${p.remainderNormInf.toExponential(3)}（与精确解对账）`);
        console.log(`  同冻结矩阵  : ${p.sameFrozenA}`);
        break;
      }
      case "emissions": {
        const id = Number(args[1]);
        const maxRounds = Number(argFlag(args, "--max-rounds") ?? "12");
        const ledger = service.emissionLedger(id, maxRounds);
        console.log(`方案#${id} 供应链排放分解（部门 ${ledger.sectorCodes.join("/")}）`);
        for (const r of ledger.rounds)
          console.log(
            `  round ${r.round}:\t该轮直接排放=${r.directEmission.toFixed(6)}\t累计=${r.cumulativeEmission.toFixed(6)}`,
          );
        console.log(`  截断合计=${ledger.truncatedEmissionTotal.toFixed(6)}`);
        console.log(`  精确合计=${ledger.exactEmissionTotal.toFixed(6)}`);
        console.log(`  余项排放=${ledger.remainderEmissionTotal.toExponential(3)}`);
        break;
      }
      case "export": {
        const kind = args[1];
        const id = Number(args[2]);
        const out = resolve(args[3]!);
        if (kind === "ledger") {
          const maxRounds = Number(argFlag(args, "--max-rounds") ?? "12");
          writeFileSync(out, JSON.stringify(service.emissionLedger(id, maxRounds), null, 2));
        } else if (kind === "report") {
          const { report } = service.baseline(id);
          writeFileSync(out, JSON.stringify(report, null, 2));
        } else {
          throw new Error(`未知导出类型 ${kind}`);
        }
        console.log(`已导出 ${kind} -> ${out}`);
        break;
      }
      default:
        help();
        process.exitCode = 2;
    }
  } catch (err) {
    const appErr = mapModelError(err);
    console.error(`错误[${appErr.code}] ${appErr.message}`);
    if (appErr.detail) console.error(JSON.stringify(appErr.detail));
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
