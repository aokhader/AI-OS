import { readFile } from 'node:fs/promises';
import {
  createFsStore,
  createScriptedPlanner,
  type DiscoverParam,
  type DiscoveryResult,
  discover,
  EngineArgumentError,
  type Planner,
  ScriptSchema,
  type Sensitivity,
} from '@handsoff/core';
import { createPlaywrightSurface } from '@handsoff/surface-playwright';
import { createPlannerFromEnv } from './planner.js';
import { loadEnv, parseParams } from './replay.js';

export interface DiscoverCommandOptions {
  goal: string;
  param: string[];
  sensitive: string[];
  describe: string[];
  outcome: string[];
  id?: string | undefined;
  name?: string | undefined;
  target: string;
  entry?: string | undefined;
  variant?: string | undefined;
  baseUrl?: string | undefined;
  headless?: boolean | undefined;
  maxSteps?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  scripted?: string | undefined;
  dataDir?: string | undefined;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'capability'
  );
}

function intEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
}

function summarize(result: DiscoveryResult, ms: number): string {
  const seconds = (ms / 1000).toFixed(1);
  if (result.status === 'compiled') {
    return `compiled ${result.capability.id} v${result.capability.version} · ${result.stepsRecorded} step(s) recorded · ${seconds}s`;
  }
  return `${result.status} · ${result.reason} · ${result.stepsRecorded} step(s) recorded · ${seconds}s`;
}

/** Exit codes: 0 compiled, 3 gave up or hit a limit, 1 aborted, 2 usage or configuration error. */
export async function runDiscoverCommand(opts: DiscoverCommandOptions): Promise<number> {
  loadEnv();
  const env = process.env;
  const dataDir = opts.dataDir ?? env.HANDSOFF_DATA_DIR ?? './data';
  const store = createFsStore(dataDir);

  let values: Record<string, string>;
  let descriptions: Record<string, string>;
  let outcomes: Record<string, string>;
  try {
    values = parseParams(opts.param);
    descriptions = parseParams(opts.describe);
    outcomes = parseParams(opts.outcome);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const params: DiscoverParam[] = Object.entries(values).map(([name, value]) => {
    const sensitivity: Sensitivity = opts.sensitive.includes(name) ? 'sensitive' : 'internal';
    return { name, type: 'string', description: descriptions[name] ?? name, sensitivity, value };
  });

  const profile = await store.appProfiles.get(opts.target);
  if (!profile) {
    console.error(`app profile ${opts.target} not found under ${dataDir}/app-profiles`);
    return 2;
  }

  let planner: Planner;
  if (opts.scripted) {
    const script = ScriptSchema.parse(JSON.parse(await readFile(opts.scripted, 'utf8')));
    planner = createScriptedPlanner(script);
    console.error(`planner: scripted (${script.length} steps from ${opts.scripted})`);
  } else {
    const picked = createPlannerFromEnv({
      provider: opts.provider,
      model: opts.model,
      effort: opts.effort,
      env,
      log: (line) => console.error(`  ${line}`),
    });
    if (!picked.ok) {
      console.error(picked.error);
      return 2;
    }
    planner = picked.planner;
    const info = planner.info();
    console.error(
      `planner: ${picked.provider} · ${info.model}${info.effort ? ` (effort ${info.effort})` : ''}`,
    );
  }

  const baseUrl = opts.baseUrl ?? env.HANDSOFF_TARGET_URL ?? 'http://localhost:4100';
  const headless = opts.headless ?? env.HANDSOFF_HEADLESS === 'true';
  const capabilityId = opts.id ?? slug(opts.goal);
  console.error(
    `handsoff discover → ${capabilityId} against ${baseUrl} (${headless ? 'headless' : 'headed'})`,
  );

  const started = Date.now();
  const surface = await createPlaywrightSurface({ headless });
  let result: DiscoveryResult;
  try {
    result = await discover(
      {
        goal: opts.goal,
        params,
        capabilityId,
        name: opts.name ?? opts.goal.slice(0, 80),
        entryRoute: opts.entry ?? '/',
        baseUrl,
        variantId: opts.variant,
        maxSteps: opts.maxSteps ? Number.parseInt(opts.maxSteps, 10) : intEnv('HANDSOFF_MAX_STEPS'),
        stepTimeoutMs: intEnv('HANDSOFF_STEP_TIMEOUT_MS'),
        runTimeoutMs: intEnv('HANDSOFF_RUN_TIMEOUT_MS'),
        outcomes: Object.entries(outcomes).map(([code, text]) => ({ code, text })),
      },
      { surface, store, profile, planner, env, log: (line) => console.error(`  ${line}`) },
    );
  } catch (err) {
    if (err instanceof EngineArgumentError) {
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
  if (result.status === 'compiled') return 0;
  return result.status === 'aborted' ? 1 : 3;
}
