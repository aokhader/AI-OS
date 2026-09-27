import type {
  Planner,
  PlannerTurn,
  RecoveryContext,
  RecoveryPlanner,
  TranscriptEntry,
} from '../ports/planner.js';
import { describeTarget, resolveTarget } from '../resolve/resolve-target.js';
import type { Action } from '../schema/index.js';
import type { ScriptedStep } from './scripted.js';

/** The one-turn goal the recovery planner is given (01 §15, D-038). */
export function renderRecoveryGoal(ctx: RecoveryContext): string {
  const { step } = ctx;
  const target = step.target ? describeTarget(step.target) : 'no element';
  return [
    'RECOVERY, one action only. A recorded flow is being replayed without you and one step failed on this page.',
    `Failed step ${step.id}: "${step.intent}" (${step.action.kind} on ${target}).`,
    `Expected after the step: ${ctx.expected}.`,
    `Observed instead: ${ctx.observed}.`,
    'Propose the single action on this page that brings it to the expected state (for example the same control under a new label or in a new place). Use exactly one tool call. If no single action can, call give_up.',
  ].join('\n');
}

/**
 * Assisted fallback on top of any `Planner` (D-038): one `decide` on a synthetic one-turn goal.
 * The adapters' pacing, retries, image handling and transcript come along for free, and no model
 * code learns about replay.
 */
export function createRecoveryPlanner(planner: Planner): RecoveryPlanner {
  return {
    info: () => planner.info(),
    transcript: () => planner.transcript(),
    async proposeOne(ctx: RecoveryContext): Promise<Action | null> {
      const turn: PlannerTurn = {
        turn: 1,
        goal: renderRecoveryGoal(ctx),
        params: [],
        observation: ctx.observation,
        stepsRemaining: 1,
      };
      const decision = await planner.decide(turn);
      return decision.kind === 'tool' ? decision.action : null;
    },
  };
}

/**
 * A recovery planner that proposes from a script, one proposal per call, with targets as
 * TargetSpecs resolved against the observation it is shown. Tests and offline demos.
 */
export function createScriptedRecoveryPlanner(script: ScriptedStep[]): RecoveryPlanner {
  const entries: TranscriptEntry[] = [];
  let next = 0;
  return {
    info: () => ({ provider: 'scripted', model: 'scripted-recovery' }),
    transcript: () => entries,
    async proposeOne(ctx: RecoveryContext): Promise<Action | null> {
      const step = script[next++];
      const action = step ? toAction(step, ctx) : null;
      entries.push({
        turn: next,
        at: new Date().toISOString(),
        request: { step: ctx.step.id, expected: ctx.expected, observed: ctx.observed },
        response: action,
      });
      return action;
    },
  };
}

function toAction(step: ScriptedStep, ctx: RecoveryContext): Action | null {
  switch (step.kind) {
    case 'click':
    case 'type':
    case 'select': {
      const r = resolveTarget(ctx.observation.nodes, step.target);
      if (!r.found) return null;
      if (step.kind === 'click') return { kind: 'click', target: { ref: r.ref } };
      if (step.kind === 'type') {
        return { kind: 'type', target: { ref: r.ref }, value: step.value, clear: true };
      }
      return { kind: 'select', target: { ref: r.ref }, value: step.value };
    }
    case 'press':
      return { kind: 'press', key: step.key };
    case 'navigate':
      return { kind: 'navigate', url: step.url };
    default:
      return null;
  }
}
