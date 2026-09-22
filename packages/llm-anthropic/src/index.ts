/**
 * @handsoff/llm-anthropic
 *
 * Implements the `Planner` and `RecoveryPlanner` ports from @handsoff/core over the Anthropic SDK:
 * strict tool schemas generated from the core zod schemas, `{ param }` values so sensitive inputs
 * never enter the transcript, a hand-written tool-use loop with explicit stop_reason handling.
 *
 * Built in phase P2. See docs/context/02-tech-stack-and-data-model.md, LLM integration.
 */
export const DEFAULT_MODEL = 'claude-opus-5';
