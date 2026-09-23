/**
 * @handsoff/llm-openai
 *
 * Implements the `Planner` port from @handsoff/core over the OpenAI chat completions protocol,
 * which is what most hosted and local model endpoints speak: Google AI Studio, Groq, OpenRouter,
 * Ollama and OpenAI itself. The tool specs, prompt and observation rendering come from core's
 * planner protocol (D-030); this package only translates them into function tools and messages
 * and handles the loop's stop conditions (D-031).
 */
export {
  createOpenAiPlanner,
  type OpenAiPlannerOptions,
  toolDefinitions,
} from './planner.js';
export {
  isProviderId,
  PROVIDER_IDS,
  PROVIDERS,
  type ProviderId,
  type ProviderPreset,
  type ResolvedProvider,
  type ResolveProviderInput,
  resolveProvider,
} from './providers.js';
