import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS, SCHEMA_STATEMENTS } from "./schema.js";

export type DB = DatabaseSync;

export interface Clock {
  now(): Date;
}

export const defaultClock: Clock = { now: () => new Date() };

/** 打开数据库并（可重复地）执行迁移。默认文件位于项目 data 目录。 */
export function openDatabase(path: string, clock: Clock = defaultClock): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = createDb(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db, clock);
  return db;
}

/**
 * 统一构造数据库连接。
 * enableDoubleQuotedStringLiterals 恢复 SQLite 经典 DQS 行为，使双引号可作为
 * 标识符引用（schema 中不含依赖双引号字符串字面量的语句）。
 */
export function createDb(path: string): DatabaseSync {
  return new DatabaseSync(path, { enableDoubleQuotedStringLiterals: true });
}

export function migrate(db: DatabaseSync, clock: Clock = defaultClock): void {
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  const appliedStmt = db.prepare("SELECT version FROM schema_migrations");
  const applied = new Set<number>(
    (appliedStmt.all() as { version: number | bigint }[]).map((r) => Number(r.version)),
  );
  const insert = db.prepare(
    "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)",
  );
  for (const m of MIGRATIONS) {
    if (!applied.has(m.version)) {
      insert.run(m.version, m.name, clock.now().toISOString());
    }
  }
}
