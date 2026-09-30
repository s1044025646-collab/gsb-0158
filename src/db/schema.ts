/**
 * 数据库 schema。所有迁移写成“存在性判断/IF NOT EXISTS”，可重复执行。
 *
 * 版本（方案）模型：
 * - sectors 保存部门主数据（代码、名称、单位、口径顺序）。
 * - scenarios 为方案版本，冻结一份技术矩阵 A、最终需求 d、增加值 v、直接排放 e，
 *   以 JSON 快照保存，确保旧方案的矩阵永不被后续修改影响（历史版本隔离）。
 * - reports 保存某次求解/冲击比较的计算结果与诊断（含残差、条件数）。
 */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     version INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     applied_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS sectors (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     code TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     unit TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS scenarios (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     key TEXT NOT NULL,
     version INTEGER NOT NULL,
     title TEXT NOT NULL,
     note TEXT,
     sector_codes TEXT NOT NULL,
     matrix_a TEXT NOT NULL,
     demand TEXT NOT NULL,
     value_added TEXT NOT NULL,
     direct_emission TEXT NOT NULL,
     idempotency_key TEXT,
     created_at TEXT NOT NULL,
     UNIQUE(key, version),
     UNIQUE(idempotency_key)
   )`,

  `CREATE TABLE IF NOT EXISTS reports (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     scenario_id INTEGER NOT NULL,
     kind TEXT NOT NULL,
     client_request_id TEXT,
     payload TEXT NOT NULL,
     created_at TEXT NOT NULL,
     FOREIGN KEY(scenario_id) REFERENCES scenarios(id)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_reports_scenario ON reports(scenario_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_scenarios_key ON scenarios(key, version)`,
];

export const MIGRATIONS: { version: number; name: string }[] = [
  { version: 1, name: "initial" },
];
