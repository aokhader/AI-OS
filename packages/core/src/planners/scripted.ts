import { z } from 'zod';
import type { Planner, PlannerInfo, PlannerTurn, TranscriptEntry } from '../ports/planner.js';
import { describeTarget, resolveTarget } from '../resolve/resolve-target.js';
import { type Decision, TargetSpecSchema, ValueSchema } from '../schema/index.js';

/**
 * A planner that follows a script, with targets given as TargetSpecs so the same script works
 * whatever refs the page hands out. Used for LLM-free tests and the offline discovery demo.
 */
export const ScriptedStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('click'),
    intent: z.string().min(1),
    target: TargetSpecSchema,
  }),
  z.strictObject({
    kind: z.literal('type'),
    intent: z.string().min(1),
    target: TargetSpecSchema,
    value: ValueSchema,
  }),
  z.strictObject({
    kind: z.literal('select'),
    intent: z.string().min(1),
    target: TargetSpecSchema,
    value: ValueSchema,
  }),
  z.strictObject({ kind: z.literal('press'), intent: z.string().min(1), key: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('navigate'),
    intent: z.string().min(1),
    url: ValueSchema,
  }),
  z.strictObject({
    kind: z.literal('finish'),
    summary: z.string().min(1),
    outputs: z.record(z.string().min(1), TargetSpecSchema),
  }),
  z.strictObject({ kind: z.literal('give_up'), reason: z.string().min(1) }),
  z.strictObject({ kind: z.literal('request_human'), reason: z.string().min(1) }),
]);
export type ScriptedStep = z.infer<typeof ScriptedStepSchema>;

export const ScriptSchema = z.array(ScriptedStepSchema).min(1);

export function createScriptedPlanner(
  script: ScriptedStep[],
  info: PlannerInfo = { provider: 'scripted', model: 'scripted' },
): Planner {
  const entries: TranscriptEntry[] = [];
  return {
    info: () => info,
    transcript: () => entries,
    async decide(turn: PlannerTurn): Promise<Decision> {
      const step = script[turn.turn - 1];
      const decision = step ? toDecision(step, turn) : giveUp('script exhausted');
      entries.push({
        turn: turn.turn,
        at: new Date().toISOString(),
        request: { goal: turn.goal, nodes: turn.observation.nodes.length },
        response: decision,
      });
      return decision;
    },
  };
}

function giveUp(reason: string): Decision {
  return { kind: 'give_up', reason };
}

function refFor(turn: PlannerTurn, target: z.infer<typeof TargetSpecSchema>): string | undefined {
  const r = resolveTarget(turn.observation.nodes, target);
  return r.found ? r.ref : undefined;
}

function toDecision(step: ScriptedStep, turn: PlannerTurn): Decision {
  switch (step.kind) {
    case 'click':
    case 'type':
    case 'select': {
      const ref = refFor(turn, step.target);
      if (!ref) return giveUp(`scripted target not found: ${describeTarget(step.target)}`);
      const action =
        step.kind === 'click'
          ? { kind: 'click' as const, target: { ref } }
          : step.kind === 'type'
            ? { kind: 'type' as const, target: { ref }, value: step.value, clear: true }
            : { kind: 'select' as const, target: { ref }, value: step.value };
      return { kind: 'tool', action, intent: step.intent };
    }
    case 'press':
      return { kind: 'tool', action: { kind: 'press', key: step.key }, intent: step.intent };
    case 'navigate':
      return { kind: 'tool', action: { kind: 'navigate', url: step.url }, intent: step.intent };
    case 'finish': {
      const outputs: Record<string, { ref: string }> = {};
      for (const [name, target] of Object.entries(step.outputs)) {
        const ref = refFor(turn, target);
        if (!ref) return giveUp(`scripted output ${name} not found: ${describeTarget(target)}`);
        outputs[name] = { ref };
      }
      return { kind: 'finish', outputs, summary: step.summary };
    }
    case 'give_up':
      return giveUp(step.reason);
    case 'request_human':
      return { kind: 'request_human', reason: step.reason };
  }
}
