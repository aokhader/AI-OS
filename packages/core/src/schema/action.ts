import { z } from 'zod';
import { ParamNameSchema } from './common.js';
import { TargetSpecSchema } from './target.js';

/**
 * A literal or a reference to a parameter by name. The surface substitutes the value at act
 * time, so bindings are recorded by provenance and sensitive values never enter a transcript
 * (D-013).
 */
export const ValueSchema = z.union([
  z.strictObject({ text: z.string() }),
  z.strictObject({ param: ParamNameSchema }),
]);
export type Value = z.infer<typeof ValueSchema>;

/** A live ref during discovery; a compiled TargetSpec inside an artifact. */
export const TargetRefSchema = z.union([
  z.strictObject({ ref: z.string().min(1) }),
  z.strictObject({ spec: TargetSpecSchema }),
]);
export type TargetRef = z.infer<typeof TargetRefSchema>;

export const ActionKindSchema = z.enum([
  'click',
  'type',
  'select',
  'press',
  'navigate',
  'wait',
  'extract',
]);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const ActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('click'), target: TargetRefSchema }),
  z.strictObject({
    kind: z.literal('type'),
    target: TargetRefSchema,
    value: ValueSchema,
    clear: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal('select'), target: TargetRefSchema, value: ValueSchema }),
  z.strictObject({ kind: z.literal('press'), key: z.string().min(1) }),
  z.strictObject({ kind: z.literal('navigate'), url: ValueSchema }),
  z.strictObject({
    kind: z.literal('wait'),
    reason: z.string().min(1),
    ms: z.number().int().positive().optional(),
  }),
  z.strictObject({
    kind: z.literal('extract'),
    name: ParamNameSchema,
    target: TargetRefSchema,
  }),
]);
export type Action = z.infer<typeof ActionSchema>;

/** Action kinds that operate on a target element. */
export const TARGETED_ACTION_KINDS = ['click', 'type', 'select', 'extract'] as const;

/** The target reference of an action, if it has one. */
export function actionTarget(action: Action): TargetRef | undefined {
  switch (action.kind) {
    case 'click':
    case 'type':
    case 'select':
    case 'extract':
      return action.target;
    default:
      return undefined;
  }
}

/** Parameters an action references, with the binding field each one occupies. */
export function actionParams(
  action: Action,
): Array<{ param: string; field: 'value' | 'navigate.url' }> {
  switch (action.kind) {
    case 'type':
    case 'select':
      return 'param' in action.value ? [{ param: action.value.param, field: 'value' }] : [];
    case 'navigate':
      return 'param' in action.url ? [{ param: action.url.param, field: 'navigate.url' }] : [];
    default:
      return [];
  }
}

/** What the planner returns each turn. */
export const DecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('tool'), action: ActionSchema, intent: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('finish'),
    outputs: z.record(
      ParamNameSchema,
      z.union([ValueSchema, z.strictObject({ ref: z.string().min(1) })]),
    ),
    summary: z.string(),
  }),
  z.strictObject({ kind: z.literal('give_up'), reason: z.string().min(1) }),
  z.strictObject({ kind: z.literal('request_human'), reason: z.string().min(1) }),
]);
export type Decision = z.infer<typeof DecisionSchema>;
