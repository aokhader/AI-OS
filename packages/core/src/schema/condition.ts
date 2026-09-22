import { z } from 'zod';
import { CodeSchema, KebabIdSchema } from './common.js';
import { ConditionClassSchema, ConditionRoleSchema, FailureKindSchema } from './enums.js';
import { TargetSpecSchema } from './target.js';

/** A predicate over an observation. At least one clause must be present. */
export const PredicateSchema = z
  .strictObject({
    url: z.string().min(1).optional(),
    textPresent: z.array(z.string().min(1)).min(1).optional(),
    textAbsent: z.array(z.string().min(1)).min(1).optional(),
    element: TargetSpecSchema.optional(),
    dialog: z.boolean().optional(),
    frameTitle: z.string().min(1).optional(),
    /** For postconditions: how long to keep checking before the predicate is considered false. */
    timeoutMs: z.number().int().positive().optional(),
  })
  .superRefine((p, ctx) => {
    const tests =
      p.url !== undefined ||
      p.textPresent !== undefined ||
      p.textAbsent !== undefined ||
      p.element !== undefined ||
      p.dialog !== undefined ||
      p.frameTitle !== undefined;
    if (!tests) {
      ctx.addIssue({ code: 'custom', message: 'a predicate must test at least one thing' });
    }
  });
export type Predicate = z.infer<typeof PredicateSchema>;

export const RecoveryRoutineSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('dismiss'), target: TargetSpecSchema }),
  z.strictObject({
    kind: z.literal('wait-retry'),
    ms: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
  }),
  z.strictObject({ kind: z.literal('rebootstrap') }),
  z.strictObject({ kind: z.literal('assisted') }),
]);
export type RecoveryRoutine = z.infer<typeof RecoveryRoutineSchema>;

/**
 * One type in three roles (D-014): a step precondition, a step postcondition (the checkpoint),
 * or a detector with a class that says what replay does when it matches.
 */
export const ConditionSchema = z
  .strictObject({
    id: KebabIdSchema,
    when: PredicateSchema,
    role: ConditionRoleSchema,
    class: ConditionClassSchema.optional(),
    code: CodeSchema.optional(),
    message: z.string().optional(),
    recovery: RecoveryRoutineSchema.optional(),
    atSteps: z.array(KebabIdSchema).min(1).optional(),
    terminal: z.boolean().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.role === 'detector') {
      if (!c.class) {
        ctx.addIssue({ code: 'custom', message: 'a detector needs a class', path: ['class'] });
        return;
      }
      if ((c.class === 'outcome' || c.class === 'fail') && !c.code) {
        ctx.addIssue({
          code: 'custom',
          message: `a ${c.class} detector needs a code`,
          path: ['code'],
        });
      }
      if (c.class === 'fail' && c.code && !FailureKindSchema.safeParse(c.code).success) {
        ctx.addIssue({
          code: 'custom',
          message: 'a fail detector code must be a FailureKind',
          path: ['code'],
        });
      }
      if (c.class === 'recover' && !c.recovery) {
        ctx.addIssue({
          code: 'custom',
          message: 'a recover detector needs a recovery routine',
          path: ['recovery'],
        });
      }
      if (c.class !== 'recover' && c.recovery) {
        ctx.addIssue({
          code: 'custom',
          message: 'only recover detectors carry a recovery routine',
          path: ['recovery'],
        });
      }
    } else {
      for (const field of ['class', 'recovery', 'atSteps', 'terminal'] as const) {
        if (c[field] !== undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `only detectors carry ${field}`,
            path: [field],
          });
        }
      }
    }
  });
export type Condition = z.infer<typeof ConditionSchema>;

export function isRole<R extends Condition['role']>(
  role: R,
): (c: Condition) => c is Condition & { role: R } {
  return (c): c is Condition & { role: R } => c.role === role;
}
