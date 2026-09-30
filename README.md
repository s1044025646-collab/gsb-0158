# 多部门投入产出与需求冲击评估后端（Open Leontief）

Windows 本地运行的纯后端：TypeScript + Node.js（内置 `node:sqlite`），只提供 **HTTP API、CLI、虚构经济部门矩阵和自动化测试**。
不包含网页、投入调度优化，也不连接任何真实经济数据库。

## 模型口径（重要）

- 开放式 Leontief 固定系数模型：`(I − A)x = d`，其中
  - `A[i][j]` = 生产 **1 单位 j 部门总产出** 所直接消耗的 i 部门产品（**行＝投入来源，列＝生产配方**），单位为 `i 单位 / j 单位`；
  - `x` 为总产出向量，`d` 为最终需求向量，二者与各部门产出单位一致；
  - 中间使用为 `Ax`，物质平衡 `x = Ax + d`。
- 价格对偶：`(I − A^T)p = v`，即 `p = A^T p + v`；恒等式 `p'd = v'x`（增加值合计＝最终需求合计，单位一致时）。
- 供应链轮次分解：第 0 轮 `d`（直接需求拉动），第 k 轮 `A^k d`；截断后余项取**精确解减已列轮次和**，保证“列出轮次＋余项”与精确解对账（残差写入报告）。
- 排放两种视图（不得相加）：
  - 直接视图：分部门 `e_i x_i`，合计 `e'x`（`e` 为**直接**排放强度）；
  - 隐含/上游视图：完全排放强度 `c = (I − A^T)^{-1} e`，最终需求隐含排放 `c_i d_i`；
  - 两视图合计相等，差额 `accountingGap` 仅为浮点误差。直接强度与已含上游强度混用会重复计量，系统不提供混用入口。
- 需求冲击只在**同一冻结技术矩阵**下比较；固定系数静态乘数不是真实市场因果预测，不做时间动态推断。

## 数值与防作弊校验

- 拒绝负技术系数、负增加值/排放强度（`NON_NEGATIVE_VIOLATION`）。
- 最终需求及冲击后需求不得为负（`NEGATIVE_DEMAND`）；**绝不**靠归一化系数或截断负产出制造“有效”结果。
- 可生产性：`ρ(A) < 1`（幂迭代）且 Hawkins–Simon 主子式条件；不满足报 `NOT_PRODUCTIVE`。
- 部分主元高斯消元；近奇异报 `SINGULAR_MATRIX`，并计算 `κ∞(I−A)=‖I−A‖∞·‖(I−A)^{-1}‖∞`，超阈值置 `illConditioned`（默认 `1e10`，夹具测试用更低阈值）。
- 每份报告保存：平衡残差（绝对/相对无穷范数）、条件数、谱半径、行列和、Hawkins–Simon 标志、轮次对账残差。

## 数据与版本隔离

- SQLite 表：`sectors`（目录）、`scenarios`（冻结部门口径与顺序）、`reports`（完整求解 JSON）、`shocks`（冲击比较）、`idempotency_keys`、`schema_migrations`。
- 方案导入时**快照**当前部门目录；之后修改目录或新建方案不改变旧方案的 `A`、`d` 与既有结果（历史版本隔离）。
- 迁移可重复执行（`CREATE TABLE IF NOT EXISTS` + 迁移版本表），启动即迁移。
- 所有数据与临时文件都在项目内 `data/`；服务仅监听 `127.0.0.1`，默认自动端口（`IO_PORT=0`）。

## 依赖

- Node.js ≥ 22.5（开发验证：Node 25；使用内置 `node:sqlite` 实验特性）。
- 仅开发依赖：`typescript`、`tsx`（直接运行 TS）、`@types/node`。

```powershell
npm install
```

## 测试

```powershell
npm test          # node:test，27 个用例
npm run typecheck # tsc --noEmit
```

覆盖：两部门解析例（闭式解）、无中间投入、强循环可生产、不可生产、近奇异、部门顺序变更；
平衡残差、线性叠加、价格对偶、排放双视图加总、排列不变、轮次余项对账、
失败路径、事务回滚、幂等重放、分页、重启后持久化与迁移重复执行。

## CLI

数据库默认 `data/app.sqlite`（`--db` 可覆盖）。关键命令会打印 `[before]/[after]` 状态：

```powershell
node --import tsx src/cli/index.ts init-db
node --import tsx src/cli/index.ts import-fixture --name two-sector
node --import tsx src/cli/index.ts list-sectors
node --import tsx src/cli/index.ts list-scenarios --limit 50 --offset 0
node --import tsx src/cli/index.ts baseline --report 1
node --import tsx src/cli/index.ts shock --report 1 --delta 15,-30 --label demo --idempotency-key K1
node --import tsx src/cli/index.ts export --report 1 --out out/baseline.csv --csv
node --import tsx src/cli/index.ts export-comparison --shock 1 --out out/comparison.csv
```

内置虚构夹具：`two-sector`、`no-intermediate`、`strong-circular`、`unproductive`（必失败）、`near-singular`、`two-sector-reversed`。
也可用 `import --file matrix.json` 导入自定义矩阵（JSON 结构同 API 的 `/scenarios` 请求体）。

## HTTP API

启动（仅环回、自动端口，端口打印到控制台并写入 `data/server.pid`）：

```powershell
npm start
npm stop          # 仅停止 data/server.pid 记录的本项目进程
```

端点（均为 JSON；列表接口 `limit`（1–500，默认 50）/`offset` 分页）：

- `GET  /health`
- `GET  /sectors`
- `GET  /scenarios`、`GET /scenarios/{id}`
- `GET  /reports?scenarioId=&limit=&offset=`、`GET /reports/{id}`
- `GET  /shocks?limit=&offset=`
- `POST /scenarios`：导入并求解基准
- `POST /reports/{id}/shocks`：在同一冻结矩阵上施加需求增减

POST 可带 `Idempotency-Key` 头；重复提交返回首次结果（冲击重放状态码 200、响应头 `idempotency-replay: true`）。

错误响应统一为 `{ "error": { "code", "message", "details?" } }`，代码包括
`VALIDATION / NOT_FOUND / CONFLICT / NON_NEGATIVE_VIOLATION / NEGATIVE_DEMAND / SECTOR_MISMATCH /
DUPLICATE_SECTOR / NOT_PRODUCTIVE / SINGULAR_MATRIX / ILL_CONDITIONED / IDEMPOTENCY_REPLAY / PERSISTENCE`。

示例（PowerShell）：

```powershell
$body = @'
{
  "scenarioName": "demo",
  "sectors": [{"id":"AG","unit":"tonne"},{"id":"MF","unit":"piece"}],
  "matrix": [[0.1,0.2],[0.3,0.4]],
  "finalDemand": [100,200],
  "valueAdded": [0.6,0.4],
  "directEmissions": [2,5]
}
'@
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<port>/scenarios -ContentType application/json -Body $body
```

## 可重复端到端演示

```powershell
npm run demo
```

演示在 `data/demo/` 内重建数据库，启动临时端口环回服务：导入两部门虚构经济、求解基准、
施加 `[+15,-30]` 需求冲击、校验幂等重放、确认不可生产导入被拒、检查分页，然后关闭服务。
时间戳在测试中通过注入时钟固定，数据确定可重复。

## 清理

```powershell
npm run clean   # 仅删除项目内 data/，不触碰任何外部进程或文件
```

## 项目结构

- `src/linalg.ts`：消元、求逆、条件数、谱半径、Hawkins–Simon
- `src/model.ts`：校验、求解与诊断、轮次分解、价格对偶、排放核算、需求冲击
- `src/db.ts` / `src/service.ts`：SQLite 迁移、事务仓储、冻结方案与业务编排
- `src/http.ts` / `src/server.ts`：环回 HTTP API 与自动端口
- `src/cli/`：命令行与账表导出（JSON/CSV）
- `src/fixtures.ts`：全部虚构部门矩阵
- `test/`：模型、服务持久化、API、CLI 测试
- `scripts/`：`demo.ts`、`stop.ts`、`clean.ts`
