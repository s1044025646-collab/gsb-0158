// Repeatable end-to-end demo: starts the loopback API server on an ephemeral
// port, imports a fictitious two-sector economy, applies a demand shock,
// verifies idempotent replay, and prints the comparison. All files live in
// ./data/demo inside this project.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../src/db.ts';
import { createRequestHandler } from '../src/http.ts';
import { fixtures } from '../src/fixtures.ts';

const demoDir = resolve('data/demo');
rmSync(demoDir, { recursive: true, force: true });

const db = openDb(resolve(demoDir, 'demo.sqlite'));
const server = createServer(createRequestHandler(db));
await new Promise<void>((listen) => server.listen(0, '127.0.0.1', listen));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
console.log(`[demo] server started on ${base} (ephemeral port, loopback only)`);

async function call(method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json: json as any };
}

try {
  const imported = await call('POST', '/scenarios', fixtures['two-sector']);
  console.assert(imported.status === 201, 'import should succeed');
  const baseReportId = imported.json.baseReportId as number;
  console.log(`[demo] imported scenario, baseline report #${baseReportId}`);
  console.log(`[demo] x = [${imported.json.report.x.map((z: number) => z.toFixed(4)).join(', ')}]`);
  console.log(`[demo] residual_inf = ${imported.json.report.diagnostics.residualInf.toExponential(3)}, kappa_inf = ${imported.json.report.diagnostics.conditionNumberInf.toFixed(3)}`);

  const shockPayload = { label: 'demo-demand-shock', delta: [15, -30] };
  const s1 = await call('POST', `/reports/${baseReportId}/shocks`, shockPayload, 'demo-key');
  const s2 = await call('POST', `/reports/${baseReportId}/shocks`, shockPayload, 'demo-key');
  console.log(`[demo] shock status: new=${s1.status}, replay=${s2.status} (same shock id ${s1.json.shockId} == ${s2.json.shockId})`);
  console.table({
    sectors: s1.json.comparison.sectors,
    baselineX: s1.json.comparison.baselineX.map((z: number) => Number(z.toFixed(3))),
    shockedX: s1.json.comparison.shockedX.map((z: number) => Number(z.toFixed(3))),
    deltaX: s1.json.comparison.deltaX.map((z: number) => Number(z.toFixed(3))),
  });
  console.log(`[demo] VA total delta = ${s1.json.comparison.deltaVA.reduce((a: number, b: number) => a + b, 0).toFixed(4)}`);
  console.log(`[demo] emissions total: ${s1.json.comparison.baselineEmissionsTotal.toFixed(3)} -> ${s1.json.comparison.shockedEmissionsTotal.toFixed(3)} (delta ${s1.json.comparison.deltaEmissionsTotal.toFixed(3)})`);

  const fail = await call('POST', '/scenarios', fixtures.unproductive);
  console.log(`[demo] unproductive import rejected as expected: ${fail.status} ${fail.json.error.code}`);

  const page = await call('GET', '/reports?limit=1&offset=0');
  console.log(`[demo] pagination: total=${page.json.page.total}, hasMore=${page.json.page.hasMore}`);
  console.log('[demo] OK — repeat this run with: npm run demo');
} finally {
  await new Promise<void>((done) => server.close(() => done()));
  db.close();
  console.log('[demo] server stopped; database kept at data/demo/demo.sqlite');
}
