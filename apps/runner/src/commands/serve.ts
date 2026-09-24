import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../server/api.js';
import { loadEnv } from './replay.js';

export interface ServeCommandOptions {
  port?: string | undefined;
  host?: string | undefined;
  dataDir?: string | undefined;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * `handsoff serve`: the read API for the console, plus the console build when it exists
 * (01 §2). Runs until interrupted. WebSocket push and escalation controls arrive in P6.
 */
export async function runServeCommand(opts: ServeCommandOptions): Promise<number> {
  loadEnv();
  const env = process.env;
  const port = Number.parseInt(opts.port ?? env.HANDSOFF_PORT ?? '4000', 10);
  if (!Number.isInteger(port) || port < 1) {
    console.error(`invalid port ${opts.port ?? env.HANDSOFF_PORT}`);
    return 2;
  }
  const host = opts.host ?? '127.0.0.1';
  const dataDir = opts.dataDir ?? env.HANDSOFF_DATA_DIR ?? './data';
  const consoleDist = path.resolve(here, '../../../operator-console/dist');

  const app = await createApi({ dataDir, consoleDist });
  await app.listen({ port, host });
  const served = app.hasReplyDecorator('sendFile');
  console.error(
    `handsoff serve → http://${host}:${port} · data ${path.resolve(dataDir)} · ${served ? 'console build served' : 'console: pnpm --filter @handsoff/operator-console dev (http://localhost:5173)'}`,
  );

  await new Promise<void>((resolve) => {
    const stop = () => {
      console.error('stopping');
      void app.close().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}
