import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { SolveReport } from '../model.ts';
import { json } from '../db.ts';

export function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
}

export function fmt(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 1e6 || (value !== 0 && Math.abs(value) < 1e-4)) return value.toExponential(4);
  return value.toFixed(digits);
}

export function table(headers: string[], rows: (string | number)[][]): string {
  const textRows = rows.map((r) => r.map((c) => (typeof c === 'number' ? fmt(c) : c)));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...textRows.map((r) => r[i]?.length ?? 0)),
  );
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...textRows.map(line)].join('\n');
}

export function printReportSummary(tag: string, report: SolveReport): void {
  console.log(`\n=== ${tag} ===`);
  console.log(
    table(
      ['sector', 'finalDemand', 'grossOutput', 'intermediate', 'valueAdded', 'directEmission'],
      report.sectors.map((s, i) => [
        s,
        report.d[i]!,
        report.x[i]!,
        report.intermediate[i]!,
        report.valueAdded[i]!,
        report.emissions.directBySector[i]!,
      ]),
    ),
  );
  console.log(`totals: x=${fmt(report.grossOutputTotal)}  VA=${fmt(report.valueAddedTotal)}  emissions=${fmt(report.emissions.directTotal)}`);
  console.log(
    `diagnostics: residual_inf=${fmt(report.diagnostics.residualInf, 3)}  ` +
      `relative=${report.diagnostics.relativeResidualInf.toExponential(3)}  ` +
      `rho(A)=${fmt(report.diagnostics.spectralRadiusA, 6)}  ` +
      `kappa_inf=${fmt(report.diagnostics.conditionNumberInf, 4)}  ` +
      `illConditioned=${report.diagnostics.illConditioned}  hawkinsSimon=${report.diagnostics.hawkinsSimon}`,
  );
  console.log(
    `round decomposition: ${report.rounds.rounds.length} rounds listed, ` +
      `remainder reconciliation residual_inf=${report.rounds.reconciliationResidualInf.toExponential(3)}`,
  );
  console.log(
    `emissions: direct total ${fmt(report.emissions.directTotal)} == embodied total ${fmt(report.emissions.embodiedTotal)} ` +
      `(gap ${report.emissions.accountingGap.toExponential(3)})`,
  );
}

export function exportReport(report: SolveReport, outPath: string, kind: 'json' | 'csv'): void {
  const full = resolve(outPath);
  mkdirSync(dirname(full), { recursive: true });
  if (kind === 'json') {
    writeFileSync(full, JSON.stringify(report, null, 2));
    return;
  }
  const header = [
    'sector',
    'finalDemand',
    'grossOutput',
    'intermediate',
    'valueAdded',
    'directEmissions',
    'embodiedIntensity',
    'embodiedInFinalDemand',
    'priceDual',
  ].join(',');
  const lines = [header];
  report.sectors.forEach((s, i) => {
    lines.push(
      [
        s,
        report.d[i],
        report.x[i],
        report.intermediate[i],
        report.valueAdded[i],
        report.emissions.directBySector[i],
        report.emissions.embodiedIntensity[i],
        report.emissions.embodiedByDemandSector[i],
        report.prices[i],
      ].join(','),
    );
  });
  writeFileSync(full, lines.join('\n') + '\n');
}

export function exportComparison(args: {
  sectors: string[];
  baseX: number[];
  shockedX: number[];
  deltaX: number[];
  baseVA: number[];
  shockedVA: number[];
  deltaVA: number[];
}, outPath: string): void {
  const full = resolve(outPath);
  mkdirSync(dirname(full), { recursive: true });
  const lines = [
    'sector,baselineX,shockedX,deltaX,baselineVA,shockedVA,deltaVA',
    ...args.sectors.map(
      (s, i) =>
        `${s},${args.baseX[i]},${args.shockedX[i]},${args.deltaX[i]},${args.baseVA[i]},${args.shockedVA[i]},${args.deltaVA[i]}`,
    ),
  ];
  writeFileSync(full, lines.join('\n') + '\n');
}

export { json };
