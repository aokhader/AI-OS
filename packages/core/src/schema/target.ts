import { z } from 'zod';

/**
 * How a step finds the control it acts on. Ordered by robustness; replay walks the list and
 * requires exactly one visible match. See docs/context/01-architecture.md §8 and D-016.
 */
export const StrategySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('role'),
    role: z.string().min(1),
    name: z.string().min(1),
    exact: z.boolean().optional(),
  }),
  z
    .strictObject({
      kind: z.literal('anchored'),
      anchor: z.string().min(1),
      relation: z.enum(['labels', 'same-row-column', 'right-of', 'below']),
      column: z.string().min(1).optional(),
      role: z.string().min(1).optional(),
    })
    .superRefine((s, ctx) => {
      if (s.relation === 'same-row-column' && !s.column) {
        ctx.addIssue({
          code: 'custom',
          message: 'same-row-column needs a column header',
          path: ['column'],
        });
      }
    }),
  z.strictObject({
    kind: z.literal('structural'),
    path: z.string().min(1),
  }),
]);
export type Strategy = z.infer<typeof StrategySchema>;

export const TargetSpecSchema = z.strictObject({
  strategies: z.array(StrategySchema).min(1).max(3),
  /** [] for the top document; ["main"] for the frame named main; nested frames in order. */
  framePath: z.array(z.string().min(1)),
});
export type TargetSpec = z.infer<typeof TargetSpecSchema>;

export const BaselineSchema = z.strictObject({
  resolvedBy: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
});
export type Baseline = z.infer<typeof BaselineSchema>;
