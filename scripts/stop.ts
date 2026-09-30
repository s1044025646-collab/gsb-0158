// Stops ONLY the server recorded in this project's ./data/server.pid.
// Refuses to act if the PID is not running or if the pid file is missing,
// and never enumerates/kills unrelated processes.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const pidFile = resolve('data/server.pid');
if (!existsSync(pidFile)) {
  console.log('[stop] no pid file at data/server.pid; nothing to stop');
  process.exit(0);
}

const record = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number; port: number };
try {
  process.kill(record.pid, 0);
} catch {
  console.log(`[stop] process ${record.pid} is not running; removing stale pid file`);
  rmSync(pidFile, { force: true });
  process.exit(0);
}

process.kill(record.pid, 'SIGTERM');
console.log(`[stop] sent SIGTERM to project server pid ${record.pid} (was on port ${record.port})`);
rmSync(pidFile, { force: true });
