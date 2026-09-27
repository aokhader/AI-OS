import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../server/api.js';
import type { LiveRegistry } from '../server/live.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The built console, when it exists; otherwise the Vite dev server proxies to this API. */
export function consoleDistDir(): string {
  return path.resolve(here, '../../../operator-console/dist');
}

/**
 * `--operator console`: the process that owns the browser serves the console API for the
 * duration of the run (01 §2), so the inbox can claim and hand back its escalations (D-036).
 */
export async function startLiveApi(input: {
  dataDir: string;
  env: Record<string, string | undefined>;
  registry: LiveRegistry;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const port = Number.parseInt(input.env.HANDSOFF_PORT ?? '4000', 10);
  const host = input.env.HANDSOFF_HOST ?? '127.0.0.1';
  const app = await createApi({
    dataDir: input.dataDir,
    consoleDist: consoleDistDir(),
    live: input.registry,
  });
  await app.listen({ port, host });
  return { url: `http://${host}:${port}`, close: () => app.close() };
}
