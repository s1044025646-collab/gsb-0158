#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDb } from '../db.ts';
import { EconomyService, toApiError, type ImportPayload } from '../service.ts';
import { fixtures } from '../fixtures.ts';
import { exportComparison, exportReport, fmt, loadJson, printReportSummary, table } from './util.ts';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function usage(): string {
  return [
    'Usage: io-eval <command> [options]',
    'Commands:',
    '  init-db [--db data/app.sqlite]                      run idempotent migrations',
    '  list-sectors [--db ...]                             show sector catalogue',
    '  import --file matrix.json [--db ...]                import a scenario from JSON',
    '  import-fixture --name two-sector [--db ...]         import a built-in fictitious economy',
    '  list-scenarios [--limit 50] [--offset 0]            paginated scenario list',
    '  list-reports [--scenario-id ID] [--limit 50]        paginated report list',
    '  baseline --report ID [--db ...]                     print baseline solve report',
    '  shock --report ID --delta 10,-5 --label name        apply demand shock (same frozen A)',
    '        [--idempotency-key KEY]                       repeat-safe submission',
    '  export --report ID --out reports/r.json [--csv]     export JSON or CSV ledger',
    '  export-comparison --shock ID --out reports/c.csv    export baseline vs shock ledger',
  ].join('\n');
}

function requireFlag(flags: Record<string, string>, key: string): string {
  const value = flags[key];
  if (value === undefined) throw new Error(`missing required flag --${key}`);
  return value;
}

function parseDelta(text: string): number[] {
  return text.split(',').map((part, i) => {
    const n = Number(part);
    if (!Number.isFinite(n)) throw new Error(`delta[${i}] is not a number: ${part}`);
    return n;
  });
}

export function runCli(argv: string[], cwd: string = process.cwd()): number {
  const args = parseArgs(argv);
  const dbPath = resolve(cwd, args.flags.db ?? 'data/app.sqlite');

  if (args.command === '' || args.command === 'help' || args.command === '--help') {
    console.log(usage());
    return 0;
  }

  if (args.command === 'init-db') {
    console.log(`[before] opening (and migrating if needed) ${dbPath}`);
    const db = openDb(dbPath);
    db.close();
    console.log('[after]  migrations applied; database ready');
    return 0;
  }

  const db = openDb(dbPath);
  const service = new EconomyService(db);
  try {
    switch (args.command) {
      case 'list-sectors': {
        const before = service.repo.listSectors().length;
        const sectors = service.repo.listSectors();
        console.log(`[before] catalogue size: ${before}`);
        console.log(
          table(
            ['id', 'name', 'unit'],
            sectors.map((s) => [s.id, s.name, s.unit]),
          ),
        );
        console.log(`[after]  catalogue size: ${sectors.length} (read-only)`);
        return 0;
      }

      case 'import': {
        const file = requireFlag(args.flags, 'file');
        const payload = loadJson(file) as ImportPayload;
        const scenariosBefore = service.repo.listScenarios(1, 0).total;
        console.log(`[before] scenarios: ${scenariosBefore}, importing ${payload.scenarioName} from ${file}`);
        const result = service.importScenario(payload);
        console.log(`[after]  scenario #${result.scenarioId}, baseline report #${result.baseReportId}`);
        printReportSummary('BASELINE', result.report);
        return 0;
      }

      case 'import-fixture': {
        const name = requireFlag(args.flags, 'name');
        const fixture = fixtures[name];
        if (!fixture) throw new Error(`unknown fixture: ${name}; choices: ${Object.keys(fixtures).join(', ')}`);
        const scenariosBefore = service.repo.listScenarios(1, 0).total;
        console.log(`[before] scenarios: ${scenariosBefore}, importing fixture "${name}"`);
        const result = service.importScenario(fixture);
        console.log(`[after]  scenario #${result.scenarioId}, baseline report #${result.baseReportId}`);
        printReportSummary(`FIXTURE ${name} — BASELINE`, result.report);
        return 0;
      }

      case 'list-scenarios': {
        const limit = Number(args.flags.limit ?? '50');
        const offset = Number(args.flags.offset ?? '0');
        const { rows, total } = service.repo.listScenarios(limit, offset);
        console.log(`total scenarios: ${total}; showing offset=${offset} limit=${limit}`);
        console.log(table(['id', 'name', 'sectors', 'createdAt'], rows.map((r) => [r.id, r.name, r.sectors_json, r.created_at])));
        return 0;
      }

      case 'list-reports': {
        const limit = Number(args.flags.limit ?? '50');
        const offset = Number(args.flags.offset ?? '0');
        const scenarioId = args.flags['scenario-id'] === undefined ? null : Number(args.flags['scenario-id']);
        const { rows, total } = service.repo.listReports(scenarioId, limit, offset);
        console.log(`total reports: ${total}; showing offset=${offset} limit=${limit}`);
        console.log(table(['id', 'scenarioId', 'label', 'createdAt'], rows.map((r) => [r.id, r.scenario_id, r.label, r.created_at])));
        return 0;
      }

      case 'baseline': {
        const id = Number(requireFlag(args.flags, 'report'));
        const row = service.getReport(id);
        const report = JSON.parse(row.report_json) as ReturnType<typeof JSON.parse> & import('../model.ts').SolveReport;
        printReportSummary(`REPORT #${id} (${row.label})`, report);
        return 0;
      }

      case 'shock': {
        const reportId = Number(requireFlag(args.flags, 'report'));
        const delta = parseDelta(requireFlag(args.flags, 'delta'));
        const label = args.flags.label ?? `shock-${new Date().toISOString()}`;
        const key = args.flags['idempotency-key'] ?? null;
        const shocksBefore = service.repo.listShocks(1, 0).total;
        const baseRow = service.getReport(reportId);
        console.log(`[before] shocks: ${shocksBefore}; base report #${reportId} (${baseRow.label}); delta=[${delta.join(', ')}]`);
        const result = service.shock(reportId, delta, label, key);
        console.log(
          `[after]  shock #${result.shockId} ${result.replayed ? '(replayed idempotent submission)' : '(new)'}, ` +
            `shocked report #${result.shockedReportId}`,
        );
        printReportSummary('BASELINE', result.base);
        printReportSummary('SHOCKED', result.shocked);
        console.log(
          table(
            ['sector', 'deltaX', 'deltaVA'],
            result.base.sectors.map((s, i) => [s, result.deltaX[i]!, result.deltaVA[i]!]),
          ),
        );
        console.log(
          `emissions total: ${fmt(result.base.emissions.directTotal)} -> ${fmt(result.shocked.emissions.directTotal)} ` +
            `(delta ${fmt(result.deltaEmissionsTotal)})`,
        );
        return 0;
      }

      case 'export': {
        const id = Number(requireFlag(args.flags, 'report'));
        const out = requireFlag(args.flags, 'out');
        const row = service.getReport(id);
        const report = JSON.parse(row.report_json) as import('../model.ts').SolveReport;
        exportReport(report, out, args.flags.csv !== undefined ? 'csv' : 'json');
        console.log(`exported report #${id} (${row.label}) to ${resolve(out)}`);
        return 0;
      }

      case 'export-comparison': {
        const shockId = Number(requireFlag(args.flags, 'shock'));
        const out = requireFlag(args.flags, 'out');
        const shock = service.repo.getShock(shockId);
        if (!shock) throw new Error(`shock not found: ${shockId}`);
        const baseReport = JSON.parse(service.getReport(shock.base_report_id).report_json) as import('../model.ts').SolveReport;
        const shockedReport = JSON.parse(service.getReport(shock.shocked_report_id).report_json) as import('../model.ts').SolveReport;
        exportComparison(
          {
            sectors: baseReport.sectors,
            baseX: baseReport.x,
            shockedX: shockedReport.x,
            deltaX: JSON.parse(shock.delta_x_json) as number[],
            baseVA: baseReport.valueAdded,
            shockedVA: shockedReport.valueAdded,
            deltaVA: JSON.parse(shock.delta_va_json) as number[],
          },
          out,
        );
        console.log(`exported shock #${shockId} comparison ledger to ${resolve(out)}`);
        return 0;
      }

      default:
        console.error(`unknown command: ${args.command}\n`);
        console.log(usage());
        return 2;
    }
  } catch (err) {
    const api = toApiError(err);
    console.error(`ERROR [${api.code}] ${api.message}`);
    if (api.details) console.error(JSON.stringify(api.details));
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = runCli(process.argv.slice(2));
  process.exitCode = code;
}
