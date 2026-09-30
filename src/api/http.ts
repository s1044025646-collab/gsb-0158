import { IncomingMessage, Server, ServerResponse, createServer } from "node:http";
import { AddressInfo } from "node:net";
import { AppError, Repository } from "../repo.js";
import { IoService, mapModelError } from "../service.js";
import { Vector } from "../linalg.js";

interface Ctx {
  service: IoService;
  repo: Repository;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function parsePagination(url: URL): { limit: number; offset: number } {
  const limitRaw = Number(url.searchParams.get("limit") ?? "50");
  const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 200)
    throw new AppError(400, "VALIDATION_ERROR", "limit 必须为 1..200 的整数");
  if (!Number.isInteger(offsetRaw) || offsetRaw < 0)
    throw new AppError(400, "VALIDATION_ERROR", "offset 必须为非负整数");
  return { limit: limitRaw, offset: offsetRaw };
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > 4 * 1024 * 1024) throw new AppError(413, "PAYLOAD_TOO_LARGE", "请求体超过 4MB");
    chunks.push(b);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(400, "INVALID_JSON", "请求体不是合法 JSON");
  }
}

function idemKey(req: IncomingMessage): string | undefined {
  const v = req.headers["idempotency-key"];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

export function createApp(ctx: Ctx): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      // health
      if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });

      // sectors
      if (req.method === "GET" && path === "/api/sectors")
        return send(res, 200, { items: ctx.repo.listSectors() });
      if (req.method === "POST" && path === "/api/sectors") {
        const body = await readJson(req);
        return send(res, 200, ctx.service.registerSectors(body.sectors));
      }

      // scenarios
      if (req.method === "POST" && path === "/api/scenarios") {
        const body = await readJson(req);
        const { scenario, replayed } = ctx.service.importScenario({
          key: body.key,
          title: body.title,
          note: body.note,
          sectorCodes: body.sectorCodes,
          matrixA: body.matrixA,
          demand: body.demand,
          valueAdded: body.valueAdded,
          directEmission: body.directEmission,
          idempotencyKey: idemKey(req) ?? body.idempotencyKey,
        });
        return send(res, replayed ? 200 : 201, { scenario, replayed });
      }
      if (req.method === "GET" && path === "/api/scenarios") {
        const { limit, offset } = parsePagination(url);
        const key = url.searchParams.get("key") ?? undefined;
        return send(res, 200, ctx.repo.listScenarios(limit, offset, key));
      }

      let m = path.match(/^\/api\/scenarios\/(\d+)$/);
      if (req.method === "GET" && m) {
        const s = ctx.repo.getScenario(Number(m[1]));
        if (!s) throw new AppError(404, "SCENARIO_NOT_FOUND", "方案不存在");
        return send(res, 200, s);
      }

      m = path.match(/^\/api\/scenarios\/(\d+)\/baseline$/);
      if (req.method === "POST" && m) {
        const body = await readJson(req);
        const result = ctx.service.baseline(Number(m[1]), idemKey(req) ?? body.clientRequestId);
        return send(res, result.replayed ? 200 : 201, result.report);
      }

      m = path.match(/^\/api\/scenarios\/(\d+)\/shock$/);
      if (req.method === "POST" && m) {
        const body = await readJson(req);
        const result = ctx.service.shock(
          Number(m[1]),
          body.delta as Vector,
          idemKey(req) ?? body.clientRequestId,
          typeof body.maxRounds === "number" ? body.maxRounds : 12,
        );
        return send(res, result.replayed ? 200 : 201, {
          ...serializeReport(result.report),
          replayed: result.replayed,
          shockedScenarioId: result.shockedScenario.id,
        });
      }

      m = path.match(/^\/api\/scenarios\/(\d+)\/emissions$/);
      if (req.method === "GET" && m) {
        const maxRounds = Number(url.searchParams.get("maxRounds") ?? "12");
        return send(
          res,
          200,
          ctx.service.emissionLedger(
            Number(m[1]),
            Number.isInteger(maxRounds) && maxRounds >= 0 ? maxRounds : 12,
          ),
        );
      }

      // reports
      if (req.method === "GET" && path === "/api/reports") {
        const { limit, offset } = parsePagination(url);
        const sid = url.searchParams.get("scenarioId");
        return send(res, 200, ctx.repo.listReports(limit, offset, sid ? Number(sid) : undefined));
      }

      return send(res, 404, { error: { code: "NOT_FOUND", message: `无此路由: ${req.method} ${path}` } });
    } catch (err) {
      const appErr = err instanceof AppError ? err : mapModelError(err);
      return send(res, appErr.status, {
        error: { code: appErr.code, message: appErr.message, detail: appErr.detail ?? null },
      });
    }
  });
  return server;
}

function serializeReport(r: ReturnType<Repository["insertReport"]>) {
  return { id: r.id, scenarioId: r.scenarioId, kind: r.kind, payload: r.payload, createdAt: r.createdAt };

}

export function startApp(ctx: Ctx, host = "127.0.0.1", port = 0): Promise<{ server: Server; port: number }> {
  const server = createApp(ctx);
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}
