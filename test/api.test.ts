import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { createRequestHandler } from '../src/http.ts';
import { fixtures } from '../src/fixtures.ts';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const dir = join('data', 'test-runs', `api-${process.pid}`);
const db = openDb(join(dir, 'api.sqlite'));
const server = createServer(createRequestHandler(db));

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  return { status: res.status, json, replay: res.headers.get('idempotency-replay') };
}

test('health and validation errors use explicit codes', async () => {
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);

  const bad = await call('POST', '/scenarios', { sectors: [] });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, 'VALIDATION');

  const missing = await call('GET', '/reports/99999');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');
});

test('full API flow: import, shock with comparison, pagination, idempotency', async () => {
  const imported = await call('POST', '/scenarios', fixtures['two-sector']);
  assert.equal(imported.status, 201);
  const baseReportId = imported.json.baseReportId as number;
  assert.ok(imported.json.report.diagnostics.residualInf < 1e-9);

  const shocked = await call('POST', `/reports/${baseReportId}/shocks`, {
    label: 'api-shock',
    delta: [10, -20],
  });
  assert.equal(shocked.status, 201);
  assert.equal(shocked.json.comparison.sectors.join(','), 'AG,MF');
  assert.ok(Array.isArray(shocked.json.comparison.deltaX));

  const paged = await call('GET', '/reports?limit=1&offset=0');
  assert.equal(paged.status, 200);
  assert.equal(paged.json.data.length, 1);
  assert.equal(paged.json.page.total >= 2, true);
  assert.equal(paged.json.page.hasMore, true);

  const badLimit = await call('GET', '/reports?limit=99999');
  assert.equal(badLimit.status, 422);
  assert.equal(badLimit.json.error.code, 'VALIDATION');

  const payload = { label: 'idem', delta: [3, 3] };
  const first = await call('POST', `/reports/${baseReportId}/shocks`, payload, { 'idempotency-key': 'K1' });
  const second = await call('POST', `/reports/${baseReportId}/shocks`, payload, { 'idempotency-key': 'K1' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.replay, 'true');
  assert.equal(first.json.shockId, second.json.shockId);
});

test('unproductive import fails through API with NOT_PRODUCTIVE and no scenario created', async () => {
  const before = await call('GET', '/scenarios?limit=500');
  const res = await call('POST', '/scenarios', fixtures.unproductive);
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, 'NOT_PRODUCTIVE');
  const after = await call('GET', '/scenarios?limit=500');
  assert.equal(after.json.page.total, before.json.page.total);
});

test('negative demand shock is rejected with NEGATIVE_DEMAND', async () => {
  const imported = await call('POST', '/scenarios', { ...fixtures['two-sector'], scenarioName: 'neg-check' });
  const res = await call('POST', `/reports/${imported.json.baseReportId}/shocks`, {
    label: 'x',
    delta: [-1000, 0],
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, 'NEGATIVE_DEMAND');
});
