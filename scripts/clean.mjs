/**
 * 仅清理本项目产生的运行时文件：
 * - 读取 .run/server.pid，若该 PID 属于本项目启动的 node 进程则停止；
 * - 删除本项目 data 与 .run 内的临时数据库/日志（保留目录）。
 * 不会触碰项目之外的任何进程或文件。
 */
import { existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { execSync } from "node:child_process";

const root = resolve(".");
const runDir = resolve(".run");
const dataDir = resolve("data");

function stopPid() {
  const pidFile = resolve(".run/server.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid)) return;
  try {
    // 仅当该 PID 的命令行引用本项目路径时才终止，避免误杀无关进程。
    const out = execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ]).toString();
    if (out.includes(root)) {
      execFileSync("taskkill", ["/PID", String(pid), "/F", "/T"]);
      console.log(`已停止本项目服务进程 PID=${pid}`);
    } else {
      console.log(`PID=${pid} 命令行不属于本项目，跳过`);
    }
  } catch {
    console.log(`PID=${pid} 未在运行（无需停止）`);
  } finally {
    rmSync(pidFile, { force: true });
    rmSync(resolve(".run/server.port"), { force: true });
  }
}

function cleanDir(dir, keepDir = true) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    removeWithRetry(resolve(dir, name));
  }
  if (!keepDir) rmSync(dir, { recursive: true, force: true });
}

function removeWithRetry(target, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === attempts - 1) console.log(`跳过暂被锁定的文件: ${target} (${e.code})`);
      execSync("powershell -NoProfile -Command \"Start-Sleep -Milliseconds 200\"");
    }
  }
}

stopPid();
cleanDir(runDir);
cleanDir(dataDir);
console.log("已清理 .run 与 data（仅本项目内）。");
