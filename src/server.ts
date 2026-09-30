import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { openDb } from './db.ts';
import { createRequestHandler, listenLocal } from './http.ts';

export interface ServerOptions {
  dbPath?: string;
  port?: number;
  pidFile?: string;
}

export async function startServer(options: ServerOptions = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const dbPath = resolve(options.dbPath ?? process.env.IO_DB_PATH ?? 'data/app.sqlite');
  const db = openDb(dbPath);
  const server = createServer(createRequestHandler(db));
  const { port } = await listenLocal(server, options.port ?? Number(process.env.IO_PORT ?? 0));

  const pidFile = options.pidFile ?? resolve('data/server.pid');
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port, dbPath, startedAt: new Date().toISOString() }));

  const close = () =>
    new Promise<void>((resolveClose) => {
      server.close(() => {
        db.close();
        resolveClose();
      });
    });

  return { port, close };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer()
    .then(({ port }) => {
      console.log(`[io-eval] listening on http://127.0.0.1:${port} (loopback only)`);
      console.log(`[io-eval] pid file: ${resolve('data/server.pid')}`);
    })
    .catch((err) => {
      console.error('[io-eval] failed to start:', err);
      process.exit(1);
    });
}
