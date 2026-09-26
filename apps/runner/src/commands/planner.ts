import type { Planner } from '@handsoff/core';
import { createAnthropicPlanner } from '@handsoff/llm-anthropic';
import {
  createOpenAiPlanner,
  isProviderId,
  PROVIDER_IDS,
  type ProviderId,
  resolveProvider,
} from '@handsoff/llm-openai';

/**
 * Picks and configures the model-backed planner for `handsoff discover` (D-031). The provider is
 * `--provider`, then `HANDSOFF_LLM_PROVIDER`, then whichever key is present, in this order.
 */
export type PlannerProviderId = 'anthropic' | ProviderId;
export const PLANNER_PROVIDER_IDS: PlannerProviderId[] = ['anthropic', ...PROVIDER_IDS];

export interface PlannerFromEnvInput {
  provider?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
}

export type PlannerFromEnv =
  | { ok: true; planner: Planner; provider: PlannerProviderId }
  | { ok: false; error: string };

const DETECTION: Array<[PlannerProviderId, string[]]> = [
  ['anthropic', ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']],
  ['google', ['GEMINI_API_KEY']],
  ['openai', ['OPENAI_API_KEY']],
  ['groq', ['GROQ_API_KEY']],
  ['openrouter', ['OPENROUTER_API_KEY']],
  ['openai-compatible', ['HANDSOFF_LLM_BASE_URL']],
];

export function detectProvider(
  env: Record<string, string | undefined>,
): PlannerProviderId | undefined {
  for (const [id, names] of DETECTION) {
    if (names.some((n) => env[n])) return id;
  }
  return undefined;
}

function onOff(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return value !== 'off' && value !== 'false' && value !== '0';
}

export function createPlannerFromEnv(input: PlannerFromEnvInput): PlannerFromEnv {
  const { env, log } = input;
  const requested = input.provider || env.HANDSOFF_LLM_PROVIDER || undefined;
  const provider = requested ?? detectProvider(env);
  if (!provider) {
    return {
      ok: false,
      error: `discovery needs a model provider: set HANDSOFF_LLM_PROVIDER to one of ${PLANNER_PROVIDER_IDS.join(', ')} with its key (ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY or HANDSOFF_LLM_BASE_URL), or use --scripted <file> to run without a model`,
    };
  }
  if (provider !== 'anthropic' && !isProviderId(provider)) {
    return {
      ok: false,
      error: `unknown provider ${provider}; expected one of ${PLANNER_PROVIDER_IDS.join(', ')}`,
    };
  }

  const model = input.model ?? (env.HANDSOFF_MODEL || undefined);
  const effort = input.effort ?? (env.HANDSOFF_EFFORT || undefined);

  if (provider === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
      return {
        ok: false,
        error:
          'provider anthropic needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment or .env',
      };
    }
    return {
      ok: true,
      provider,
      planner: createAnthropicPlanner({
        model,
        effort,
        fallbacks: env.HANDSOFF_FALLBACKS !== 'off',
        log,
      }),
    };
  }

  const resolved = resolveProvider({
    provider,
    env,
    model,
    effort,
    baseURL: env.HANDSOFF_LLM_BASE_URL || undefined,
    images: onOff(env.HANDSOFF_LLM_IMAGES),
    minIntervalMs: env.HANDSOFF_LLM_MIN_INTERVAL_MS
      ? Number.parseInt(env.HANDSOFF_LLM_MIN_INTERVAL_MS, 10)
      : undefined,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  for (const warning of resolved.warnings) log(warning);
  return { ok: true, provider, planner: createOpenAiPlanner({ ...resolved.options, log }) };
}
