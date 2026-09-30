import type { IncomingMessage, Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { AppError, isRecord } from './errors.ts';
import { json, Repository } from './db.ts';
import { EconomyService, paginate, toApiError, type ImportPayload } from './service.ts';

interface RouteContext {
  service: EconomyService;
  repo: Repository;
  now: () => Date;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AppError('VALIDATION', 'request body is not valid JSON');
  }
}

import type { ServerResponse } from 'node:http';

function respond(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function requireRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new AppError('VALIDATION', 'request body must be a JSON object');
  return body;
}

function asNumberArray(value: unknown, name: string): number[] {
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
    throw new AppError('VALIDATION', `${name} must be an array of finite numbers`);
  }
  return value as number[];
}

function parseImport(body: Record<string, unknown>): ImportPayload {
  if (!Array.isArray(body.sectors) || body.sectors.length === 0) {
    throw new AppError('VALIDATION', 'sectors required as non-empty array');
  }
  const sectors = body.sectors.map((s, i) => {
    if (!isRecord(s) || typeof s.id !== 'string') {
      throw new AppError('VALIDATION', `sectors[${i}] must be an object with string id`);
    }
    return { id: s.id, name: typeof s.name === 'string' ? s.name : undefined, unit: typeof s.unit === 'string' ? s.unit : undefined };
  });
  if (body.finalDemand === undefined || body.valueAdded === undefined || body.directEmissions === undefined) {
    throw new AppError('VALIDATION', 'finalDemand, valueAdded and directEmissions are required');
  }
  if (typeof body.scenarioName !== 'string' || body.scenarioName.trim() === '') {
    throw new AppError('VALIDATION', 'scenarioName required');
  }
  const payload: ImportPayload = {
    sectors,
    rows: [],
    finalDemand: body.finalDemand as ImportPayload['finalDemand'],
    valueAdded: body.valueAdded as ImportPayload['valueAdded'],
    directEmissions: body.directEmissions as ImportPayload['directEmissions'],
    scenarioName: body.scenarioName,
    note: typeof body.note === 'string' ? body.note : '',
    label: typeof body.label === 'string' ? body.label : undefined,
  };
  if (body.matrix !== undefined) {
    if (!Array.isArray(body.matrix)) throw new AppError('VALIDATION', 'matrix must be an array of arrays');
    payload.matrix = (body.matrix as unknown[]).map((r, i) => asNumberArray(r, `matrix[${i}]`));
  } else if (body.rows !== undefined) {
    if (!Array.isArray(body.rows)) throw new AppError('VALIDATION', 'rows must be an array');
    payload.rows = (body.rows as unknown[]).map((r, i) => {
      if (!isRecord(r) || typeof r.from !== 'string') {
        throw new AppError('VALIDATION', `rows[${i}] must contain string "from"`);
      }
      const values = r.values ?? r.row;
      return { from: r.from, values: asNumberArray(values ?? [], `rows[${i}].values`) };
    });
  } else {
    throw new AppError('VALIDATION', 'either matrix or rows is required');
  }
  return payload;
}

export function createRequestHandler(db: DatabaseSync, now: () => Date = () => new Date()) {
  const service = new EconomyService(db, now);
  const repo = new Repository(db);
  const ctx: RouteContext = { service, repo, now };

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && path === '/health') {
        respond(res, 200, { status: 'ok', time: now().toISOString() });
        return;
      }

      if (method === 'GET' && path === '/sectors') {
        respond(res, 200, { sectors: repo.listSectors() });
        return;
      }

      if (method === 'GET' && path === '/scenarios') {
        const { limit, offset } = paginate(url.searchParams);
        const { rows, total } = repo.listScenarios(limit, offset);
        respond(res, 200, {
          data: rows,
          page: { limit, offset, total, hasMore: offset + rows.length < total },
        });
        return;
      }

      if (method === 'GET' && path.startsWith('/scenarios/')) {
        const id = Number(path.split('/')[2]);
        if (!Number.isInteger(id)) throw new AppError('VALIDATION', 'scenario id must be integer');
        const scenario = repo.getScenario(id);
        if (!scenario) throw new AppError('NOT_FOUND', `scenario not found: ${id}`);
        respond(res, 200, scenario);
        return;
      }

      if (method === 'GET' && path === '/reports') {
        const { limit, offset } = paginate(url.searchParams);
        const scenarioParam = url.searchParams.get('scenarioId');
        const scenarioId = scenarioParam === null ? null : Number(scenarioParam);
        if (scenarioId !== null && !Number.isInteger(scenarioId)) {
          throw new AppError('VALIDATION', 'scenarioId must be integer');
        }
        const { rows, total } = repo.listReports(scenarioId, limit, offset);
        respond(res, 200, {
          data: rows.map((r) => ({
            id: r.id,
            scenarioId: r.scenario_id,
            label: r.label,
            createdAt: r.created_at,
            demand: json.parse(r.demand_json),
            delta: r.delta_json ? json.parse(r.delta_json) : null,
          })),
          page: { limit, offset, total, hasMore: offset + rows.length < total },
        });
        return;
      }

      if (method === 'GET' && path.startsWith('/reports/')) {
        const id = Number(path.split('/')[2]);
        if (!Number.isInteger(id)) throw new AppError('VALIDATION', 'report id must be integer');
        const row = service.getReport(id);
        respond(res, 200, {
          id: row.id,
          scenarioId: row.scenario_id,
          label: row.label,
          createdAt: row.created_at,
          report: json.parse(row.report_json),
        });
        return;
      }

      if (method === 'GET' && path === '/shocks') {
        const { limit, offset } = paginate(url.searchParams);
        const { rows, total } = repo.listShocks(limit, offset);
        respond(res, 200, { data: rows, page: { limit, offset, total, hasMore: offset + rows.length < total } });
        return;
      }

      if (method === 'POST' && path === '/scenarios') {
        const idemKey = req.headers['idempotency-key'];
        const key = Array.isArray(idemKey) ? idemKey[0] : idemKey;
        const body = parseImport(requireRecord(await readJson(req)));
        const result = service.importScenario(body);
        const out = {
          scenarioId: result.scenarioId,
          baseReportId: result.baseReportId,
          report: result.report,
        };
        if (key) {
          const cached = repo.getIdempotentResponse(key);
          if (cached) {
            res.setHeader('idempotency-replay', 'true');
            respond(res, cached.statusCode, cached.body);
            return;
          }
          repo.storeIdempotentResponse(key, 201, out, now);
        }
        res.setHeader('idempotency-replay', 'false');
        respond(res, 201, out);
        return;
      }

      const shockMatch = /^\/reports\/(\d+)\/shocks$/.exec(path);
      if (method === 'POST' && shockMatch) {
        const idemKey = req.headers['idempotency-key'];
        const headerKey = Array.isArray(idemKey) ? idemKey[0] : idemKey;
        const baseReportId = Number(shockMatch[1]);
        if (!Number.isInteger(baseReportId)) throw new AppError('VALIDATION', 'report id must be integer');
        const body = requireRecord(await readJson(req));
        if (body.delta === undefined) throw new AppError('VALIDATION', 'delta required');
        const label = typeof body.label === 'string' ? body.label : 'shock';
        const result = service.shock(
          baseReportId,
          body.delta as number[] | Record<string, number>,
          label,
          headerKey ?? null,
        );
        const out = {
          shockId: result.shockId,
          baseReportId,
          shockedReportId: result.shockedReportId,
          replayed: result.replayed,
          comparison: {
            sectors: result.base.sectors,
            baselineX: result.base.x,
            shockedX: result.shocked.x,
            deltaX: result.deltaX,
            baselineValueAdded: result.base.valueAdded,
            shockedValueAdded: result.shocked.valueAdded,
            deltaVA: result.deltaVA,
            baselineEmissionsTotal: result.base.emissions.directTotal,
            shockedEmissionsTotal: result.shocked.emissions.directTotal,
            deltaEmissionsTotal: result.deltaEmissionsTotal,
          },
          shockedReport: result.shocked,
        };
        if (headerKey && !result.replayed) repo.storeIdempotentResponse(headerKey, 201, out, now);
        res.setHeader('idempotency-replay', String(result.replayed));
        respond(res, result.replayed ? 200 : 201, out);
        return;
      }

      throw new AppError('NOT_FOUND', `no route: ${method} ${path}`);
    } catch (err) {
      const api = toApiError(err);
      respond(res, api.status, { error: api });
    }
  };
}

export function listenLocal(
  server: Server,
  preferredPort = 0,
): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Bind loopback only — the service never listens on external interfaces.
    server.listen(preferredPort, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new AppError('PERSISTENCE', 'failed to acquire listening address'));
        return;
      }
      resolve({ port: addr.port });
    });
  });
}
