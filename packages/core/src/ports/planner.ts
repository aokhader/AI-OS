import type { Action, Decision, Sensitivity, Step } from '../schema/index.js';
import type { SurfaceObservation } from './surface.js';

/** A parameter as the planner sees it: never its value (D-013). */
export interface PlannerParam {
  name: string;
  type: string;
  description: string;
  sensitivity: Sensitivity;
}

export interface PlannerTurn {
  /** 1-based. */
  turn: number;
  goal: string;
  params: PlannerParam[];
  /** Names and values already redacted; the screenshot may still be present. */
  observation: SurfaceObservation;
  /** What happened to the previous decision, so the model can react. */
  lastAction?:
    | { decision: Decision; status: 'ok' | 'blocked' | 'failed' | 'invalid'; detail: string }
    | undefined;
  stepsRemaining: number;
}

export interface PlannerInfo {
  /** Which adapter and endpoint served the run, e.g. `anthropic`, `google`, `scripted`. */
  provider?: string | undefined;
  model: string;
  effort?: string | undefined;
}

/** One exchange with the model, already redacted and serialisable. Persisted as evidence. */
export interface TranscriptEntry {
  turn: number;
  at: string;
  request: unknown;
  response: unknown;
}

/**
 * The only place a model decides anything. Used by discovery; replay never holds one.
 * Implementations: `@handsoff/llm-anthropic`, `@handsoff/llm-openai` (any OpenAI-compatible
 * endpoint) and the core `ScriptedPlanner` for tests and offline demos. They all speak the planner
 * protocol in `planners/protocol.ts` (D-030).
 */
export interface Planner {
  info(): PlannerInfo;
  decide(turn: PlannerTurn): Promise<Decision>;
  transcript(): TranscriptEntry[];
}

export interface RecoveryContext {
  observation: SurfaceObservation;
  step: Step;
  expected: string;
  observed: string;
}

/** Assisted fallback (§15): at most one proposed action for a failed replay step. */
export interface RecoveryPlanner {
  info(): PlannerInfo;
  proposeOne(context: RecoveryContext): Promise<Action | null>;
}
