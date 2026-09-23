/**
 * @handsoff/llm-anthropic
 *
 * Implements the `Planner` port from @handsoff/core over the Anthropic Messages API. The tool
 * specs, prompt and observation rendering come from core's planner protocol (D-030); this package
 * adds strict tool definitions, adaptive thinking, prompt caching, server-side fallbacks and a
 * hand-written tool-use loop with explicit stop-reason handling (D-022).
 * See docs/context/02-tech-stack-and-data-model.md, LLM integration.
 */
export { type AnthropicPlannerOptions, createAnthropicPlanner, type Effort } from './planner.js';
export { toolDefinitions } from './tools.js';
