# 多部门投入产出与需求冲击评估后端

Windows 本地可运行的**开放式 Leontief 固定系数**模型后端。提供 REST API、CLI、虚构经济部门矩阵夹具和自动化测试；**不含**网页、投入调度优化或任何真实经济数据库连接。

技术栈：TypeScript + Node.js（>=20，本机为 v25）+ 内置 `node:sqlite`（无需本地编译）。测试使用 Node 内置测试运行器。

---

## 1. 依赖与安装

```powershell
node -v        # 需要 >=20
npm install
```

只安装纯 JS 的开发依赖（`tsx`、`typescript`、`@types/node`）。SQLite 使用 Node 自带的 `node:sqlite`，不需要 Python / 编译器。

---

## 2. 模型口径（行列方向与单位）

部门编号顺序由部门表/方案中的 `sectorCodes` 决定。

- 技术系数矩阵 `A`（n×n）：**`A[i][j]` = 生产第 `j` 部门一单位总产出所消耗的第 `i` 部门产品数量**。行 `i` 是供给/投入来源部门，列 `j` 是生产/消耗部门。
- 数量平衡（货币或实物口径，单位随部门表）：
  - `x = A x + d`，其中 `x` 为总产出、`d` 为最终需求、`A x` 为中间使用。
  - Leontief 逆 `L = (I − A)^−1 = I + A + A² + …`，故 `x = L d`。
- 价格对偶：`p′ = p′ A + v′`，即 `(I − A′) p = v`。`v[j]` 为单位 `j` 产出的增加值系数，`p[j]` 为单位均衡价格/成本。恒等式 `p′ d = v′ x`（GDP 收入面 = 支出面）。
- 排放：
  - `e[j]` 是单位 `j` 总产出的**直接**排放强度（范围 1 式口径），直接排放合计 `e′ x`。
  - **完全（含上游）强度** `g′ = e′ L`，最终需求隐含排放 `g′ d`（平衡下等于 `e′ x`）。
  - 直接强度与含上游强度**不混用、不重复相乘**，避免重复计量。

### 校验与诊断（不“制造有效结果”）

- 系数、需求、增加值、排放强度必须**非负**，否则拒绝（`NEGATIVE_COEFFICIENT` / `NEGATIVE_DEMAND`）。
- 可生产性：谱半径 `ρ(A) < 1`（Hawkins–Simon）且解非负；否则 `NOT_PRODUCTIVE` / `NEGATIVE_OUTPUT`。
- `(I−A)` 奇异给 `SINGULAR_MATRIX`；用 1-范数条件数 κ 报告**病态**（默认 κ ≥ 1e8 标记 `illConditioned`）。
- **不会**通过归一化系数或截掉负产出来“修好”模型。
- 每次求解保存数量平衡残差 `x − (Ax + d)`、行列式、谱半径、条件数。

### 轮次分解与对账

Neumann 展开 `x = d + A d + A² d + …`：第 0 轮为直接需求 `d`，第 k 轮为 `A^k d` 的间接投入。截断到第 K 轮时：

`精确解 = 截断和 + 余项`，余项随轮数增大而趋小，且始终与精确解严格对账。

### 需求冲击的边界

冲击只在**同一冻结技术矩阵**下做静态比较（`sameFrozenA`）。固定系数静态乘数**不是**真实市场的因果/时序预测；方案修改会另存新版本，旧矩阵与旧结果保持不变。

---

## 3. 常用命令

```powershell
npm test          # 运行全部自动化测试（node:test）
npm run build     # 类型检查 + 编译到 dist/
npm run demo      # 可重复的端到端演示（使用独立 data/demo.sqlite）
npm run migrate   # 打开/迁移默认库（可重复执行）
npm run clean     # 停止本项目服务并清理 data 与 .run（仅限本项目内）
```

### 启动 / 停止 API

```powershell
npm start                                  # 仅绑定 127.0.0.1，端口由系统自动分配
# 启动后会写出 .run/server.port 与 .run/server.pid，stdout 打印实际端口

node scripts/clean.mjs                     # 依据 .run/server.pid 仅停止本项目进程并清理
```

服务**只监听 `127.0.0.1`**，端口 `0` 表示自动分配。数据库默认 `data/app.sqlite`，可用 `IO_DB_PATH` 覆盖；所有数据与临时文件都在本项目目录内。

---

## 4. CLI

```powershell
# 数据库 / 部门
npm run cli init
npm run cli sectors

# 导入内置虚构矩阵：two | none | cyclic | unproductive | singular
npm run cli load-fixture two demo "两部门解析例" --idem import-1

# 从 JSON 文件导入（字段见下）
npm run cli import path/to/scenario.json
npm run cli check-sectors path/to/scenario.json   # 仅校验部门口径是否已登记

# 计算 / 冲击 / 排放 / 导出
npm run cli scenarios --key demo --limit 20 --offset 0
npm run cli baseline 1 --idem base-1
npm run cli shock 1 "[5,-2]" --max-rounds 12 --idem shock-1
npm run cli emissions 2 --max-rounds 12
npm run cli export ledger 2 data/ledger.json
npm run cli export report 1 data/report.json
```

关键命令都会打印**操作前后状态**（最新版本号、既有报告数、生成的新版本等）。

> PowerShell 注意：逗号可能被 shell 当作分隔符。CLI 同时接受 `[5,-2]`、`'[5,-2]'` 或空格分隔的 `'[5 -2]'`。

导入 JSON 结构：

```json
{
  "key": "demo",
  "title": "两部门解析例",
  "sectorCodes": ["AGR", "MFG"],
  "matrixA": [[0.2, 0.3], [0.1, 0.1]],
  "demand": [10, 20],
  "valueAdded": [0.7, 0.6],
  "directEmission": [0.5, 1.2]
}
```

---

## 5. HTTP API

仅本机访问。分页参数 `limit`（1..200，默认 50）、`offset`（默认 0）。错误统一为 `{ "error": { "code", "message", "detail" } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/api/sectors` | 部门列表 |
| POST | `/api/sectors` | 登记部门 `{sectors:[{code,name,unit}]}` |
| POST | `/api/scenarios` | 导入冻结方案（请求头 `Idempotency-Key` 幂等） |
| GET | `/api/scenarios?key=&limit=&offset=` | 分页查询方案版本 |
| GET | `/api/scenarios/:id` | 方案详情（冻结快照） |
| POST | `/api/scenarios/:id/baseline` | 基准计算（幂等键 `Idempotency-Key` 或 `clientRequestId`） |
| POST | `/api/scenarios/:id/shock` | 需求增减 `{delta:[...], maxRounds?}`，生成新版本 |
| GET | `/api/scenarios/:id/emissions?maxRounds=` | 供应链排放账表（余项对账） |
| GET | `/api/reports?scenarioId=&limit=&offset=` | 分页查询计算报告 |

错误码：`VALIDATION_ERROR`(400)、`INVALID_JSON`(400)、`DIMENSION_MISMATCH`(400)、`SECTOR_NOT_FOUND`(404)、`SCENARIO_NOT_FOUND`(404)、`NOT_FOUND`(404)、`PAYLOAD_TOO_LARGE`(413)、`NEGATIVE_COEFFICIENT`/`NEGATIVE_DEMAND`/`SINGULAR_MATRIX`/`NOT_PRODUCTIVE`/`NEGATIVE_OUTPUT`(422)、`INTERNAL_ERROR`(500)。

幂等：导入用 `Idempotency-Key` 头；基准/冲击用 `Idempotency-Key` 头或请求体 `clientRequestId`。重复提交返回同一记录（`replayed: true`，HTTP 200），首次为 201。

示例：

```powershell
$port = Get-Content .run/server.port
Invoke-RestMethod "http://127.0.0.1:$port/health"
```

---

## 6. 自动化测试覆盖

`tests/`

- `model.test.ts`：两部门解析值手算核对、平衡残差、无中间投入、强循环可生产、不可生产、近奇异、奇异矩阵、负系数拒绝、轮次余项对账、线性叠加、价格对偶与 GDP 恒等、排放加总与不重复计量、部门换序的排列不变。
- `service.test.ts`：版本冻结与历史隔离、负需求回滚、导入/计算幂等、失败路径、部门口径、分页、事务回滚、排放账表对账（使用注入时钟）。
- `api.test.ts`：HTTP 全流程、参数校验与错误码、幂等、分页、以及**关闭后以同一文件重开的持久化状态**。

时间通过可注入的 `Clock` 控制；演示与测试使用独立/内存数据库，可重复执行；迁移为幂等的 `IF NOT EXISTS`。

---

## 7. 目录

```
src/linalg.ts        LU/逆/行列式/条件数/谱半径/Neumann
src/model.ts         数量模型、价格对偶、轮次分解、排放、诊断
src/fixtures.ts      虚构矩阵夹具与排列工具
src/db/              node:sqlite 连接与可重复迁移
src/repo.ts          仓储：事务、版本快照、幂等、分页
src/service.ts       校验、导入、基准、冲击、排放账表
src/api/             node:http REST 服务（127.0.0.1 自动端口）
src/cli/cli.ts       命令行
scripts/demo.ts      可重复端到端演示
scripts/clean.mjs    仅清理本项目进程与临时文件
tests/               自动化测试
data/ .run/          数据与运行时文件（git 忽略，仅本项目）
```
