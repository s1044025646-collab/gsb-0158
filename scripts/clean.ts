// Removes ONLY this project's generated data (./data) and stray PID file state.
// Never touches processes or files outside the project directory.
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const targets = [resolve('data')];
for (const target of targets) {
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log(`[clean] removed ${target}`);
  } else {
    console.log(`[clean] nothing to remove at ${target}`);
  }
}
