import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDatabase } from "../db/db.js";
import { Repository } from "../repo.js";
import { IoService } from "../service.js";
import { startApp } from "./http.js";

/**
 * 仅绑定本机 127.0.0.1，端口 0 = 由操作系统自动分配。
 * 数据库与 pid 文件均位于项目内。
 */
async function main(): Promise<void> {
  const dbPath = process.env.IO_DB_PATH ?? resolve("data/app.sqlite");
  const pidFile = process.env.IO_PID_FILE ?? resolve(".run/server.pid");
  const portFile = process.env.IO_PORT_FILE ?? resolve(".run/server.port");
  const db = openDatabase(dbPath);
  const repo = new Repository(db);
  const service = new IoService(repo);
  const { server, port } = await startApp({ service, repo });

  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(process.pid));
  writeFileSync(portFile, String(port));

  const shutdown = (): void => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(JSON.stringify({ event: "listening", host: "127.0.0.1", port, dbPath, pid: process.pid }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
