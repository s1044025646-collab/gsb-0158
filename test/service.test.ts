import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type TestHarness } from './helpers.ts';
import { AppError } from '../src/errors.ts';
import { fixtures } from '../src/fixtures.ts';
import { openDb } from '../src/db.ts';

let h: TestHarness;

afterEach(() => h?.cleanup());

test('import freezes scenario and persists baseline report', () => {
  h = createHarness();
  const { scenarioId, baseReportId } = h.importFixture();
  const scenario = h.repo.getScenario(scenarioId);
  assert.ok(scenario);
  assert.equal(JSON.parse(scenario!.sectors_json).join(','), 'AG,MF');
  const row = h.repo.getReport(baseReportId);
  assert.ok(row);
  assert.equal(row!.scenario_id, scenarioId);
});

test('failure to import unproductive matrix rolls back the transaction (no partial rows)', () => {
  h = createHarness();
  const sectorsBefore = h.repo.listSectors().length;
  const scenariosBefore = h.repo.listScenarios(1, 0).total;
  assert.throws(
    () => h.service.importScenario(fixtures.unproductive!),
    (err: unknown) => err instanceof AppError && err.code === 'NOT_PRODUCTIVE',
  );
  assert.equal(h.repo.listSectors().length, sectorsBefore);
  assert.equal(h.repo.listScenarios(1, 0).total, scenariosBefore);
});

test('shock compares under frozen A and persists delta reports', () => {
  h = createHarness();
  const { baseReportId } = h.importFixture();
  const result = h.service.shock(baseReportId, [10, -20], 'policy-a');
  assert.equal(result.replayed, false);
  assert.ok(result.deltaX.every((z) => Number.isFinite(z)));
  const stored = h.repo.getShock(result.shockId);
  assert.ok(stored);
  assert.deepEqual(JSON.parse(stored!.delta_json), [10, -20]);
});

test('demand shock below zero is rejected and nothing is written', () => {
  h = createHarness();
  const { baseReportId } = h.importFixture();
  const shocksBefore = h.repo.listShocks(1, 0).total;
  assert.throws(
    () => h.service.shock(baseReportId, [-101, 0], 'bad'),
    (err: unknown) => err instanceof AppError && err.code === 'NEGATIVE_DEMAND',
  );
  assert.equal(h.repo.listShocks(1, 0).total, shocksBefore);
});

test('repeated shock with the same idempotency key is a replay', () => {
  h = createHarness();
  const { baseReportId } = h.importFixture();
  const first = h.service.shock(baseReportId, [5, 5], 'idem', 'key-123');
  const second = h.service.shock(baseReportId, [5, 5], 'idem', 'key-123');
  assert.equal(first.shockId, second.shockId);
  assert.equal(second.replayed, true);
  assert.equal(h.repo.listShocks(100, 0).total, 1);
});

test('historical versions are isolated: later catalogue edits do not mutate frozen scenarios', () => {
  h = createHarness();
  const { scenarioId, baseReportId } = h.importFixture('two-sector');
  const original = JSON.parse(h.repo.getReport(baseReportId)!.report_json);
  // Import a different economy that shares some sector ids with different unit.
  h.service.importScenario({
    ...fixtures['two-sector']!,
    scenarioName: 'fixture-two-sector-v2',
    sectors: [
      { id: 'AG', name: 'Agriculture Renamed', unit: 'bushel' },
      { id: 'MF', name: 'Manufacturing', unit: 'piece' },
    ],
    finalDemand: [999, 999],
  });
  const after = JSON.parse(h.repo.getReport(baseReportId)!.report_json);
  assert.deepEqual(after.d, original.d);
  assert.deepEqual(after.A, original.A);
  assert.deepEqual(JSON.parse(h.repo.getScenario(scenarioId)!.sectors_json), ['AG', 'MF']);
});

test('data survives a database close and reopen (restart persistence)', () => {
  h = createHarness();
  const { scenarioId, baseReportId } = h.importFixture();
  const result = h.service.shock(baseReportId, [1, 2], 'restart-check');
  h.db.close();

  const reopened = openDb(h.dbPath);
  const scenarioRow = reopened.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId);
  assert.ok(scenarioRow);
  const shockRow = reopened.prepare('SELECT * FROM shocks WHERE id = ?').get(result.shockId);
  assert.ok(shockRow);
  reopened.close();
});

test('migrations are repeatable without error', async () => {
  h = createHarness();
  const { migrate } = await import('../src/db.ts');
  assert.doesNotThrow(() => migrate(h.db));
  assert.doesNotThrow(() => migrate(h.db));
});

test('pagination metadata is correct', () => {
  h = createHarness();
  for (let i = 0; i < 3; i++) {
    h.service.importScenario({ ...fixtures['no-intermediate']!, scenarioName: `paged-${i}` });
  }
  const page1 = h.repo.listScenarios(2, 0);
  assert.equal(page1.total, 3);
  assert.equal(page1.rows.length, 2);
  const page2 = h.repo.listScenarios(2, 2);
  assert.equal(page2.rows.length, 1);
});
