import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const cliPath = join(process.cwd(), 'src', 'cli', 'index.ts');
let dir: string;

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', cliPath, ...args],
      { cwd: dir, encoding: 'utf8' },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('CLI end-to-end: init, import fixture, baseline, shock, export ledgers', () => {
  dir = mkdtempSync(join(process.cwd(), 'data', 'test-runs', 'cli-'));

  const init = run(['init-db']);
  assert.equal(init.status, 0);
  assert.match(init.stdout, /migrations applied/);

  const imported = run(['import-fixture', '--name', 'two-sector']);
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /scenario #1/);
  assert.match(imported.stdout, /rho\(A\)/);

  const baseline = run(['baseline', '--report', '1']);
  assert.equal(baseline.status, 0);
  assert.match(baseline.stdout, /REPORT #1/);

  const shock = run(['shock', '--report', '1', '--delta', '10,-20', '--label', 'cli-shock']);
  assert.equal(shock.status, 0, shock.stderr);
  assert.match(shock.stdout, /shock #1/);
  assert.match(shock.stdout, /emissions total:/);

  // Repeated identical submission with same key is a replay — no new rows.
  const shockAgain = run([
    'shock', '--report', '1', '--delta', '10,-20', '--label', 'cli-shock',
    '--idempotency-key', 'CLIKEY',
  ]);
  assert.equal(shockAgain.status, 0);
  const shockThird = run([
    'shock', '--report', '1', '--delta', '10,-20', '--label', 'cli-shock',
    '--idempotency-key', 'CLIKEY',
  ]);
  assert.match(shockThird.stdout, /replayed idempotent submission/);
  assert.equal(shockAgain.stdout.match(/shock #\d+/)![0], shockThird.stdout.match(/shock #\d+/)![0]);

  const reports = run(['list-reports']);
  assert.match(reports.stdout, /total reports:/);

  run(['export', '--report', '1', '--out', 'out/baseline.json']);
  run(['export', '--report', '1', '--out', 'out/baseline.csv', '--csv']);
  run(['export-comparison', '--shock', '1', '--out', 'out/comparison.csv']);
  assert.ok(existsSync(join(dir, 'out', 'baseline.json')));
  assert.ok(existsSync(join(dir, 'out', 'baseline.csv')));
  const csv = readFileSync(join(dir, 'out', 'comparison.csv'), 'utf8');
  assert.match(csv, /sector,baselineX,shockedX,deltaX/);
});

test('CLI failure path: unproductive fixture exits non-zero with code and keeps DB consistent', () => {
  dir = mkdtempSync(join(process.cwd(), 'data', 'test-runs', 'cli-fail-'));
  run(['init-db']);
  const failed = run(['import-fixture', '--name', 'unproductive']);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /NOT_PRODUCTIVE/);

  const scenarios = run(['list-scenarios']);
  assert.match(scenarios.stdout, /total scenarios: 0/);

  // A demand shock requires an existing base report; with zero scenarios it
  // must also fail cleanly (no writes).
  const badShock = run(['shock', '--report', '1', '--delta', '-9999,0', '--label', 'bad']);
  assert.equal(badShock.status, 1);
  assert.match(badShock.stderr, /NOT_FOUND/);
});

test('CLI restart persistence: second process sees prior data', () => {
  dir = mkdtempSync(join(process.cwd(), 'data', 'test-runs', 'cli-persist-'));
  run(['init-db']);
  run(['import-fixture', '--name', 'no-intermediate']);
  const second = run(['list-scenarios']);
  assert.match(second.stdout, /fixture-no-intermediate/);
  const reportView = run(['baseline', '--report', '1']);
  assert.equal(reportView.status, 0);
});
