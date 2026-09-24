import { readFileSync } from 'node:fs';
import { createFsStore, ReplayArgumentError, type ReplayResult, replay } from '@handsoff/core';
import { createPlaywrightSurface } from '@handsoff/surface-playwright';

export interface ReplayCommandOptions {
  capability: string;
  version?: string | undefined;
  param: string[];
  chaos?: string | undefined;
  baseUrl?: string | undefined;
  headless?: boolean | undefined;
  dataDir?: string | undefined;
}

/**
 * Loads `.env` if present. Node keeps the last occurrence of a key, so a key that is set once and
 * then repeated empty (the template lists every key blank) silently ends up empty; warn about it.
 */
export function loadEnv(): void {
  try {
    const seen = new Map<string, boolean>();
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m?.[1]) continue;
      const [, name, value = ''] = m;
      const wasSet = seen.get(name);
      if (wasSet !== undefined) {
        console.error(
          `warning: .env defines ${name} more than once; the last one wins${wasSet && value === '' ? ' and it is empty' : ''}`,
        );
      }
      seen.set(name, value !== '');
    }
    process.loadEnvFile('.env');
  } catch {
    // no .env: rely on the environment
  }
}

export function parseParams(pairs: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new ReplayArgumentError(`--param expects name=value, got "${pair}"`);
    values[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return values;
}

function intEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
}

function summarize(result: ReplayResult, ms: number): string {
  const seconds = (ms / 1000).toFixed(1);
  const where = result.atStep ? ` at ${result.atStep}` : '';
  switch (result.status) {
    case 'success':
      return `success · ${result.stepsRun.length} step(s) · ${seconds}s · outputs ${JSON.stringify(result.outputs)} · side effects ${result.sideEffects}`;
    case 'outcome':
      return `outcome ${result.code}${where} · ${result.message} · ${seconds}s`;
    case 'failure':
      return `failure ${result.kind}${where} · expected ${result.expected} · observed ${result.observed} · ${seconds}s`;
  }
}

/** Exit codes: 0 success, 3 business outcome, 1 failure, 2 usage or configuration error. */
export async function runReplayCommand(opts: ReplayCommandOptions): Promise<number> {
  loadEnv();
  const env = process.env;
  const dataDir = opts.dataDir ?? env.HANDSOFF_DATA_DIR ?? './data';
  const store = createFsStore(dataDir);

  let params: Record<string, string>;
  try {
    params = parseParams(opts.param);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const version = opts.version ? Number.parseInt(opts.version, 10) : undefined;
  const capability = await store.capabilities.get(opts.capability, version);
  if (!capability) {
    console.error(
      `capability ${opts.capability}${version ? ` v${version}` : ''} not found under ${dataDir}/capabilities`,
    );
    return 2;
  }
  const profile = await store.appProfiles.get(capability.app.vendorProductId);
  if (!profile) {
    console.error(
      `app profile ${capability.app.vendorProductId} not found under ${dataDir}/app-profiles`,
    );
    return 2;
  }

  const baseUrl = opts.baseUrl ?? env.HANDSOFF_TARGET_URL ?? 'http://localhost:4100';
  const headless = opts.headless ?? env.HANDSOFF_HEADLESS === 'true';
  console.error(
    `handsoff replay ${capability.id} v${capability.version} against ${baseUrl} (${headless ? 'headless' : 'headed'})`,
  );

  const started = Date.now();
  const surface = await createPlaywrightSurface({
    headless,
    ...(opts.chaos ? { extraHTTPHeaders: { 'x-handsoff-chaos': opts.chaos } } : {}),
  });
  let result: ReplayResult;
  try {
    result = await replay(
      {
        capability,
        params,
        baseUrl,
        stepTimeoutMs: intEnv('HANDSOFF_STEP_TIMEOUT_MS'),
        runTimeoutMs: intEnv('HANDSOFF_RUN_TIMEOUT_MS'),
      },
      { surface, store, profile, env, log: (line) => console.error(`  ${line}`) },
    );
  } catch (err) {
    if (err instanceof ReplayArgumentError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  } finally {
    await surface.close();
  }

  console.error(summarize(result, Date.now() - started));
  console.error(`evidence: ${result.evidence.runDir}`);
  console.log(JSON.stringify(result, null, 2));
  return result.status === 'success' ? 0 : result.status === 'outcome' ? 3 : 1;
}
