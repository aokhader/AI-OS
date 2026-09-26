import type { OpenAiPlannerOptions } from './planner.js';

/**
 * Presets for endpoints that speak the OpenAI chat completions protocol. A preset is only a base
 * URL, the conventional name of the key variable, a default model where one is safe to assume, and
 * two capability flags. Anything else is `openai-compatible` with `HANDSOFF_LLM_BASE_URL`.
 */
export type ProviderId =
  | 'google'
  | 'openai'
  | 'groq'
  | 'openrouter'
  | 'ollama'
  | 'openai-compatible';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  /** Undefined: the SDK default (OpenAI) or, for `openai-compatible`, `HANDSOFF_LLM_BASE_URL`. */
  baseURL?: string;
  /** Environment variable that holds the key. Undefined: no key is needed. */
  apiKeyEnv?: string;
  /** Only set where the name is stable and the model supports tool calling. */
  defaultModel?: string;
  /** Send screenshots by default. `HANDSOFF_LLM_IMAGES=on|off` overrides. */
  images: boolean;
  /** Forward `HANDSOFF_EFFORT` as `reasoning_effort`. */
  reasoningEffort: boolean;
  /** Pace requests for a metered free tier. `HANDSOFF_LLM_MIN_INTERVAL_MS` overrides. */
  minIntervalMs?: number;
  /** Where to get a key. */
  keysUrl?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  google: {
    id: 'google',
    label: 'Google AI Studio (Gemini, OpenAI-compatible endpoint)',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKeyEnv: 'GEMINI_API_KEY',
    // Google recommends this model and retires older ones for new users; on the free tier it
    // allows about 20 requests a day (verified 2026-09-25), roughly two discovery runs. Set
    // HANDSOFF_MODEL to pick another model.
    defaultModel: 'gemini-3.8-flash',
    images: true,
    reasoningEffort: true,
    // The free tier allows five requests per minute per model.
    minIntervalMs: 12_500,
    keysUrl: 'https://aistudio.google.com/apikey',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    apiKeyEnv: 'OPENAI_API_KEY',
    images: true,
    reasoningEffort: true,
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    images: false,
    reasoningEffort: false,
    keysUrl: 'https://console.groq.com/keys',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    images: false,
    reasoningEffort: false,
    keysUrl: 'https://openrouter.ai/keys',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
    images: false,
    reasoningEffort: false,
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'Any OpenAI-compatible endpoint (HANDSOFF_LLM_BASE_URL)',
    apiKeyEnv: 'HANDSOFF_LLM_API_KEY',
    images: false,
    reasoningEffort: false,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return value in PROVIDERS;
}

export interface ResolveProviderInput {
  provider: ProviderId;
  env: Record<string, string | undefined>;
  /** Overrides the preset default. Required where the preset has none. */
  model?: string | undefined;
  /** `HANDSOFF_EFFORT` or `--effort`; forwarded only where the preset says so. */
  effort?: string | undefined;
  /** `HANDSOFF_LLM_BASE_URL`; required for `openai-compatible`, overrides the preset elsewhere. */
  baseURL?: string | undefined;
  /** `HANDSOFF_LLM_IMAGES`; overrides the preset. */
  images?: boolean | undefined;
  /** `HANDSOFF_LLM_MIN_INTERVAL_MS`; overrides the preset. */
  minIntervalMs?: number | undefined;
}

export type ResolvedProvider =
  | { ok: true; options: OpenAiPlannerOptions; warnings: string[] }
  | { ok: false; error: string };

const OPENAI_EFFORTS: ReadonlySet<string> = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/** Gemini accepts none … high; the higher OpenAI levels clamp to high. */
function normalizeEffort(effort: string, provider: ProviderId): string | undefined {
  if (!OPENAI_EFFORTS.has(effort)) return undefined;
  if (provider === 'google' && (effort === 'xhigh' || effort === 'max')) return 'high';
  return effort;
}

/** Turns a preset plus the environment into planner options, without creating a client. */
export function resolveProvider(input: ResolveProviderInput): ResolvedProvider {
  const preset = PROVIDERS[input.provider];
  const warnings: string[] = [];

  const baseURL = input.baseURL ?? preset.baseURL;
  if (input.provider === 'openai-compatible' && !baseURL) {
    return { ok: false, error: 'provider openai-compatible needs HANDSOFF_LLM_BASE_URL' };
  }

  let apiKey: string | undefined;
  if (preset.apiKeyEnv) {
    apiKey = input.env[preset.apiKeyEnv];
    if (!apiKey) {
      if (input.provider === 'openai-compatible') {
        warnings.push('HANDSOFF_LLM_API_KEY is not set; sending a placeholder key');
        apiKey = 'none';
      } else {
        const where = preset.keysUrl ? ` (keys: ${preset.keysUrl})` : '';
        return {
          ok: false,
          error: `provider ${input.provider} needs ${preset.apiKeyEnv} in the environment or .env${where}`,
        };
      }
    }
  } else {
    apiKey = 'none';
  }

  const model = input.model ?? preset.defaultModel;
  if (!model) {
    return {
      ok: false,
      error: `provider ${input.provider} has no default model; set HANDSOFF_MODEL or --model`,
    };
  }

  let reasoningEffort: string | undefined;
  if (input.effort) {
    if (preset.reasoningEffort) {
      reasoningEffort = normalizeEffort(input.effort, input.provider);
      if (!reasoningEffort) warnings.push(`effort ${input.effort} is not a known level; not sent`);
    } else {
      warnings.push(`effort is not forwarded to provider ${input.provider}`);
    }
  }

  return {
    ok: true,
    warnings,
    options: {
      provider: input.provider,
      model,
      baseURL,
      apiKey,
      reasoningEffort,
      images: input.images ?? preset.images,
      minIntervalMs: input.minIntervalMs ?? preset.minIntervalMs,
    },
  };
}
